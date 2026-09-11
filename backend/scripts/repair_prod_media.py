"""repair_prod_media.py — 把 prod 库引用、却被误写进 dev 目录的素材搬回来

## 背景

2026-08-28 拆 prod 时数据根目录做成了可配置项，但 `providers/image.py`
与 `providers/video.py` 各自留了一份硬编码的
`Path("…/filmweaver-data/generated")`（dev 的目录）。于是 2026-08-28 至
2026-09-01 之间，**生产用户生成的每一张图 / 每一条视频都落在了 dev 的
数据目录**，而库里存的 `/fw/media/generated/xxx.png` 由 prod 进程按自己的
data_dir 解析 —— 文件不存在，前端图全 404，出片时抛
`RuntimeError: 参考素材不可用`。

代码已在 2026-09-01 修好（统一走 `media.GENERATED_DIR`），但**历史数据仍是坏的**：
prod 库里那批 URL 指向的文件物理上躺在 dev 目录。本脚本把它们**复制**回来。

## 为什么是「复制」而不是「移动」

dev 环境同样在引用其中一部分文件（dev 自己生成的那些），而且两边的文件名
都是 uuid，无从判断某个文件到底是谁生成的 —— 唯一可靠的判据是
**prod 库有没有引用它**。所以：只按 prod 库的引用清单取，且只复制。
移动会把 dev 的素材抽走，属于"修一个坏另一个"。

## 安全性

- prod 库以 `mode=ro` 只读打开，**不写库**。
- 只往 `filmweaver-prod-data/generated/` 写，且**跳过已存在的文件**
  （绝不覆盖 prod 现有素材）。
- 不删除任何文件。
- `--dry-run` 只统计不落盘。

用法：
    python3 scripts/repair_prod_media.py --dry-run
    python3 scripts/repair_prod_media.py
"""
from __future__ import annotations

import collections
import re
import shutil
import sqlite3
import sys
from pathlib import Path

PROD_DB = Path("/root/filmweaver-prod/backend/filmweaver_prod.db")
PROD_GEN = Path("/root/filmweaver-prod-data/generated")
DEV_GEN = Path("/root/filmweaver-data/generated")

# 库里存的是 /fw/media/generated/xxx（公网前缀恒为 /fw，与环境无关，
# 由各自进程的 data_dir 解析回本地路径），也可能出现 /media/generated/xxx。
_REF = re.compile(r"/media/generated/([A-Za-z0-9_.\-]+)")

DRY = "--dry-run" in sys.argv


def collect_refs() -> set[str]:
    """扫全库所有文本列，收集被引用的 generated 文件名。

    不写死表名/列名：镜头、资产、项目、job.result 等多处都可能存 URL，
    漏一处就等于漏修一批素材。全表扫一遍代价可接受（库不大），且只读。
    """
    con = sqlite3.connect(f"file:{PROD_DB}?mode=ro", uri=True)
    refs: set[str] = set()
    tables = [r[0] for r in con.execute(
        "select name from sqlite_master where type='table'")]
    for t in tables:
        cols = [r[1] for r in con.execute(f'pragma table_info("{t}")')]
        for c in cols:
            try:
                rows = con.execute(
                    f'select "{c}" from "{t}" where "{c}" like ?',
                    ("%/media/generated/%",))
            except sqlite3.Error:
                continue  # 非文本列 / 虚表，跳过
            for (v,) in rows:
                if isinstance(v, str):
                    refs.update(_REF.findall(v))
    con.close()
    return refs


def main() -> None:
    if not PROD_DB.exists():
        sys.exit(f"prod 库不存在: {PROD_DB}")
    refs = collect_refs()
    print(f"prod 库引用的 generated 文件: {len(refs)}")

    present = {f for f in refs if (PROD_GEN / f).exists()}
    missing = refs - present
    recoverable = {f for f in missing if (DEV_GEN / f).exists()}
    lost = missing - recoverable

    print(f"  prod 目录已存在 : {len(present)}")
    print(f"  prod 目录缺失   : {len(missing)}")
    print(f"    └ dev 目录可找回: {len(recoverable)}")
    print(f"    └ 彻底丢失      : {len(lost)}")

    def by_prefix(names):
        return dict(collections.Counter(n.split("_")[0] for n in names))

    print(f"  可找回按前缀: {by_prefix(recoverable)}")
    if lost:
        print(f"  丢失按前缀  : {by_prefix(lost)}")
        for n in sorted(lost)[:10]:
            print(f"      {n}")

    total_bytes = sum((DEV_GEN / f).stat().st_size for f in recoverable)
    print(f"  待复制体积  : {total_bytes / 1048576:.1f} MB")

    if DRY:
        print("\n[dry-run] 未复制任何文件")
        return

    PROD_GEN.mkdir(parents=True, exist_ok=True)
    copied = failed = 0
    for f in sorted(recoverable):
        dst = PROD_GEN / f
        if dst.exists():          # 双保险：绝不覆盖 prod 现有素材
            continue
        try:
            # 先写临时名再 rename：中途失败不会在 prod 目录留下半截文件，
            # 而半截文件比"文件缺失"更难排查（前端拿到损坏图，不报 404）。
            tmp = dst.with_suffix(dst.suffix + ".partial")
            shutil.copy2(DEV_GEN / f, tmp)
            tmp.rename(dst)
            copied += 1
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  ✗ {f}: {e!r}")

    print(f"\n✅ 复制完成: {copied} 个成功, {failed} 个失败, "
          f"{len(lost)} 个无法找回")
    still = [f for f in refs if not (PROD_GEN / f).exists()]
    print(f"   复制后仍缺失: {len(still)}（即上面「彻底丢失」那批）")


if __name__ == "__main__":
    main()
