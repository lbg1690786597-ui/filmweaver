#!/usr/bin/env python3
"""带断点续传 + 卡死检测的下载器（只为发版时拉 GitHub Release 产物用）。

为什么不用 `curl -C -`：本机到 GitHub 的链路经常只有几十 KB/s，且会**静默卡死**
（进程活着、字节数几分钟不动），一次要拉 56 MB，用整段超时兜底就得反复从头再来。

## 三个必须一起处理的坑

1. **卡死**：单次读超过 STALL 秒没有新字节，就主动断开、带着已下的字节数重连，
   损失上限是 STALL 秒而不是整轮。

2. **预签名 URL 会过期**：Release 资产的真身在 `release-assets.githubusercontent.com`，
   是 `se=` 里带过期时刻（约 1 小时）的签名地址。若把它缓存下来反复用，
   过一小时后只剩 TimeoutError。所以每轮重连都重新请求**原始链接**并跟随 302，
   由服务端重新签一个——Range 头是跟着跳转一起带过去的。

3. **github.com 本身可能连不上**：302 那一步走的是 `github.com`，实测它比
   资产域（`release-assets` / `objects`，走 Fastly）脆弱得多——本机对它的连接会
   整段超时（TCP 都建不起来），而同期 `api.github.com` 只要 0.5 秒、资产域正常。
   所以**不要**用 `github.com/.../releases/download/...` 那个链接，改用
   `api.github.com/repos/.../releases/assets/<id>`：它同样 302 到签名地址，
   但响应稳定得多。走 api 要带上 token（环境变量 GH_TOKEN，不回显）。

用法:  python3 fetch_release_asset.py <url> <目标路径> <期望总字节数>
"""
from __future__ import annotations

import os
import sys
import time
import urllib.request

STALL = 25            # 单次连接内多少秒没有新字节就算卡死
CHUNK = 256 * 1024
MAX_TRIES = 400
UA = {"User-Agent": "filmweaver-release/1.0"}


def main() -> None:
    url, dest, want = sys.argv[1], sys.argv[2], int(sys.argv[3])
    tok = os.environ.get("GH_TOKEN")
    base_hdr = dict(UA)
    if tok and "api.github.com" in url:
        base_hdr["Authorization"] = f"token {tok}"
        base_hdr["Accept"] = "application/octet-stream"
    got = os.path.getsize(dest) if os.path.exists(dest) else 0
    if got > want:
        print(f"本地 {got} 字节 > 远端 {want}，多半是脏文件，删掉重下", flush=True)
        os.remove(dest)
        got = 0

    tries = 0
    fails = 0
    last_report = 0.0
    while got < want and tries < MAX_TRIES:
        tries += 1
        hdr = dict(base_hdr)
        if got:
            hdr["Range"] = f"bytes={got}-"
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=hdr),
                                        timeout=STALL) as r:
                if r.status == 200 and got:      # 服务端忽略 Range → 从头覆盖
                    print("  服务端未接受 Range，从头下", flush=True)
                    got = 0
                fails = 0
                with open(dest, "ab" if got else "wb") as f:
                    while got < want:
                        try:
                            b = r.read(CHUNK)
                        except Exception:
                            break                    # 卡死/断流 → 重连
                        if not b:
                            break
                        f.write(b)
                        got += len(b)
                        now = time.time()
                        if now - last_report > 10:
                            last_report = now
                            print(f"  {got}/{want}  {got*100//want}%", flush=True)
        except Exception as e:
            fails += 1
            if fails <= 3 or fails % 10 == 0:
                print(f"  第 {tries} 次连接异常: {type(e).__name__}（连续 {fails} 次）", flush=True)
            if fails == 8:
                print("  ⚠️ 连续 8 次连不上 github.com——该域名经本机常超时，"
                      "资产域(Fastly)正常时也会被这一步挡住", flush=True)
            time.sleep(2)

    ok = got == want
    print(f"{'✅ 完成' if ok else '❌ 未完成'}: {got}/{want}（{tries} 次连接）", flush=True)
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
