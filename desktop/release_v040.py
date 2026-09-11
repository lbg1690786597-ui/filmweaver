"""v0.4.0: 上传签名私钥 secret + 上传全部改动文件 + 打 tag（应用内自动更新版）。"""
import base64
import json
import os
import urllib.error
import urllib.request

import nacl.encoding
import nacl.public

TOKEN = os.environ["GH_TOKEN"]
OWNER, REPO, BRANCH = "lbg1690786597-ui", "filmweaver", "main"
TAG = "v0.4.0"


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        f"https://api.github.com{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"token {TOKEN}", "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, json.loads(raw) if raw else {}


# ---- 1. 上传签名私钥 secret ----
st, pub = api("GET", f"/repos/{OWNER}/{REPO}/actions/secrets/public-key")
pk = nacl.public.PublicKey(pub["key"].encode(), nacl.encoding.Base64Encoder)
sealed = nacl.public.SealedBox(pk).encrypt(open("/root/.tauri/filmweaver.key", "rb").read())
st, data = api("PUT", f"/repos/{OWNER}/{REPO}/actions/secrets/TAURI_SIGNING_PRIVATE_KEY", {
    "encrypted_value": base64.b64encode(sealed).decode(),
    "key_id": pub["key_id"],
})
print("secret:", "OK" if st in (201, 204) else f"FAIL {st} {data}")

# ---- 2. 上传改动文件 ----
FILES = [
    ".github/workflows/build-windows.yml",
    "src/App.tsx",
    "src/api.ts",
    "package.json",
    "package-lock.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
    "src-tauri/src/lib.rs",
    "src-tauri/capabilities/default.json",
]
for path in FILES:
    if not os.path.exists(path):
        print("SKIP（不存在）", path)
        continue
    content = base64.b64encode(open(path, "rb").read()).decode()
    st, data = api("GET", f"/repos/{OWNER}/{REPO}/contents/{path}?ref={BRANCH}")
    body = {"message": f"feat: {TAG} in-app auto update ({path})", "content": content, "branch": BRANCH}
    if st == 200:
        body["sha"] = data["sha"]
    st, data = api("PUT", f"/repos/{OWNER}/{REPO}/contents/{path}", body)
    print("OK" if st in (200, 201) else f"FAIL {st} {data.get('message')}", path)

# ---- 3. 打 tag ----
st, data = api("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
sha = data["object"]["sha"]
st, data = api("POST", f"/repos/{OWNER}/{REPO}/git/refs", {"ref": f"refs/tags/{TAG}", "sha": sha})
print("tag:", data.get("ref") or data.get("message"), "→", sha[:8])