// Signs a PSBT and outputs the signed base64. Usage: node sign_psbt.js <psbt_base64>
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const { ECPairFactory } = require('ecpair');
bitcoin.initEccLib(ecc);
const ECPair = ECPairFactory(ecc);

const psbtBase64 = process.argv[2];
const keyPair = ECPair.fromWIF('L58RVADXJAgoMeYZ1DyNSWt62hRqT1qRHBRptTzVPHHCc8wozYvY', bitcoin.networks.bitcoin);
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
process.stdout.write(psbt.toBase64());
