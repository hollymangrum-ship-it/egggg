#!/usr/bin/env python3
import hashlib, json, urllib.request, urllib.error, time, sys, subprocess

COLLECTION = "812eed4e-c7bb-436a-b4d3-a43342c6ef37"
MINT_URL = f"https://ordmaker.fun/api/agent/collections/{COLLECTION}/mint"
BROADCAST_URL = f"https://ordmaker.fun/api/agent/collections/{COLLECTION}/broadcast"
HEADERS = {"Content-Type": "application/json", "User-Agent": "claude-agent/1.0"}
BODY = {
    "payment_address": "36cuzNZHrfPNBP6crJQpvnjdkm6k4Dgm7N",
    "payment_pubkey": "03d288f20f7d3b35f16f67a693798ef5607d291f54cd344d724c5630f09df8d26c",
    "receiving_address": "bc1pxvyf4sh50t30tamqn4kwknzkz3uj6q0l98gvnsp2k9xyzhgl0cfq6genqh",
    "quantity": 1
}

MAX_RETRIES = 3

def post(url, data, retries=MAX_RETRIES):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, data=json.dumps(data).encode(), headers=HEADERS, method="POST")
            return json.loads(urllib.request.urlopen(req, timeout=15).read())
        except urllib.error.HTTPError as e:
            try:
                return json.loads(e.read().decode())
            except:
                if i < retries - 1:
                    time.sleep(0.2)
                    continue
                return {"error": f"HTTP {e.code}", "code": "HTTP_ERROR"}
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as e:
            if i < retries - 1:
                time.sleep(0.3)
                continue
            return {"error": str(e), "code": "NETWORK_ERROR"}
        except Exception as e:
            return {"error": str(e), "code": "UNKNOWN_ERROR"}

def solve(challenge, address):
    nonce = 0
    while True:
        h = hashlib.sha256((challenge + address + str(nonce)).encode()).hexdigest()
        if h.startswith("0000"):
            return str(nonce)
        nonce += 1

def sign_psbt(psbt_base64, retries=2):
    for i in range(retries):
        try:
            result = subprocess.run(
                ["node", "/home/user/egggg/sign_psbt.js", psbt_base64],
                capture_output=True, text=True, timeout=10
            )
            if result.returncode != 0:
                if i < retries - 1:
                    continue
                raise Exception(f"Signing failed: {result.stderr}")
            signed = result.stdout.strip()
            if not signed:
                raise Exception("Signing returned empty result")
            return signed
        except subprocess.TimeoutExpired:
            if i < retries - 1:
                continue
            raise Exception("Signing timed out")

def broadcast_with_retry(session_id, signed_psbt, retries=MAX_RETRIES):
    for i in range(retries):
        result = post(BROADCAST_URL, {
            "session_id": session_id,
            "signed_psbt_base64": signed_psbt
        }, retries=1)
        if result.get("success"):
            return result
        if i < retries - 1:
            print(f"  Broadcast retry {i+2}/{retries}...", flush=True)
            time.sleep(0.5)
    return result

print("FULL AUTO MINT - polling every 1s...", flush=True)
print(f"Quantity: {BODY['quantity']} | Payment: {BODY['payment_address']}", flush=True)
attempt = 0
while True:
    attempt += 1
    try:
        resp = post(MINT_URL, BODY)

        if resp.get("challenge_required") and resp.get("challenge"):
            challenge = resp["challenge"]
            nonce = solve(challenge, BODY["payment_address"])
            print(f"[{attempt}] Solved nonce={nonce}", flush=True)

            submit = dict(BODY)
            submit["challenge_nonce"] = nonce
            mint_resp = post(MINT_URL, submit)

            if mint_resp.get("success") and mint_resp.get("commit_psbt"):
                print(f"[{attempt}] RESERVED! Session: {mint_resp['session_id']}", flush=True)
                print(f"[{attempt}] Signing...", flush=True)
                signed = sign_psbt(mint_resp["commit_psbt"])
                print(f"[{attempt}] SIGNED! Broadcasting...", flush=True)

                broadcast = broadcast_with_retry(mint_resp["session_id"], signed)

                if broadcast.get("success"):
                    print("\n=== MINT SUCCESSFUL ===", flush=True)
                    print(json.dumps(broadcast, indent=2), flush=True)
                    with open("/home/user/egggg/mint_result.json", "w") as f:
                        json.dump(broadcast, f, indent=2)
                    sys.exit(0)
                else:
                    print(f"[{attempt}] Broadcast FAILED: {json.dumps(broadcast)}", flush=True)
                    print(f"[{attempt}] Retrying full flow...", flush=True)
            elif mint_resp.get("code") == "NO_ACTIVE_PHASE":
                print(f"[{attempt}] Phase not open yet...", end="\r", flush=True)
            elif mint_resp.get("error"):
                print(f"[{attempt}] Mint error: {mint_resp['error']}", flush=True)
            else:
                print(f"[{attempt}] Mint: {json.dumps(mint_resp)}", flush=True)
        elif resp.get("success") and resp.get("commit_psbt"):
            print(f"[{attempt}] RESERVED (no challenge)! Signing...", flush=True)
            signed = sign_psbt(resp["commit_psbt"])
            print(f"[{attempt}] SIGNED! Broadcasting...", flush=True)
            broadcast = broadcast_with_retry(resp["session_id"], signed)
            if broadcast.get("success"):
                print("\n=== MINT SUCCESSFUL ===", flush=True)
                print(json.dumps(broadcast, indent=2), flush=True)
                with open("/home/user/egggg/mint_result.json", "w") as f:
                    json.dump(broadcast, f, indent=2)
                sys.exit(0)
            else:
                print(f"[{attempt}] Broadcast FAILED: {json.dumps(broadcast)}", flush=True)
        elif resp.get("code") == "NETWORK_ERROR":
            print(f"[{attempt}] Network error, retrying...", flush=True)
        else:
            print(f"[{attempt}] Waiting...", end="\r", flush=True)
    except Exception as e:
        print(f"[{attempt}] Error: {e}", flush=True)

    time.sleep(1)
