"""补传 v0.3.0 新增 4 文件 + 重打 tag（旧 tag 指向缺文件的 commit）。"""
import base64
import json
import os
import urllib.error
import urllib.request

TOKEN = os.environ["GH_TOKEN"]
OWNER, REPO, BRANCH = "lbg1690786597-ui", "filmweaver", "main"


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


NEW_FILES = [
    "src/types.ts",
    "src/components/LibraryPanel.tsx",
    "src/components/Timeline.tsx",
    "src/components/AiDrawer.tsx",
]

for path in NEW_FILES:
    content = base64.b64encode(open(path, "rb").read()).decode()
    st, data = api("GET", f"/repos/{OWNER}/{REPO}/contents/{path}?ref={BRANCH}")
    body = {"message": f"feat: v0.3.0 add {path}", "content": content, "branch": BRANCH}
    if st == 200:
        body["sha"] = data["sha"]
    st, data = api("PUT", f"/repos/{OWNER}/{REPO}/contents/{path}", body)
    print("OK" if st in (200, 201) else f"FAIL {st} {data.get('message')}", path)

# 删旧 tag → 重打到最新 main
api("DELETE", f"/repos/{OWNER}/{REPO}/git/refs/tags/v0.3.0")
st, data = api("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
sha = data["object"]["sha"]
st, data = api("POST", f"/repos/{OWNER}/{REPO}/git/refs", {"ref": "refs/tags/v0.3.0", "sha": sha})
print("重打 tag:", data.get("ref") or data.get("message"), "→", sha[:8])