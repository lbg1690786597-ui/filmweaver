#!/usr/bin/env python3
"""把已下载并校验过的安装包发布到自建更新源。

## 为什么单独写这个脚本

之前几次发布都卡在同一个地方：从 GitHub 拉产物很慢（19 KB/s），
拉的过程中如果先把 latest.json 换成新版本，用户的客户端就会去下一个
还没下完的包——拿到半截文件，更新失败。踩过一次。

所以顺序必须是：**先把包下完并验证，最后一步才切 manifest**。
这个脚本只做最后一步，且切之前重新验一遍完整性。

## 用法
    python3 publish-update.py 0.8.0          # 正式版 → /fwp 通道
    python3 publish-update.py 0.8.1 --beta   # 测试版 → /fw  通道

`--beta` 决定两件事：产物名与**发布到哪个通道**。
- 产物名：CI 里 tag 含 `-beta` 时 productName 变成 "FilmWeaver Beta"，
  NSIS 把空格写成点 → `FilmWeaver.Beta_<ver>_x64-setup.exe`。
- 通道：beta 与正式是两个独立软件，各读各的 appcast（见下方常量）。
  发错通道 = 对应用户根本收不到更新，且污染另一条通道。
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

# 两个通道各有独立的 appcast 目录与对外路径, **绝不能混**:
#   beta  → /fw  (dev 后端 8002), 目录 filmweaver-data/appcast
#   正式  → /fwp (prod 后端 8003), 目录 filmweaver-prod-data/appcast
# 依据: CI(build-windows.yml)按 tag 是否含 -beta 给两个软件写死了各自的 appcast
# 端点, 客户端各读各的。此前本脚本只有一组常量, 不带 --beta 发布时会把正式版
# manifest 写进 beta 目录 —— 正式用户根本读不到, 反而污染了 beta 通道。
APPCAST_BETA = Path("/root/filmweaver-data/appcast")
APPCAST_PROD = Path("/root/filmweaver-prod-data/appcast")
BASE_URL_BETA = "http://118.196.33.51:9080/fw/media/appcast"
BASE_URL_PROD = "http://118.196.33.51:9080/fwp/media/appcast"
# CI 产物的实际大小约 30 MB；低于此值说明没下完
MIN_SIZE = 25 * 1024 * 1024


def die(msg: str) -> None:
    print(f"❌ {msg}")
    sys.exit(1)


def main() -> None:
    argv = [a for a in sys.argv[1:] if a != "--beta"]
    beta = "--beta" in sys.argv
    if not argv:
        die("用法: publish-update.py <版本号> [--beta] [更新说明]")
    ver = argv[0]
    notes = argv[1] if len(argv) > 1 else "自动构建发布。应用内点「⟳ 检查更新」即可静默升级。"

    # beta 与正式版是**两个软件**（productName / identifier 都不同），
    # 产物名因此也不同：NSIS 把 "FilmWeaver Beta" 里的空格写成点。
    # 目录/URL 也必须跟着切，否则会发到对方的通道里。
    appcast = APPCAST_BETA if beta else APPCAST_PROD
    base_url = BASE_URL_BETA if beta else BASE_URL_PROD
    stem = f"FilmWeaver.Beta_{ver}" if beta else f"FilmWeaver_{ver}"
    exe = appcast / f"{stem}_x64-setup.exe"
    sig = appcast / f"{stem}_x64-setup.exe.sig"
    live = appcast / "latest.json"

    # ---- 发布前校验：宁可不发，也不能发半截包 ----
    if not exe.exists():
        die(f"安装包不存在: {exe.name}")
    size = exe.stat().st_size
    if size < MIN_SIZE:
        die(f"安装包只有 {size/1048576:.1f} MB，明显没下完（应约 30 MB）——拒绝发布")
    if not sig.exists() or sig.stat().st_size == 0:
        die(f"签名文件缺失或为空: {sig.name}（签名只能来自 CI，不可本地伪造）")

    # PE 头校验：确认不是 HTML 错误页伪装成 exe（GitHub 限流时会返回这种）
    kind = subprocess.run(["file", "-b", str(exe)], capture_output=True, text=True).stdout
    if "PE32" not in kind:
        die(f"文件不是有效的 Windows 可执行程序: {kind.strip()}")

    signature = sig.read_text().strip()
    if not signature.startswith("dW50cnVzdGVk"):  # "untrusted comment:" 的 base64
        die("签名内容格式不对，可能下载到了错误页")

    url = f"{base_url}/{exe.name}"
    payload = {
        "version": ver,
        "notes": notes,
        "pub_date": datetime.now(timezone.utc).isoformat(timespec="milliseconds")
                    .replace("+00:00", "Z"),
        # 两个 key 都要给：updater 依平台/打包方式选其一，少一个就"检查不到更新"
        "platforms": {
            "windows-x86_64": {"signature": signature, "url": url},
            "windows-x86_64-nsis": {"signature": signature, "url": url},
        },
    }

    # 留一份旧的，出问题能立刻回滚
    if live.exists():
        prev = json.loads(live.read_text())
        (appcast / f"latest.{prev.get('version', 'unknown')}.json").write_text(
            json.dumps(prev, ensure_ascii=False, indent=2))
        print(f"  已备份旧 manifest: {prev.get('version')}")

    live.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"  ✅ 已发布 {ver} 到{'测试版(/fw)' if beta else '正式版(/fwp)'}通道")
    print(f"     包大小 {size/1048576:.1f} MB · 签名 {len(signature)} 字符")
    print(f"     {url}")


if __name__ == "__main__":
    main()
