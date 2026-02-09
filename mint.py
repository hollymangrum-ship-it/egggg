#!/usr/bin/env python3
import hashlib, json, urllib.request, urllib.error, time, sys

URL = "https://ordmaker.fun/api/agent/collections/812eed4e-c7bb-436a-b4d3-a43342c6ef37/mint"
HEADERS = {"Content-Type": "application/json", "User-Agent": "claude-agent/1.0"}
BODY = {
    "payment_address": "36cuzNZHrfPNBP6crJQpvnjdkm6k4Dgm7N",
    "payment_pubkey": "03d288f20f7d3b35f16f67a693798ef5607d291f54cd344d724c5630f09df8d26c",
    "receiving_address": "bc1pxvyf4sh50t30tamqn4kwknzkz3uj6q0l98gvnsp2k9xyzhgl0cfq6genqh",
    "quantity": 2
}

def post(data):
    req = urllib.request.Request(URL, data=json.dumps(data).encode(), headers=HEADERS, method="POST")
    try:
        return json.loads(urllib.request.urlopen(req, timeout=10).read())
    except urllib.error.HTTPError as e:
        return json.loads(e.read().decode())

def solve(challenge, address):
    nonce = 0
    while True:
        h = hashlib.sha256((challenge + address + str(nonce)).encode()).hexdigest()
        if h.startswith("0000"):
            return str(nonce)
        nonce += 1

print("POLLING FOR MINT PHASE...", flush=True)
attempt = 0
while True:
    attempt += 1
    resp = post(BODY)

    # If we got a challenge, solve and submit immediately
    if resp.get("challenge_required") and resp.get("challenge"):
        challenge = resp["challenge"]
        print(f"[{attempt}] GOT CHALLENGE: {challenge[:16]}...", flush=True)

        nonce = solve(challenge, BODY["payment_address"])
        print(f"[{attempt}] SOLVED nonce={nonce}", flush=True)

        submit = dict(BODY)
        submit["challenge_nonce"] = nonce
        result = post(submit)

        if result.get("success"):
            print("SUCCESS!", flush=True)
            print(json.dumps(result, indent=2), flush=True)
            # Write result to file for easy access
            with open("/home/user/egggg/mint_result.json", "w") as f:
                json.dump(result, f, indent=2)
            sys.exit(0)
        elif result.get("error") == "No active mint phase":
            print(f"[{attempt}] Phase not open yet, retrying in 1s...", flush=True)
        else:
            print(f"[{attempt}] Unexpected: {json.dumps(result)}", flush=True)
    elif result.get("success"):
        print("SUCCESS (no challenge needed)!", flush=True)
        print(json.dumps(result, indent=2), flush=True)
        with open("/home/user/egggg/mint_result.json", "w") as f:
            json.dump(result, f, indent=2)
        sys.exit(0)
    else:
        code = result.get("code", "")
        if code == "NO_ACTIVE_PHASE":
            print(f"[{attempt}] No active phase yet, retrying in 1s...", flush=True)
        else:
            print(f"[{attempt}] Response: {json.dumps(result)}", flush=True)

    time.sleep(1)
