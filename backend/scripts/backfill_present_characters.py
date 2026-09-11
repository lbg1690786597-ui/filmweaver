"""backfill_present_characters.py — 给存量项目补上「在场推导」（L1.5，3.9）

## 为什么需要回填

`present_characters` 是 3.9 新增的列，只有**重新拆解**才会写。而用户手上的
项目都是早就拆好的——不回填的话，这些项目里"坐在旁边不说话的人会消失"
这个毛病一个都修不掉，用户会以为改动没生效。

## 用法

    # 只看会改什么，不写库（默认）
    python3 backend/scripts/backfill_present_characters.py
    python3 backend/scripts/backfill_present_characters.py --project 13fd3b2ba28e

    # 真的写
    python3 backend/scripts/backfill_present_characters.py --apply

## 安全性

- 只写 `shots.present_characters` 这一列，不碰 `characters`（拆解真值）、
  不碰 `ref_overrides`（人工增删）。人工 remove 依然压得住推导结果，
  见 `db.effective_characters`。
- 幂等：重复跑结果一致。
- 只作用于 dev 库（由 `FW_ENV` / `.env` 决定连哪个库）。对 prod 执行属于
  「改生产」，需要明示授权，本脚本不做任何特殊处理，请自行确认环境。
"""

import argparse
import sys

sys.path.insert(0, "/root/filmweaver-dev/backend")

from app.db import get_session, Project, Shot, effective_characters  # noqa: E402
from app.continuity import (continuous_runs,                          # noqa: E402
                            derive_present_characters,
                            parse_characters)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", help="只处理这个项目 id；缺省 = 全部")
    ap.add_argument("--apply", action="store_true",
                    help="真的写库；不给就是 dry-run")
    ap.add_argument("--verbose", action="store_true", help="逐镜打印")
    args = ap.parse_args()

    with get_session() as s:
        q = s.query(Project)
        if args.project:
            q = q.filter(Project.id == args.project)
        projects = q.all()
        if not projects:
            print("没有匹配的项目")
            return 1

        grand = 0
        for proj in projects:
            runs = [r for r in continuous_runs(s, proj.id) if len(r) >= 2]
            if not runs:
                continue
            changed = 0
            for run in runs:
                derived = derive_present_characters(run)
                for sh in run:
                    want = derived.get(sh.id, [])
                    import json as _json
                    new = _json.dumps(want, ensure_ascii=False) if want else None
                    if (sh.present_characters or None) == new:
                        continue
                    changed += 1
                    if args.verbose or len(projects) == 1:
                        own = parse_characters(sh.characters)
                        print(f"    #{sh.order} 「{sh.location}」 "
                              f"{'、'.join(own)}  +补入 {'、'.join(want) or '(清空)'}")
                    if args.apply:
                        sh.present_characters = new
            if changed:
                grand += changed
                print(f"  {proj.id}  {proj.title}：{len(runs)} 个连续段，"
                      f"{changed} 个镜头需要补充")

        if args.apply:
            s.commit()
            print(f"\n已写入：共 {grand} 个镜头")
        else:
            print(f"\nDRY-RUN：共 {grand} 个镜头会被改动（加 --apply 才真的写）")

        # 抽样核对最终注入集合
        if args.project and args.apply:
            print("\n最终注入集合（effective_characters，出片真正用的那个）：")
            for sh in (s.query(Shot).filter(Shot.project_id == args.project)
                       .order_by(Shot.order).limit(10)):
                print(f"    #{sh.order}: {'、'.join(effective_characters(sh))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
