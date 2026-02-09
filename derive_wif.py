#!/usr/bin/env python3
"""
Derives the WIF private key for your Xverse payment address.
Derivation path: m/49'/0'/0'/0/0 (P2SH-P2WPKH)
Your seed phrase is NEVER sent anywhere - this runs 100% locally.
"""
import hashlib, hmac, struct, base58, getpass

def mnemonic_to_seed(mnemonic, passphrase=""):
    return hashlib.pbkdf2_hmac("sha512", mnemonic.encode("utf-8"), ("mnemonic" + passphrase).encode("utf-8"), 2048)

def derive_master(seed):
    h = hmac.new(b"Bitcoin seed", seed, hashlib.sha512).digest()
    return h[:32], h[32:]

def ser32(i):
    return struct.pack(">I", i)

def derive_child(privkey, chaincode, index):
    if index >= 0x80000000:
        data = b"\x00" + privkey + ser32(index)
    else:
        from ecdsa import SigningKey, SECP256k1
        sk = SigningKey.from_string(privkey, curve=SECP256k1)
        pubkey = b"\x02" + sk.get_verifying_key().to_string()[:32] if sk.get_verifying_key().to_string()[32] % 2 == 0 else b"\x03" + sk.get_verifying_key().to_string()[:32]
        # Compressed public key
        vk = sk.get_verifying_key().to_string()
        x = vk[:32]
        y = vk[32:]
        prefix = b"\x02" if y[-1] % 2 == 0 else b"\x03"
        pubkey = prefix + x
        data = pubkey + ser32(index)
    h = hmac.new(chaincode, data, hashlib.sha512).digest()
    child_key = (int.from_bytes(privkey, "big") + int.from_bytes(h[:32], "big")) % 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141
    return child_key.to_bytes(32, "big"), h[32:]

def privkey_to_wif(privkey_bytes):
    extended = b"\x80" + privkey_bytes + b"\x01"  # mainnet, compressed
    checksum = hashlib.sha256(hashlib.sha256(extended).digest()).digest()[:4]
    return base58.b58encode(extended + checksum).decode()

# Get seed phrase from user input
print("Enter your 12-word seed phrase:")
seed_phrase = input("Seed phrase: ").strip()

# Derive
seed = mnemonic_to_seed(seed_phrase)
privkey, chaincode = derive_master(seed)

# m/49'/0'/0'/0/0
for index in [49 + 0x80000000, 0 + 0x80000000, 0 + 0x80000000, 0, 0]:
    privkey, chaincode = derive_child(privkey, chaincode, index)

wif = privkey_to_wif(privkey)
print(f"\nYour WIF private key:\n{wif}")
print("\nPaste this back to me. Do NOT share your seed phrase.")
