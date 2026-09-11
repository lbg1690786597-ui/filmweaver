#!/usr/bin/env python3
"""发布通道的**唯一事实来源**：beta 与正式是两个软件，各有各的目录、基址、产物名。

## 为什么要有这个文件

这套映射此前在**三个地方**各写了一遍：

| 位置 | 状态 |
|---|---|
| `scripts/publish-update.py:37-40` | 两组常量，按 `--beta` 选 —— **写对了** |
| `sync_appcast.py:27,35` | **只有一组常量**，写死在源码里 —— 写错了 |
| `.github/workflows/build-windows.yml:74,79` | 两组，按 tag 选（CI 侧，不归本文件管） |

`publish-update.py` 的注释里已经记着这个 bug 被修过一次：
「此前本脚本只有一组常量, 不带 --beta 发布时会把正式版 manifest 写进 beta 目录」。
**但它的孪生兄弟 `sync_appcast.py` 从来没修过**，至今仍是一组常量。

后果是双向的，且两个方向都踩规则红线：

- 在 **dev 仓**跑 `sync_appcast.py v0.8.5`（正式 tag）→ 下载的是**正式版**安装包，
  却写进 **beta 目录**、URL 改写成 `/fw`（dev 后端 8002）。正式用户收不到更新，
  beta 用户收到一个连着开发库的正式版。
- 在 **prod 仓**跑 `sync_appcast.py v0.8.5-beta` → **beta 包发进正式通道**，
  即把生产用户指向开发后端。这是明令 ⛔ 的那一条。

而**没有任何代码在拦这件事** —— 唯一的"保护"是「你恰好站在哪个仓里」，
因为两个仓的那一组常量各自写死成了不同的值。这也正是 merge 隐患的来源：
一次 `git merge dev/main` 就会把 prod 那份翻成 dev 的值。

## 为什么是「按 tag 推导」而不是「读 .env」

tag 是 **CI 判定用的同一个输入**（`build-windows.yml` 按 tag 含不含 `-beta`
构建两个不同 productName 的软件）。按 tag 推导 = 与 CI 同源，不可能对不上。
读 `.env` 会引入**第二个**真源：`.env` 说 beta、tag 说正式时听谁的？
多一个能和 tag 打架的旋钮，就多一类"配置对了但发错了"的故障。

顺带：两个仓从此拿到**逐字节相同**的这份代码，merge 不再有东西可覆盖。
"""
from __future__ import annotations

import sys
from dataclasses import dataclass
from pathlib import Path

# 两条通道的落地事实。改这里 = 同时改 sync_appcast.py 与 publish-update.py。
_ROOT = Path("/root")


@dataclass(frozen=True)
class Channel:
    """一条更新通道 = 一个软件。beta 与正式的 productName / identifier 都不同。"""

    beta: bool
    #: 打印给人看的通道名，带对外路径，便于操作者当场核对
    label: str
    #: 安装包文件名的前缀。⚠️ beta 的 productName 是 "FilmWeaver Beta"（带空格），
    #: NSIS 产物名里是空格，但 **GitHub 上传 Release 资产时会把空格换成点**，
    #: 而这两个脚本用的都是**下载时/发布时**的名字，所以一律写点号版本。
    stem_prefix: str
    #: appcast 目录（安装包与 latest.json 的落地处）
    dir: Path
    #: 客户端读到的下载基址；必须与 tauri.conf.json 的 updater endpoint 同主机
    base_url: str

    def setup_name(self, ver: str) -> str:
        """`FilmWeaver.Beta_0.8.4_x64-setup.exe` / `FilmWeaver_0.8.4_x64-setup.exe`"""
        return f"{self.stem_prefix}_{ver}_x64-setup.exe"


BETA = Channel(
    beta=True,
    label="测试版(/fw → dev 后端 8002)",
    stem_prefix="FilmWeaver.Beta",
    dir=_ROOT / "filmweaver-data" / "appcast",
    base_url="http://118.196.33.51:9080/fw/media/appcast",
)

RELEASE = Channel(
    beta=False,
    label="正式版(/fwp → prod 后端 8003)",
    stem_prefix="FilmWeaver",
    dir=_ROOT / "filmweaver-prod-data" / "appcast",
    base_url="http://118.196.33.51:9080/fwp/media/appcast",
)


def is_beta_tag(tag: str) -> bool:
    """CI 的判据原样照搬：tag 里含 `-beta` 就是测试版。"""
    return "-beta" in tag


def version_of(tag: str) -> str:
    """`v0.8.4-beta.2` → `0.8.4`。tauri 的 version 是纯 x.y.z，不带前缀与后缀。"""
    return tag.lstrip("v").split("-")[0]


def channel_for(*, beta: bool) -> Channel:
    return BETA if beta else RELEASE


def channel_for_tag(tag: str) -> Channel:
    return channel_for(beta=is_beta_tag(tag))


def guard(ch: Channel) -> None:
    """落盘前的自检：拒绝把包写到对不上号的地方。

    两条断言各自拦一类事故：

    ① **目录与基址必须指向同一条通道。** 上面的常量是人写的，改错一处
       （比如把 RELEASE 的 dir 复制成 beta 的）不会有任何编译期报错，
       但会把正式包静默发进 beta 目录。这条把它变成当场失败。

    ② **目录必须已经存在，不 mkdir。** 原 `sync_appcast.py` 有一句
       `APPCAST.mkdir(parents=True, exist_ok=True)`。收敛成按 tag 推导之后，
       一个手滑的 tag（少打 `-beta`）会让脚本去**创建**
       `filmweaver-prod-data/appcast/` —— 那是往生产目录写东西。
       两个目录本来都存在，所以要求"必须已存在"不影响正常流程，
       只掐掉"因为拼错而凭空造出一条通道"这条路。
    """
    dir_is_prod = "filmweaver-prod-data" in str(ch.dir)
    url_is_prod = "/fwp/" in ch.base_url
    if dir_is_prod != url_is_prod or dir_is_prod == ch.beta:
        raise AssertionError(
            f"通道常量自相矛盾：beta={ch.beta} dir={ch.dir} base_url={ch.base_url}")
    if not ch.dir.is_dir():
        raise SystemExit(
            f"❌ appcast 目录不存在：{ch.dir}\n"
            f"   目标通道是「{ch.label}」。若 tag 打错了（正式版少写 -beta），"
            f"现在停下来是对的。\n"
            f"   确实要新建这条通道的话，请手动 mkdir 后重跑 —— "
            f"本脚本刻意不替你创建生产目录。")


# ---------------------------------------------------------------- self-test
def self_test() -> int:
    """表驱动自检：纯函数，不联网、不写盘。`python3 appcast_channel.py --self-test`

    这一节是这个文件唯一的"网"。它钉的是**映射本身**，不是写法：
    改常量值会红，改注释不会。
    """
    failed = 0

    def ok(cond: bool, msg: str, extra: str = "") -> None:
        nonlocal failed
        if not cond:
            failed += 1
        print(f"  {'✅' if cond else '❌'} {msg}" + (f"\n      {extra}" if not cond and extra else ""))

    print("① tag → 通道（与 CI build-windows.yml 同判据）")
    cases = [
        ("v0.8.4", False), ("v0.8.4-beta", True), ("v0.8.4-beta.2", True),
        ("v1.0.0", False), ("v0.10.0-beta", True),
    ]
    for tag, beta in cases:
        ok(is_beta_tag(tag) is beta, f"{tag} → {'beta' if beta else '正式'}")

    print("\n② tag → 版本号（去 v、去 -beta.N）")
    for tag, ver in [("v0.8.4", "0.8.4"), ("v0.8.4-beta", "0.8.4"),
                     ("v0.8.4-beta.2", "0.8.4"), ("v0.10.0", "0.10.0")]:
        got = version_of(tag)
        ok(got == ver, f"{tag} → {ver}", f"实际 {got}")

    print("\n③ 两条通道**处处不同**（同一个值出现在两条通道里就是复制粘贴事故）")
    ok(BETA.dir != RELEASE.dir, "★ appcast 目录不同",
       f"都是 {BETA.dir}")
    ok(BETA.base_url != RELEASE.base_url, "★ 下载基址不同",
       f"都是 {BETA.base_url}")
    ok(BETA.stem_prefix != RELEASE.stem_prefix, "★ 安装包名前缀不同")
    ok("/fw/" in BETA.base_url and "/fwp/" in RELEASE.base_url,
       "★ beta 走 /fw、正式走 /fwp",
       f"{BETA.base_url} / {RELEASE.base_url}")
    ok("filmweaver-prod-data" in str(RELEASE.dir)
       and "filmweaver-prod-data" not in str(BETA.dir),
       "★ 只有正式通道落在 filmweaver-prod-data（生产素材目录）")

    print("\n④ 产物名（GitHub 会把空格换成点，两个脚本用的都是这个名字）")
    ok(BETA.setup_name("0.8.4") == "FilmWeaver.Beta_0.8.4_x64-setup.exe",
       "beta 产物名带 .Beta", BETA.setup_name("0.8.4"))
    ok(RELEASE.setup_name("0.8.4") == "FilmWeaver_0.8.4_x64-setup.exe",
       "正式产物名不带 .Beta", RELEASE.setup_name("0.8.4"))
    ok(" " not in BETA.setup_name("0.8.4"),
       "★ beta 产物名里没有空格（有空格说明写成了本地 NSIS 名，Release 上找不到）")

    print("\n⑤ guard：自相矛盾的通道常量必须当场炸")
    bad = Channel(beta=True, label="伪造", stem_prefix="X",
                  dir=RELEASE.dir, base_url=BETA.base_url)   # beta 却指向生产目录
    try:
        guard(bad)
        ok(False, "★ dir 指向生产目录、却声称是 beta —— 应当拒绝", "guard 放行了")
    except AssertionError:
        ok(True, "★ dir 指向生产目录、却声称是 beta —— 已拒绝")
    except SystemExit:
        ok(False, "★ 应当先因自相矛盾而 AssertionError，而不是走到目录存在性检查")

    bad2 = Channel(beta=False, label="伪造", stem_prefix="X",
                   dir=BETA.dir, base_url=RELEASE.base_url)  # 正式却指向 beta 目录
    try:
        guard(bad2)
        ok(False, "★ 正式版指向 beta 目录 —— 应当拒绝", "guard 放行了")
    except AssertionError:
        ok(True, "★ 正式版指向 beta 目录 —— 已拒绝")
    except SystemExit:
        ok(False, "★ 应当先因自相矛盾而 AssertionError")

    print("\n⑥ 真实通道能通过 guard（两个目录都应已存在）")
    for ch in (BETA, RELEASE):
        try:
            guard(ch)
            ok(True, f"{ch.label} 通过")
        except SystemExit as e:
            ok(False, f"{ch.label} 未通过", str(e))

    if failed:
        print(f"\n❌ {failed} 项不通过")
        return 1
    print("\n✅ 通道映射自检通过")
    return 0


if __name__ == "__main__":
    if "--self-test" in sys.argv:
        sys.exit(self_test())
    print(__doc__)
