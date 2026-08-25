#!/usr/bin/env python3
"""把已下载并校验过的安装包发布到自建更新源。

## 为什么单独写这个脚本

之前几次发布都卡在同一个地方：从 GitHub 拉产物很慢（19 KB/s），
拉的过程中如果先把 latest.json 换成新版本，用户的客户端就会去下一个
还没下完的包——拿到半截文件，更新失败。踩过一次。

所以顺序必须是：**先把包下完并验证，最后一步才切 manifest**。
这个脚本只做最后一步，且切之前重新验一遍完整性。

## 用法
    python3 publish-update.py 0.7.4 "更新说明"
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

APPCAST = Path("/root/filmweaver-data/appcast")
BASE_URL = "http://118.196.33.51:9080/fw/media/appcast"
# CI 产物的实际大小约 30 MB；低于此值说明没下完
MIN_SIZE = 25 * 1024 * 1024


def die(msg: str) -> None:
    print(f"❌ {msg}")
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 2:
        die("用法: publish-update.py <版本号> [更新说明]")
    ver = sys.argv[1]
    notes = sys.argv[2] if len(sys.argv) > 2 else "自动构建发布。应用内点「⟳ 检查更新」即可静默升级。"

    exe = APPCAST / f"FilmWeaver_{ver}_x64-setup.exe"
    sig = APPCAST / f"FilmWeaver_{ver}_x64-setup.exe.sig"
    live = APPCAST / "latest.json"

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

    url = f"{BASE_URL}/{exe.name}"
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
        (APPCAST / f"latest.{prev.get('version', 'unknown')}.json").write_text(
            json.dumps(prev, ensure_ascii=False, indent=2))
        print(f"  已备份旧 manifest: {prev.get('version')}")

    live.write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    print(f"  ✅ 已发布 {ver}")
    print(f"     包大小 {size/1048576:.1f} MB · 签名 {len(signature)} 字符")
    print(f"     {url}")


if __name__ == "__main__":
    main()
