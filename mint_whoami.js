#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const https = require('https');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const COLLECTION_ID = '812eed4e-c7bb-436a-b4d3-a43342c6ef37';
const BASE_URL = 'ordmaker.fun';

const WIF = 'L58RVADXJAgoMeYZ1DyNSWt62hRqT1qRHBRptTzVPHHCc8wozYvY';

const PAYMENT_ADDRESS = '36cuzNZHrfPNBP6crJQpvnjdkm6k4Dgm7N';
const PAYMENT_PUBKEY = '03d288f20f7d3b35f16f67a693798ef5607d291f54cd344d724c5630f09df8d26c';
const RECEIVING_ADDRESS = 'bc1pxvyf4sh50t30tamqn4kwknzkz3uj6q0l98gvnsp2k9xyzhgl0cfq6genqh';

const QUANTITY = 3; // max per wallet in this phase
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function log(step, msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${step}] ${msg}`);
}

function apiRequest(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: BASE_URL,
      port: 443,
      path: `/api/agent/collections/${COLLECTION_ID}${path}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ClaudeAgent/1.0 (agent)',
        'Content-Length': Buffer.byteLength(payload),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error(`Parse error (HTTP ${res.statusCode}): ${data.slice(0, 500)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

async function retryApiRequest(path, body, label) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await apiRequest(path, body);
    } catch (err) {
      log(label, `Attempt ${attempt}/${MAX_RETRIES} failed: ${err.message}`);
      if (attempt === MAX_RETRIES) throw err;
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      log(label, `Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── STEP 0: PROOF-OF-WORK ───────────────────────────────────────────────────

function solveChallenge(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  let nonce = 0;
  const start = Date.now();

  while (true) {
    const hash = crypto
      .createHash('sha256')
      .update(challenge + PAYMENT_ADDRESS + nonce.toString())
      .digest('hex');

    if (hash.startsWith(prefix)) {
      const elapsed = Date.now() - start;
      log('POW', `Solved in ${elapsed}ms | nonce=${nonce} | hash=${hash}`);
      return nonce.toString();
    }
    nonce++;
  }
}

// ─── STEP 2: SIGN PSBT ───────────────────────────────────────────────────────

function signPsbt(psbtBase64) {
  const keyPair = ECPair.fromWIF(WIF, bitcoin.networks.bitcoin);
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64);

  log('SIGN', `PSBT has ${psbt.inputCount} input(s)`);

  for (let i = 0; i < psbt.inputCount; i++) {
    const input = psbt.data.inputs[i];
    const isTaproot = input.tapInternalKey !== undefined;

    if (isTaproot) {
      const tweakedSigner = keyPair.tweak(
        bitcoin.crypto.taggedHash('TapTweak', keyPair.publicKey.subarray(1, 33))
      );
      psbt.signInput(i, tweakedSigner, [bitcoin.Transaction.SIGHASH_DEFAULT]);
      log('SIGN', `Input ${i}: signed as taproot (tweaked)`);
    } else {
      psbt.signInput(i, keyPair);
      log('SIGN', `Input ${i}: signed as legacy/segwit`);
    }
  }

  psbt.finalizeAllInputs();
  log('SIGN', 'All inputs finalized');
  return psbt.toBase64();
}

// ─── MAIN FLOW ────────────────────────────────────────────────────────────────

async function mint() {
  const totalStart = Date.now();

  // STEP 0: Request challenge
  log('MINT', `Starting mint for ${QUANTITY} ordinal(s)...`);
  log('MINT', `Payment: ${PAYMENT_ADDRESS}`);
  log('MINT', `Receiving: ${RECEIVING_ADDRESS}`);

  const mintBody = {
    payment_address: PAYMENT_ADDRESS,
    payment_pubkey: PAYMENT_PUBKEY,
    receiving_address: RECEIVING_ADDRESS,
    quantity: QUANTITY,
  };

  log('STEP0', 'Requesting proof-of-work challenge...');
  const challengeRes = await retryApiRequest('/mint', mintBody, 'STEP0');

  if (!challengeRes.challenge_required) {
    // Unexpected: maybe challenge not required, check if we got PSBT directly
    if (challengeRes.commit_psbt) {
      log('STEP0', 'No challenge needed — got PSBT directly');
      return await signAndBroadcast(challengeRes);
    }
    throw new Error('Unexpected response (no challenge, no PSBT): ' + JSON.stringify(challengeRes));
  }

  log('STEP0', `Challenge received | difficulty=${challengeRes.difficulty} | expires in ${challengeRes.expires_in_minutes}m`);

  // STEP 0b: Solve PoW
  const nonce = solveChallenge(challengeRes.challenge, challengeRes.difficulty);

  // STEP 1: Submit solution and get unsigned PSBT
  log('STEP1', 'Submitting challenge solution...');
  const mintRes = await retryApiRequest('/mint', { ...mintBody, challenge_nonce: nonce }, 'STEP1');

  if (!mintRes.success || !mintRes.commit_psbt) {
    throw new Error('Mint request failed: ' + JSON.stringify(mintRes));
  }

  log('STEP1', `Reservation success! session=${mintRes.session_id} | ordinals=${mintRes.ordinal_count}`);
  log('STEP1', `Cost: ${mintRes.costs?.total_cost} sats total (${mintRes.costs?.per_inscription} per inscription)`);

  if (mintRes.ordinals) {
    mintRes.ordinals.forEach((o, i) => {
      log('STEP1', `  Ordinal #${o.ordinal_number} → ${o.image_url || 'no preview'}`);
    });
  }

  return await signAndBroadcast(mintRes);
}

async function signAndBroadcast(mintRes) {
  // STEP 2: Sign PSBT locally
  log('STEP2', 'Signing PSBT locally...');
  const signedPsbt = signPsbt(mintRes.commit_psbt);
  log('STEP2', 'PSBT signed successfully');

  // STEP 3: Broadcast
  log('STEP3', 'Broadcasting signed transaction...');
  const broadcastRes = await retryApiRequest(
    '/broadcast',
    {
      session_id: mintRes.session_id,
      signed_psbt_base64: signedPsbt,
    },
    'STEP3'
  );

  if (!broadcastRes.success) {
    throw new Error('Broadcast failed: ' + JSON.stringify(broadcastRes));
  }

  log('STEP3', '=== MINT SUCCESSFUL ===');
  log('STEP3', `Commit TX: ${broadcastRes.commit_tx_id}`);
  if (broadcastRes.reveal_tx_ids) {
    broadcastRes.reveal_tx_ids.forEach((txid, i) => {
      log('STEP3', `Reveal TX ${i + 1}: ${txid}`);
    });
  }
  if (broadcastRes.mempool_urls) {
    log('STEP3', `Mempool (commit): ${broadcastRes.mempool_urls.commit}`);
  }
  if (broadcastRes.ordinals_urls) {
    broadcastRes.ordinals_urls.forEach((url) => log('STEP3', `Ordinal: ${url}`));
  }

  // STEP 4: Confirm (optional, fire-and-forget)
  if (broadcastRes.reveal_tx_ids && mintRes.ordinals) {
    try {
      for (const ordinal of mintRes.ordinals) {
        await apiRequest('/confirm', {
          txid: broadcastRes.reveal_tx_ids[0],
          ordinal_number: ordinal.ordinal_number,
        });
      }
      log('STEP4', 'Confirmation sent');
    } catch (e) {
      log('STEP4', `Confirm failed (non-critical): ${e.message}`);
    }
  }

  const totalElapsed = Date.now() - (global.__mintStart || Date.now());
  log('DONE', `Total time: ${totalElapsed}ms`);

  // Save result to file
  const fs = require('fs');
  const result = {
    timestamp: new Date().toISOString(),
    session_id: mintRes.session_id,
    commit_tx_id: broadcastRes.commit_tx_id,
    reveal_tx_ids: broadcastRes.reveal_tx_ids,
    inscription_ids: broadcastRes.inscription_ids,
    ordinals_urls: broadcastRes.ordinals_urls,
    mempool_urls: broadcastRes.mempool_urls,
  };
  fs.writeFileSync('/home/user/egggg/mint_result.json', JSON.stringify(result, null, 2));
  log('DONE', 'Result saved to mint_result.json');

  return result;
}

// ─── RUN ──────────────────────────────────────────────────────────────────────

global.__mintStart = Date.now();
log('START', 'WhoAmI Ordinal Minter — ready');

mint()
  .then((result) => {
    log('SUCCESS', `Minted ${QUANTITY} ordinal(s)! Check mint_result.json for details.`);
    process.exit(0);
  })
  .catch((err) => {
    log('ERROR', `Fatal: ${err.message}`);
    console.error(err);
    process.exit(1);
  });
