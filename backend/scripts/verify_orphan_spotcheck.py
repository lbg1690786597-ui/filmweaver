"""verify_orphan_spotcheck.py — 「清理缓存」删除清单的独立交叉抽查

## 与 audit_probe.py 的分工（为什么需要两个脚本）

`audit_probe.py` 断言的是"`URL_COLUMNS` 每一列的 URL 都进了引用集"——它拿
`URL_COLUMNS` 当判据，所以**测不出 `URL_COLUMNS` 自己漏了一列**。而漏列
恰好就是 S1 的原始病根（2026-09-11 实测漏了 4 处，其中 80 张生图候选图、
150 MB 已经进了删除清单）。

本脚本换一条完全独立的路子：从删除清单里随机抽 10 个文件，用 sqlite 直连，
对**每张表的每一列**跑 `CAST(col AS TEXT) LIKE '%文件名%'`。不 import
`media_refs` 的任何列定义，所以即便清单本身漏列也会暴露出来。

## 唯一的白名单：`jobs` 的历史日志

`Job.result` 绝大多数 kind 只是**已完成任务的留痕**（`first_frames` 记着当时
产出的首帧、`shot_videos` 记着逐镜明细……）。界面上没有任何路径能翻回去看：
前端唯一读 `job.result` 的地方（`useProdJobs.warnFrameIssues`）只取
`bare_shots` / `blocked_shots` 两个数字数组。把这些 URL 算成引用，就等于把
每一张被替换掉的旧图永久钉在磁盘上，清理缓存再也释放不了空间。

**唯一的例外是 `asset_candidates`**：它的 `result.urls` 有专门的回看端点
（`GET /v2/assets/candidates`），资产弹窗打开时会把上次那几张候选重新摆出来
接着挑，而候选图不落资产表。所以本脚本对 `jobs.result` 的命中要再判一次
kind —— 是 `asset_candidates` 就算**活引用**（红），其余算历史日志（绿）。

运行：/usr/bin/python3 scripts/verify_orphan_spotcheck.py [抽查个数]
      （cwd = backend/；仓内 .venv 陈旧，必须用 /usr/bin/python3）
退出码非 0 = 清单里有仍被引用的文件，**别让用户点「清理缓存」**。
"""

import glob
import os
import random
import sqlite3
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app import media  # noqa: E402
from app.media_refs import _candidate_urls  # noqa: E402

#: 固定种子：同一个库反复跑抽到同一批文件，改完代码前后可直接对比。
#: 想换一批就传第二个参数当种子。
SEED = 20260911


def live_candidate_hit(cur, filename: str) -> bool:
    """该文件是否出现在某个 `asset_candidates` 任务的候选图列表里。"""
    rows = cur.execute(
        "SELECT kind, result FROM jobs WHERE CAST(result AS TEXT) LIKE ?",
        [f"%{filename}%"]).fetchall()
    return any(filename in u
               for kind, res in rows if kind == "asset_candidates"
               for u in _candidate_urls(res))


def main() -> int:
    n_sample = int(sys.argv[1]) if len(sys.argv) > 1 else 10
    seed = int(sys.argv[2]) if len(sys.argv) > 2 else SEED

    dbs = glob.glob("*.db")
    if not dbs:
        print("❌ 当前目录没有 .db 文件——请在 backend/ 下运行")
        return 1
    con = sqlite3.connect(dbs[0])
    cur = con.cursor()
    tables = [r[0] for r in cur.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%'")]

    # 注意参数是 `older_than_days`（"只清早于 N 天的"），**不是**最小年龄。
    # `GENERATED_ORPHAN_MIN_AGE_H`（24h）那道保险是硬写在函数里的、摘不掉，
    # 所以这里拿到的就是用户此刻点「清理缓存」会真删的那批文件 —— 正是要抽查的对象。
    files, nbytes = media._scan_generated_orphans(0)
    if not files:
        print("✅ 删除清单是空的，没什么可抽查")
        return 0
    sample = random.Random(seed).sample(files, min(n_sample, len(files)))

    print(f"清单 {len(files)} 个 / {nbytes / 1024 / 1024:.1f} MB，"
          f"随机抽 {len(sample)} 个（种子 {seed}），"
          f"逐一扫 {len(tables)} 张表的每一列：\n")

    bad = 0
    for p in sample:
        live: list[str] = []      # 活引用——删了就是数据丢失
        benign: list[str] = []    # 历史日志——删了只是某个 job 的留痕链接 404
        for t in tables:
            for c in [r[1] for r in cur.execute(f'PRAGMA table_info("{t}")')]:
                n = cur.execute(
                    f'SELECT COUNT(*) FROM "{t}" WHERE CAST("{c}" AS TEXT) LIKE ?',
                    [f"%{p.name}%"]).fetchone()[0]
                if not n:
                    continue
                if t == "jobs" and c in ("result", "payload"):
                    (live if live_candidate_hit(cur, p.name)
                     else benign).append(f"{t}.{c}×{n}")
                else:
                    live.append(f"{t}.{c}×{n}")
        if live:
            bad += 1
            print(f"  ❌ {p.name:36s} 活引用 {live}")
        else:
            tail = f"（仅历史日志 {benign}）" if benign else "（全库 0 处提及）"
            print(f"  ✅ {p.name:36s} 无活引用{tail}")

    print()
    if bad:
        print(f"❌ 抽查：{len(sample) - bad}/{len(sample)} 确属孤儿，"
              f"{bad} 个仍被引用。\n"
              "   在把对应列补进 media_refs.URL_COLUMNS 之前，"
              "**不要让用户点「清理缓存」**。")
        return 1
    print(f"✅ 抽查：{len(sample)}/{len(sample)} 在全库任何表任何列都查不到活引用，"
          f"确属孤儿（库 {dbs[0]}，扫了 {len(tables)} 张表）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
