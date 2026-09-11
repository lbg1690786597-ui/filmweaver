"""v0.3.1: 上传改动文件（App.tsx/api.ts/styles.css/版本文件）+ 打 tag。"""
import base64
import json
import os
import urllib.error
import urllib.request

TOKEN = os.environ["GH_TOKEN"]
OWNER, REPO, BRANCH = "lbg1690786597-ui", "filmweaver", "main"
TAG = "v0.3.1"


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        f"https://api.github.com{path}", method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"token {TOKEN}", "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or "{}")


FILES = [
    "src/App.tsx",
    "src/api.ts",
    "src/styles.css",
    "package.json",
    "src-tauri/tauri.conf.json",
    "src-tauri/Cargo.toml",
]

for path in FILES:
    content = base64.b64encode(open(path, "rb").read()).decode()
    st, data = api("GET", f"/repos/{OWNER}/{REPO}/contents/{path}?ref={BRANCH}")
    body = {"message": f"fix: {TAG} update flow ({path})", "content": content, "branch": BRANCH}
    if st == 200:
        body["sha"] = data["sha"]
    st, data = api("PUT", f"/repos/{OWNER}/{REPO}/contents/{path}", body)
    print("OK" if st in (200, 201) else f"FAIL {st} {data.get('message')}", path)

st, data = api("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
sha = data["object"]["sha"]
st, data = api("POST", f"/repos/{OWNER}/{REPO}/git/refs", {"ref": f"refs/tags/{TAG}", "sha": sha})
print("打 tag:", data.get("ref") or data.get("message"), "→", sha[:8])