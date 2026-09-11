#!/usr/bin/env python3
"""pkg_verify.py — 发布前验安装包的**真**完整性（minisign / Ed25519）

## 为什么需要它

`publish-update.py` 原本只有三道启发式关卡：大小 ≥ 25 MB、`file` 认出 PE32、
签名文本以 `dW50cnVzdGVk` 开头。2026-09-10 发 v0.8.8-beta 时从 GitHub 拉包
断在 **36.4 MB**（curl 非零退出，但文件留在原地），这三道**全都会放行**：
半截 exe 一样有 PE 头，签名文件是单独下的、完好无损。

而这脚本存在的唯一理由就是"宁可不发，也不能发半截包"。所以补上真正的判据：
用客户端**实际校验用的那把公钥**（`src-tauri/tauri.conf.json` 的
`plugins.updater.pubkey`）验签名。签名覆盖整个文件内容，少一个字节就通不过——
这一条通过了，包必然是完整且未被篡改的，大小对不对反而不重要了。

## minisign 格式（tauri updater 用的就是它）

公钥/签名文件都是 base64 套 base64：外层解出一段带注释的文本，其中那行
base64 再解出二进制 `alg(2) + key_id(8) + payload`。
  · alg `Ed` = 直接对文件内容签名
  · alg `ED` = 对文件的 BLAKE2b-512 摘要签名（prehashed，tauri 现在用这个）
key id 必须与公钥一致，否则是**另一把钥匙**签的——签名本身再有效也不能发。
"""
from __future__ import annotations

import base64
import hashlib
import json
from pathlib import Path

from nacl.exceptions import BadSignatureError
from nacl.signing import VerifyKey


class SigError(Exception):
    """签名不可信。调用方应当**停止发布**，而不是降级放行。"""


def _inner_line(b64_text: str) -> bytes:
    """剥掉 minisign 的注释行，取出那行真正的 base64 载荷。"""
    txt = base64.b64decode(b64_text.strip()).decode("utf-8", "replace")
    for line in txt.splitlines():
        line = line.strip()
        if line and not line.startswith(("untrusted comment:", "trusted comment:")):
            return base64.b64decode(line)
    raise SigError("minisign 文本里找不到 base64 载荷行")


def verify(exe: Path, sig: Path, tauri_conf: Path) -> str:
    """验签成功返回 key id（十六进制），失败抛 SigError。"""
    conf = json.loads(tauri_conf.read_text())
    pubkey_b64 = conf.get("plugins", {}).get("updater", {}).get("pubkey")
    if not pubkey_b64:
        raise SigError(f"{tauri_conf} 里没有 plugins.updater.pubkey，无法验签")

    pk = _inner_line(pubkey_b64)
    sg = _inner_line(sig.read_text())
    if len(pk) < 42 or len(sg) < 74:
        raise SigError("公钥或签名长度不对，文件可能损坏")

    alg, key_id, raw_sig = sg[:2], sg[2:10], sg[10:74]
    if key_id != pk[2:10]:
        raise SigError(
            f"签名的 key id {key_id.hex()} 与客户端公钥 {pk[2:10].hex()} 不符"
            "——这不是同一把钥匙签的，发出去客户端会拒绝更新")

    data = exe.read_bytes()
    # ED = prehashed：签的是 BLAKE2b-512 摘要；Ed = 直接签文件内容
    msg = hashlib.blake2b(data, digest_size=64).digest() if alg == b"ED" else data
    try:
        VerifyKey(pk[10:42]).verify(msg, raw_sig)
    except BadSignatureError:
        raise SigError(
            "签名与安装包内容不匹配——包没下完、下串了、或被改过。"
            f"当前大小 {len(data)/1048576:.1f} MB") from None
    return key_id.hex()
