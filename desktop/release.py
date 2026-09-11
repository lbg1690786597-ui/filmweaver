"""同步 desktop/ 到公开仓 lbg1690786597-ui/filmweaver 并打 tag 触发 CI 构建发布。

用法：
    GH_TOKEN=<token> python3 release.py v0.5.0

做三件事：
  1. 把本地 desktop/ 下所有应发布文件（受 git 跟踪、排除一次性脚本）上传到远端 main
  2. 确认签名私钥 secret 存在（缺失才上传，避免无谓覆盖）
  3. 打 tag → 触发 .github/workflows/build-windows.yml
     → tauri-action 编译 + 签名 + 建 Release（含 setup.exe / .sig / latest.json）

注意：该仓库是 public，且是面向真实用户的自动更新通道。
只上传 desktop/ 内容，backend / docs / infra 一律不推。
"""
import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

TOKEN = os.environ["GH_TOKEN"]
OWNER, REPO, BRANCH = "lbg1690786597-ui", "filmweaver", "main"
TAG = sys.argv[1] if len(sys.argv) > 1 else None
if not TAG or not TAG.startswith("v"):
    sys.exit("用法: GH_TOKEN=xxx python3 release.py v0.5.0")

# 一次性发版脚本/本地工具，不进公开仓
EXCLUDE = {"release.py", "fix_v030.py", "fix_v031.py", "release_v040.py",
           "upload_via_api.py", "sync_appcast.py",
           # 本地跑 runtime_verify 用的真实剧本素材：客户端构建用不到它，
           # 而这个仓是 **public** 的——推上去等于把用户的剧本公开。
           "scripts/runtime_verify/楚家真假少爷_3集剧本.md"}


def api(method: str, path: str, body=None):
    req = urllib.request.Request(
        f"https://api.github.com{path}", method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": f"token {TOKEN}",
                 "Accept": "application/vnd.github+json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read()
        return e.code, json.loads(raw) if raw else {}


def local_files() -> list[str]:
    """desktop/ 下受 git 跟踪的文件（相对 desktop/），排除一次性脚本。

    用 git ls-files 而非 os.walk，天然遵守 .gitignore（不会带上 node_modules/dist/target）。

    ⚠️ 必须用 `-z`（NUL 分隔）：`git ls-files` 默认 `core.quotepath=true`，
    含非 ASCII 的路径会被输出成带引号的八进制转义（"scripts/…/\346\245\232…"），
    直接拿去 open() 就是 FileNotFoundError。仓里只要有**一个**中文名文件，
    整个发版流程就会在上传到一半时崩掉——2026-09-10 的 v0.8.8-beta 正是这么挂的。
    """
    out = subprocess.run(["git", "ls-files", "-z"], capture_output=True, check=True)
    files = []
    for raw in out.stdout.split(b"\0"):
        p = raw.decode("utf-8").strip()
        if not p or p in EXCLUDE:
            continue
        # .github/workflows 需要推（CI 定义），其余原样
        files.append(p)
    return sorted(files)


# ---- 1. 确认签名私钥 secret 存在（缺失才补） ----
st, data = api("GET", f"/repos/{OWNER}/{REPO}/actions/secrets/TAURI_SIGNING_PRIVATE_KEY")
if st == 200:
    print("secret: 已存在 TAURI_SIGNING_PRIVATE_KEY，跳过上传")
else:
    import nacl.encoding
    import nacl.public
    st, pub = api("GET", f"/repos/{OWNER}/{REPO}/actions/secrets/public-key")
    pk = nacl.public.PublicKey(pub["key"].encode(), nacl.encoding.Base64Encoder)
    sealed = nacl.public.SealedBox(pk).encrypt(
        open("/root/.tauri/filmweaver.key", "rb").read())
    st, data = api("PUT", f"/repos/{OWNER}/{REPO}/actions/secrets/TAURI_SIGNING_PRIVATE_KEY", {
        "encrypted_value": base64.b64encode(sealed).decode(),
        "key_id": pub["key_id"],
    })
    print("secret:", "OK" if st in (201, 204) else f"FAIL {st} {data}")

# ---- 2. 上传有差异的文件 ----
changed = skipped = failed = 0
for path in local_files():
    blob = open(path, "rb").read()
    # 本地 blob sha，与远端一致则跳过，避免制造空 commit
    local_sha = subprocess.run(["git", "hash-object", path],
                               capture_output=True, text=True).stdout.strip()
    st, data = api("GET", f"/repos/{OWNER}/{REPO}/contents/{path}?ref={BRANCH}")
    remote_sha = data.get("sha") if st == 200 else None
    if remote_sha == local_sha:
        skipped += 1
        continue
    body = {"message": f"feat: {TAG} ({path})",
            "content": base64.b64encode(blob).decode(), "branch": BRANCH}
    if remote_sha:
        body["sha"] = remote_sha
    st, data = api("PUT", f"/repos/{OWNER}/{REPO}/contents/{path}", body)
    if st in (200, 201):
        changed += 1
        print("  UP  ", path)
    else:
        failed += 1
        print(f"  FAIL {st}", path, data.get("message"))

print(f"上传: {changed} 改动 / {skipped} 未变 / {failed} 失败")
if failed:
    sys.exit("有文件上传失败，已中止，未打 tag")

# ---- 2b. 删除远端多出来的文件 ----
# 只上传不删除，本地删掉的文件会**永远留在公开仓**，并且照样被 CI 编译。
# v0.8.1 就栽在这儿：useCompose.ts 本地已随"取消云端合成"删除，远端残留的
# 那份仍在调用 api.submitCompose，CI 类型检查直接红。
# 判据与上传一致：`git ls-files` 是"该发布什么"的唯一定义，远端不在其中的一律删。
# EXCLUDE 里的本地工具不参与——它们本来就不该上去，误删也无从谈起。
st, tree = api("GET", f"/repos/{OWNER}/{REPO}/git/trees/{BRANCH}?recursive=1")
if st != 200:
    sys.exit(f"读远端文件树失败 {st}: {tree.get('message')}")
if tree.get("truncated"):
    sys.exit("远端文件树被截断，无法安全比对，已中止（改用 Git Data API 重写树）")

wanted = set(local_files())
stale = sorted(x["path"] for x in tree["tree"]
               if x["type"] == "blob"
               and x["path"] not in wanted
               and x["path"] not in EXCLUDE)
removed = 0
for path in stale:
    st, data = api("DELETE", f"/repos/{OWNER}/{REPO}/contents/{path}", {
        "message": f"chore: {TAG} 删除已下线文件 ({path})",
        "branch": BRANCH,
        "sha": next(x["sha"] for x in tree["tree"] if x["path"] == path),
    })
    if st == 200:
        removed += 1
        print("  DEL ", path)
    else:
        failed += 1
        print(f"  FAIL {st}", path, data.get("message"))
print(f"删除: {removed} 个远端残留文件")
if failed:
    sys.exit("有文件删除失败，已中止，未打 tag")

# ---- 3. 打 tag 触发 CI ----
st, data = api("GET", f"/repos/{OWNER}/{REPO}/git/ref/heads/{BRANCH}")
sha = data["object"]["sha"]
st, data = api("POST", f"/repos/{OWNER}/{REPO}/git/refs",
               {"ref": f"refs/tags/{TAG}", "sha": sha})
if st in (200, 201):
    print(f"tag: {TAG} → {sha[:8]}，CI 已触发")
else:
    print(f"tag FAIL {st}: {data.get('message')}")
    sys.exit(1)
