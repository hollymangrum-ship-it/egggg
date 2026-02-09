#!/usr/bin/env node
const crypto = require('crypto');
const https = require('https');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');

bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const COLLECTION = '812eed4e-c7bb-436a-b4d3-a43342c6ef37';
const MINT_URL = `/api/agent/collections/${COLLECTION}/mint`;
const BROADCAST_URL = `/api/agent/collections/${COLLECTION}/broadcast`;
const HOST = 'ordmaker.fun';
const WIF = 'L58RVADXJAgoMeYZ1DyNSWt62hRqT1qRHBRptTzVPHHCc8wozYvY';
const PAYMENT_ADDRESS = '36cuzNZHrfPNBP6crJQpvnjdkm6k4Dgm7N';
const PAYMENT_PUBKEY = '03d288f20f7d3b35f16f67a693798ef5607d291f54cd344d724c5630f09df8d26c';
const RECEIVING_ADDRESS = 'bc1pxvyf4sh50t30tamqn4kwknzkz3uj6q0l98gvnsp2k9xyzhgl0cfq6genqh';
const QUANTITY = 2;

const keyPair = ECPair.fromWIF(WIF, bitcoin.networks.bitcoin);

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: HOST, port: 443, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-agent/1.0', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch(e) { reject(buf); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function solveChallenge(challenge, address) {
  let nonce = 0;
  while (true) {
    const hash = crypto.createHash('sha256').update(challenge + address + nonce.toString()).digest('hex');
    if (hash.startsWith('0000')) return nonce.toString();
    nonce++;
  }
}

function signPsbt(psbtBase64) {
  const psbt = bitcoin.Psbt.fromBase64(psbtBase64);
  for (let i = 0; i < psbt.inputCount; i++) {
    const input = psbt.data.inputs[i];
    if (input.tapInternalKey) {
      const tweakedSigner = keyPair.tweak(bitcoin.crypto.taggedHash('TapTweak', keyPair.publicKey.subarray(1, 33)));
      psbt.signInput(i, tweakedSigner, [bitcoin.Transaction.SIGHASH_DEFAULT]);
    } else {
      psbt.signInput(i, keyPair);
    }
  }
  psbt.finalizeAllInputs();
  return psbt.toBase64();
}

async function mint() {
  let attempt = 0;
  while (true) {
    attempt++;
    try {
      // Step 1: Get challenge
      const resp = await post(MINT_URL, {
        payment_address: PAYMENT_ADDRESS, payment_pubkey: PAYMENT_PUBKEY,
        receiving_address: RECEIVING_ADDRESS, quantity: QUANTITY
      });

      if (resp.challenge_required && resp.challenge) {
        const nonce = solveChallenge(resp.challenge, PAYMENT_ADDRESS);
        console.log(`[${attempt}] Solved nonce=${nonce}`);

        // Step 2: Submit with nonce
        const mintResp = await post(MINT_URL, {
          payment_address: PAYMENT_ADDRESS, payment_pubkey: PAYMENT_PUBKEY,
          receiving_address: RECEIVING_ADDRESS, quantity: QUANTITY, challenge_nonce: nonce
        });

        if (mintResp.success && mintResp.commit_psbt) {
          console.log(`[${attempt}] RESERVED! Session: ${mintResp.session_id}`);

          // Step 3: Sign PSBT
          const signedPsbt = signPsbt(mintResp.commit_psbt);
          console.log(`[${attempt}] SIGNED!`);

          // Step 4: Broadcast
          const broadcast = await post(BROADCAST_URL, {
            session_id: mintResp.session_id, signed_psbt_base64: signedPsbt
          });

          if (broadcast.success) {
            console.log('\n=== MINT SUCCESSFUL ===');
            console.log(JSON.stringify(broadcast, null, 2));
            require('fs').writeFileSync('/home/user/egggg/mint_result.json', JSON.stringify(broadcast, null, 2));
            process.exit(0);
          } else {
            console.log(`[${attempt}] Broadcast failed:`, JSON.stringify(broadcast));
          }
        } else if (mintResp.error === 'No active mint phase' || mintResp.code === 'NO_ACTIVE_PHASE') {
          process.stdout.write(`[${attempt}] Phase not open, retrying...\r`);
        } else {
          console.log(`[${attempt}] Mint response:`, JSON.stringify(mintResp));
        }
      } else if (resp.success && resp.commit_psbt) {
        // No challenge needed
        const signedPsbt = signPsbt(resp.commit_psbt);
        const broadcast = await post(BROADCAST_URL, { session_id: resp.session_id, signed_psbt_base64: signedPsbt });
        if (broadcast.success) {
          console.log('\n=== MINT SUCCESSFUL ===');
          console.log(JSON.stringify(broadcast, null, 2));
          require('fs').writeFileSync('/home/user/egggg/mint_result.json', JSON.stringify(broadcast, null, 2));
          process.exit(0);
        }
      } else {
        process.stdout.write(`[${attempt}] Waiting for phase...\r`);
      }
    } catch (e) {
      console.log(`[${attempt}] Error: ${e.message || e}`);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
}

console.log('FULL AUTO MINT - polling every 1s...');
console.log(`Quantity: ${QUANTITY} | Payment: ${PAYMENT_ADDRESS} | Receiving: ${RECEIVING_ADDRESS}`);
mint();
