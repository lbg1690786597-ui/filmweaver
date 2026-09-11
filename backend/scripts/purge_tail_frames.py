#!/usr/bin/env python3
"""purge_tail_frames.py — 清空已停用的 `Shot.tail_frame_url`，把磁盘腾出来

尾帧接力已于 2026-09-11 停用（见 `docs/DECISION-2026-09-11-尾帧接力停用.md`）。
停用时**刻意没有动存量数据**：列还在、277 条 URL 还在、`generated/tail_*.jpg`
还在盘上，因为删文件是不可逆操作，不该夹带在一次"停用功能"的改动里。

这个脚本就是那次留下的出口。它做两件事：

  1. 把 `shots.tail_frame_url` 全部置空（列本身保留，见决策文档"为什么列和文件都保留"）；
  2. 清空之后这些文件不再被 `media_refs.URL_COLUMNS` 认作"在用"，
     于是会在设置里的「清理缓存 → generated 孤儿」中被正常回收
     （受 24h 年龄窗保护，本脚本**不直接 unlink**）。

## 默认只报数

    cd backend && /usr/bin/python3 scripts/purge_tail_frames.py

真要执行才加 `--yes`：

    cd backend && /usr/bin/python3 scripts/purge_tail_frames.py --yes

⚠️ 这是**开发环境**脚本。要对生产库做同样的事属于"改生产"，需要明示授权，
并且要连着 `FW_ENV=prod` 的 .env 一起确认库路径 —— 本脚本不替你判断这件事，
它只认当前 `app.db` 解析出来的那个库。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.db import Shot, get_session  # noqa: E402
from app import media  # noqa: E402


def main() -> int:
    do_it = "--yes" in sys.argv[1:]
    with get_session() as s:
        rows = (s.query(Shot)
                .filter(Shot.tail_frame_url.isnot(None), Shot.tail_frame_url != "")
                .all())
        urls = [(r.tail_frame_url or "").strip() for r in rows]
        urls = [u for u in urls if u]

        total_bytes = 0
        missing = 0
        for u in urls:
            p = media._resolve_local(u)
            if p is None or not p.exists():
                missing += 1
                continue
            total_bytes += p.stat().st_size

        mb = total_bytes / 1024 / 1024
        print(f"库路径：{media.DATA_DIR}")
        print(f"存量历史尾帧行：{len(rows)}")
        print(f"其中文件仍在盘上：{len(urls) - missing} 个，共 {mb:.1f} MB"
              f"（另有 {missing} 条指向已不存在的文件）")

        if not do_it:
            print("\n（只报数，未改动任何数据。确认无误后加 --yes 执行。）")
            print("执行后这些文件不会被立刻删除，而是变成孤儿，"
                  "由设置里的「清理缓存」在 24h 年龄窗之后回收。")
            return 0

        for r in rows:
            r.tail_frame_url = None
        s.commit()
        print(f"\n✅ 已清空 {len(rows)} 行 shots.tail_frame_url。")
        print("下一步：在设置里跑一次「清理缓存 → generated 孤儿」把文件收回来"
              "（先用 dry_run 看清单）。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
