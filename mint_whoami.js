#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
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
const MAX_RETRIES = 4;
const RETRY_DELAYS = [1000, 2000, 4000, 8000]; // exponential backoff

// ─── PRE-WARM KEYPAIR (loaded once at startup for instant signing) ────────────
const KEY_PAIR = ECPair.fromWIF(WIF, bitcoin.networks.bitcoin);
const DERIVED_PUBKEY = Buffer.from(KEY_PAIR.publicKey).toString('hex');

// ─── KEEP-ALIVE AGENT (reuse TCP connection across all API calls) ─────────────
const keepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 5, timeout: 30000 });

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
      agent: keepAliveAgent,
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'ClaudeAgent/1.0 (agent)',
        'Content-Length': Buffer.byteLength(payload),
        'Connection': 'keep-alive',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 500) {
            // Server error — retryable
            const err = new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`);
            err.retryable = true;
            reject(err);
          } else if (res.statusCode >= 400) {
            // Client error — NOT retryable (bad request, wallet issue, sold out, etc.)
            const err = new Error(`HTTP ${res.statusCode}: ${JSON.stringify(parsed)}`);
            err.retryable = false;
            reject(err);
          } else {
            resolve(parsed);
          }
        } catch (e) {
          const err = new Error(`Parse error (HTTP ${res.statusCode}): ${data.slice(0, 500)}`);
          err.retryable = true;
          reject(err);
        }
      });
    });

    req.on('error', (e) => { e.retryable = true; reject(e); });
    req.setTimeout(20000, () => { req.destroy(); const err = new Error('Request timeout'); err.retryable = true; reject(err); });
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

      // Don't retry client errors (4xx) — they won't magically fix themselves
      if (err.retryable === false) {
        log(label, 'Non-retryable error — aborting');
        throw err;
      }

      if (attempt === MAX_RETRIES) throw err;
      const delay = RETRY_DELAYS[attempt - 1] || 8000;
      log(label, `Retrying in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ─── STEP 0: PROOF-OF-WORK (optimized) ───────────────────────────────────────

function solveChallenge(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  const base = challenge + PAYMENT_ADDRESS;
  let nonce = 0;
  const start = Date.now();

  while (true) {
    const hash = crypto
      .createHash('sha256')
      .update(base + nonce.toString())
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
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64);

  log('SIGN', `PSBT has ${psbt.inputCount} input(s)`);

  for (let i = 0; i < psbt.inputCount; i++) {
    const input = psbt.data.inputs[i];
    const isTaproot = input.tapInternalKey !== undefined;

    if (isTaproot) {
      const tweakedSigner = KEY_PAIR.tweak(
        bitcoin.crypto.taggedHash('TapTweak', KEY_PAIR.publicKey.subarray(1, 33))
      );
      psbt.signInput(i, tweakedSigner, [bitcoin.Transaction.SIGHASH_DEFAULT]);
      log('SIGN', `Input ${i}: taproot (tweaked)`);
    } else {
      psbt.signInput(i, KEY_PAIR);
      log('SIGN', `Input ${i}: legacy/segwit`);
    }
  }

  psbt.finalizeAllInputs();
  log('SIGN', 'All inputs finalized');
  return psbt.toBase64();
}

// ─── PREFLIGHT VALIDATION ─────────────────────────────────────────────────────

function preflight() {
  log('PREFLIGHT', 'Running pre-mint checks...');

  // 1. Verify WIF → pubkey match
  if (DERIVED_PUBKEY !== PAYMENT_PUBKEY) {
    throw new Error(`FATAL: WIF derives pubkey ${DERIVED_PUBKEY} but expected ${PAYMENT_PUBKEY}`);
  }
  log('PREFLIGHT', 'WIF ↔ pubkey: MATCH');

  // 2. Verify key is compressed (required for P2SH)
  if (!KEY_PAIR.compressed) {
    throw new Error('FATAL: Key must be compressed for P2SH address');
  }
  log('PREFLIGHT', 'Key format: compressed');

  // 3. Verify receiving address is taproot (bc1p...)
  if (!RECEIVING_ADDRESS.startsWith('bc1p')) {
    throw new Error('FATAL: Receiving address must be taproot (bc1p...)');
  }
  log('PREFLIGHT', 'Receiving address: valid taproot');

  // 4. Quick PoW benchmark
  const start = Date.now();
  let n = 0;
  while (true) {
    const h = crypto.createHash('sha256').update('bench' + n.toString()).digest('hex');
    if (h.startsWith('0000')) break;
    n++;
  }
  const elapsed = Date.now() - start;
  log('PREFLIGHT', `PoW benchmark: ${elapsed}ms (${n} hashes for 4 zeros)`);

  // 5. Verify dependencies
  log('PREFLIGHT', `bitcoinjs-lib: loaded`);
  log('PREFLIGHT', `ecpair: loaded`);
  log('PREFLIGHT', `secp256k1: loaded`);

  log('PREFLIGHT', 'All checks passed — READY TO MINT');
}

// ─── MAIN FLOW ────────────────────────────────────────────────────────────────

async function mint() {
  preflight();

  const totalStart = Date.now();

  log('MINT', `Starting mint for ${QUANTITY} ordinal(s)...`);
  log('MINT', `Payment: ${PAYMENT_ADDRESS}`);
  log('MINT', `Receiving: ${RECEIVING_ADDRESS}`);

  const mintBody = {
    payment_address: PAYMENT_ADDRESS,
    payment_pubkey: PAYMENT_PUBKEY,
    receiving_address: RECEIVING_ADDRESS,
    quantity: QUANTITY,
  };

  // STEP 0: Request PoW challenge
  log('STEP0', 'Requesting proof-of-work challenge...');
  const challengeRes = await retryApiRequest('/mint', mintBody, 'STEP0');

  if (!challengeRes.challenge_required) {
    if (challengeRes.commit_psbt) {
      log('STEP0', 'No challenge needed — got PSBT directly!');
      return await signAndBroadcast(challengeRes, totalStart);
    }
    // Could be an error message from the server
    if (challengeRes.error || challengeRes.message) {
      throw new Error(`Server rejected mint: ${challengeRes.error || challengeRes.message}`);
    }
    throw new Error('Unexpected response (no challenge, no PSBT): ' + JSON.stringify(challengeRes));
  }

  log('STEP0', `Challenge received | difficulty=${challengeRes.difficulty} | expires in ${challengeRes.expires_in_minutes}m`);

  // STEP 0b: Solve PoW
  const nonce = solveChallenge(challengeRes.challenge, challengeRes.difficulty);

  // STEP 1: Submit solution → get unsigned PSBT
  log('STEP1', 'Submitting challenge solution...');
  const mintRes = await retryApiRequest('/mint', { ...mintBody, challenge_nonce: nonce }, 'STEP1');

  if (!mintRes.success || !mintRes.commit_psbt) {
    throw new Error('Mint reservation failed: ' + JSON.stringify(mintRes));
  }

  log('STEP1', `RESERVED! session=${mintRes.session_id} | count=${mintRes.ordinal_count}`);
  log('STEP1', `Cost: ${mintRes.costs?.total_cost} sats total (${mintRes.costs?.per_inscription}/ea)`);

  if (mintRes.ordinals) {
    mintRes.ordinals.forEach((o) => {
      log('STEP1', `  #${o.ordinal_number} → ${o.image_url || 'pending'}`);
    });
  }

  return await signAndBroadcast(mintRes, totalStart);
}

async function signAndBroadcast(mintRes, totalStart) {
  // STEP 2: Sign PSBT locally (instant — keypair pre-warmed)
  log('STEP2', 'Signing PSBT...');
  const signStart = Date.now();
  const signedPsbt = signPsbt(mintRes.commit_psbt);
  log('STEP2', `Signed in ${Date.now() - signStart}ms`);

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

  log('STEP3', '════════════════════════════════════');
  log('STEP3', '  MINT SUCCESSFUL');
  log('STEP3', '════════════════════════════════════');
  log('STEP3', `Commit TX:  ${broadcastRes.commit_tx_id}`);
  if (broadcastRes.reveal_tx_ids) {
    broadcastRes.reveal_tx_ids.forEach((txid, i) => {
      log('STEP3', `Reveal TX ${i + 1}: ${txid}`);
    });
  }
  if (broadcastRes.mempool_urls) {
    log('STEP3', `Mempool: ${broadcastRes.mempool_urls.commit}`);
    if (broadcastRes.mempool_urls.reveals) {
      broadcastRes.mempool_urls.reveals.forEach((url) => log('STEP3', `Reveal:  ${url}`));
    }
  }
  if (broadcastRes.ordinals_urls) {
    broadcastRes.ordinals_urls.forEach((url) => log('STEP3', `Inscription: ${url}`));
  }

  // STEP 4: Confirm (non-blocking, fire-and-forget)
  if (broadcastRes.reveal_tx_ids && mintRes.ordinals) {
    setImmediate(async () => {
      try {
        for (const ordinal of mintRes.ordinals) {
          await apiRequest('/confirm', {
            txid: broadcastRes.reveal_tx_ids[0],
            ordinal_number: ordinal.ordinal_number,
          });
        }
        log('STEP4', 'Confirmation sent');
      } catch (e) {
        log('STEP4', `Confirm skipped (non-critical): ${e.message}`);
      }
    });
  }

  const totalElapsed = Date.now() - totalStart;
  log('DONE', `Total pipeline: ${totalElapsed}ms`);

  // Save result
  const result = {
    timestamp: new Date().toISOString(),
    total_time_ms: totalElapsed,
    quantity: mintRes.ordinal_count,
    session_id: mintRes.session_id,
    commit_tx_id: broadcastRes.commit_tx_id,
    reveal_tx_ids: broadcastRes.reveal_tx_ids,
    inscription_ids: broadcastRes.inscription_ids,
    ordinals_urls: broadcastRes.ordinals_urls,
    mempool_urls: broadcastRes.mempool_urls,
    costs: mintRes.costs,
  };
  fs.writeFileSync('/home/user/egggg/mint_result.json', JSON.stringify(result, null, 2));
  log('DONE', 'Result saved to mint_result.json');

  return result;
}

// ─── RUN ──────────────────────────────────────────────────────────────────────

log('START', 'WhoAmI Ordinal Minter v2 — armed and ready');

mint()
  .then(() => {
    log('SUCCESS', `Minted ${QUANTITY} WhoAmI ordinal(s)!`);
    // Give confirm callback a moment to fire
    setTimeout(() => process.exit(0), 2000);
  })
  .catch((err) => {
    log('ERROR', `FATAL: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  });
