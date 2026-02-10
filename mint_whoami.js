#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { execSync } = require('child_process');
const fs = require('fs');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const COLLECTION_ID = '812eed4e-c7bb-436a-b4d3-a43342c6ef37';
const API_BASE = `https://ordmaker.fun/api/agent/collections/${COLLECTION_ID}`;

const WIF = 'L58RVADXJAgoMeYZ1DyNSWt62hRqT1qRHBRptTzVPHHCc8wozYvY';
const PAYMENT_ADDRESS = '36cuzNZHrfPNBP6crJQpvnjdkm6k4Dgm7N';
const PAYMENT_PUBKEY = '03d288f20f7d3b35f16f67a693798ef5607d291f54cd344d724c5630f09df8d26c';
const RECEIVING_ADDRESS = 'bc1pxvyf4sh50t30tamqn4kwknzkz3uj6q0l98gvnsp2k9xyzhgl0cfq6genqh';
const QUANTITY = 1;

// Pre-warm keypair
const KEY_PAIR = ECPair.fromWIF(WIF, bitcoin.networks.bitcoin);

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function log(step, msg) {
  console.log(`[${new Date().toISOString()}] [${step}] ${msg}`);
}

function curlPost(endpoint, body) {
  const payload = JSON.stringify(body);
  const escaped = payload.replace(/'/g, "'\\''");
  const cmd = `curl -s --max-time 20 -X POST "${API_BASE}${endpoint}" -H "Content-Type: application/json" -H "User-Agent: ClaudeAgent/1.0 (agent)" -d '${escaped}'`;
  const result = execSync(cmd, { encoding: 'utf8', timeout: 25000 });
  return JSON.parse(result);
}

function solvePoW(challenge, difficulty) {
  const prefix = '0'.repeat(difficulty);
  const base = challenge + PAYMENT_ADDRESS;
  let nonce = 0;
  const start = Date.now();
  while (true) {
    const hash = crypto.createHash('sha256').update(base + nonce.toString()).digest('hex');
    if (hash.startsWith(prefix)) {
      log('POW', `Solved in ${Date.now() - start}ms | nonce=${nonce} | hash=${hash}`);
      return nonce.toString();
    }
    nonce++;
  }
}

function signPsbt(psbtBase64) {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
  log('SIGN', `PSBT has ${psbt.inputCount} input(s)`);

  for (let i = 0; i < psbt.inputCount; i++) {
    const input = psbt.data.inputs[i];
    if (input.tapInternalKey !== undefined) {
      const tweaked = KEY_PAIR.tweak(
        bitcoin.crypto.taggedHash('TapTweak', KEY_PAIR.publicKey.subarray(1, 33))
      );
      psbt.signInput(i, tweaked, [bitcoin.Transaction.SIGHASH_DEFAULT]);
      log('SIGN', `Input ${i}: taproot`);
    } else {
      psbt.signInput(i, KEY_PAIR);
      log('SIGN', `Input ${i}: segwit/legacy`);
    }
  }

  psbt.finalizeAllInputs();
  return psbt.toBase64();
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

function main() {
  const totalStart = Date.now();

  // Preflight
  const derivedPub = Buffer.from(KEY_PAIR.publicKey).toString('hex');
  if (derivedPub !== PAYMENT_PUBKEY) throw new Error('WIF/pubkey mismatch!');
  log('READY', `Wallet verified | Quantity: ${QUANTITY}`);

  const mintBody = {
    payment_address: PAYMENT_ADDRESS,
    payment_pubkey: PAYMENT_PUBKEY,
    receiving_address: RECEIVING_ADDRESS,
    quantity: QUANTITY,
  };

  // STEP 0: Get challenge
  log('STEP0', 'Requesting challenge...');
  const challengeRes = curlPost('/mint', mintBody);

  if (challengeRes.error) {
    throw new Error(`Challenge error: ${challengeRes.error}`);
  }

  if (!challengeRes.challenge_required) {
    if (challengeRes.commit_psbt) {
      log('STEP0', 'No challenge needed — got PSBT directly');
      return signAndBroadcast(challengeRes, totalStart);
    }
    throw new Error('Unexpected: ' + JSON.stringify(challengeRes));
  }

  log('STEP0', `Challenge: ${challengeRes.challenge.slice(0, 16)}... | difficulty=${challengeRes.difficulty}`);

  // STEP 0b: Solve PoW (immediate, in-process)
  const nonce = solvePoW(challengeRes.challenge, challengeRes.difficulty);

  // STEP 1: Submit solution (immediately after solving)
  log('STEP1', 'Submitting solution...');
  const mintRes = curlPost('/mint', { ...mintBody, challenge_nonce: nonce });

  if (mintRes.error) {
    throw new Error(`Mint error: ${mintRes.error} — ${mintRes.details || ''}`);
  }

  if (!mintRes.commit_psbt) {
    throw new Error('No PSBT in response: ' + JSON.stringify(mintRes));
  }

  log('STEP1', `RESERVED! session=${mintRes.session_id} | count=${mintRes.ordinal_count}`);
  if (mintRes.costs) log('STEP1', `Cost: ${mintRes.costs.total_cost} sats`);
  if (mintRes.ordinals) {
    mintRes.ordinals.forEach(o => log('STEP1', `  #${o.ordinal_number}`));
  }

  return signAndBroadcast(mintRes, totalStart);
}

function signAndBroadcast(mintRes, totalStart) {
  // STEP 2: Sign
  log('STEP2', 'Signing PSBT...');
  const signStart = Date.now();
  const signedPsbt = signPsbt(mintRes.commit_psbt);
  log('STEP2', `Signed in ${Date.now() - signStart}ms`);

  // STEP 3: Broadcast
  log('STEP3', 'Broadcasting...');
  const broadcastRes = curlPost('/broadcast', {
    session_id: mintRes.session_id,
    signed_psbt_base64: signedPsbt,
  });

  if (broadcastRes.error || !broadcastRes.success) {
    throw new Error('Broadcast failed: ' + JSON.stringify(broadcastRes));
  }

  log('STEP3', '════════════════════════════════════');
  log('STEP3', '       MINT SUCCESSFUL');
  log('STEP3', '════════════════════════════════════');
  log('STEP3', `Commit TX:  ${broadcastRes.commit_tx_id}`);
  if (broadcastRes.reveal_tx_ids) {
    broadcastRes.reveal_tx_ids.forEach((t, i) => log('STEP3', `Reveal ${i+1}:  ${t}`));
  }
  if (broadcastRes.mempool_urls) {
    log('STEP3', `Mempool: ${broadcastRes.mempool_urls.commit}`);
  }
  if (broadcastRes.ordinals_urls) {
    broadcastRes.ordinals_urls.forEach(u => log('STEP3', `Inscription: ${u}`));
  }

  const elapsed = Date.now() - totalStart;
  log('DONE', `Total: ${elapsed}ms`);

  // Save
  const result = {
    timestamp: new Date().toISOString(),
    total_time_ms: elapsed,
    session_id: mintRes.session_id,
    commit_tx_id: broadcastRes.commit_tx_id,
    reveal_tx_ids: broadcastRes.reveal_tx_ids,
    inscription_ids: broadcastRes.inscription_ids,
    ordinals_urls: broadcastRes.ordinals_urls,
    mempool_urls: broadcastRes.mempool_urls,
  };
  fs.writeFileSync('/home/user/egggg/mint_result.json', JSON.stringify(result, null, 2));
  log('DONE', 'Saved to mint_result.json');

  // Step 4: Confirm (fire and forget)
  try {
    if (broadcastRes.reveal_tx_ids && mintRes.ordinals) {
      mintRes.ordinals.forEach(o => {
        curlPost('/confirm', { txid: broadcastRes.reveal_tx_ids[0], ordinal_number: o.ordinal_number });
      });
      log('STEP4', 'Confirmed');
    }
  } catch(e) { log('STEP4', `Confirm skipped: ${e.message}`); }

  return result;
}

// ─── RUN ──────────────────────────────────────────────────────────────────────

try {
  main();
  log('SUCCESS', 'Mint complete!');
  process.exit(0);
} catch (err) {
  log('ERROR', `FATAL: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
