"""reconcile_location_assets.py — 把存量项目的场景资产收敛到归一名

## 为什么需要回填

场景资产（`Asset(kind="location")`）历史上是按 `Shot.location` **原值**建的，
而拆解会把剧本 slug 行整段抄进 location，于是同一个房间因为写法不同分裂成多行：

    「夜 内 楚家公馆-客厅」   有图
    「楚家公馆-客厅」         有图      ← 同一个客厅，两张不一样的图

后果有三：出片时两拨镜头拿到**不同的**客厅参考图，成片里同一个房间前后长得不
一样；补资产时把已经有图的房间当成缺图**重复生成**（多花一次钱）；场景轨里一个
房间占好几行。

代码侧已改成"资产按归一名存"（见 `scenes.ensure_location_asset`），但存量项目
里的旧行还在，不回填的话用户手上的项目一个都修不掉。

## 用法

    # 只看会改什么，不写库（默认）
    python3 backend/scripts/reconcile_location_assets.py
    python3 backend/scripts/reconcile_location_assets.py --project c4ac5414f04f

    # 真的写
    python3 backend/scripts/reconcile_location_assets.py --project c4ac5414f04f --apply

## 安全性

- 只改 `assets.name` 并**删除**归一后重复的那些行；不碰 `Shot.location`、
  不碰 `SceneAlias.raw_name`——镜头留在原名空间、资产在归一名空间，两者由别名
  表桥接，改原名等于把映射本身抹掉。（所以这里不能用 `rename_asset_everywhere`。）
- 合并只**补空位**：留存行没有图/描述时才从被删行取，绝不覆盖已有值
  （留存行的图可能是用户手工换过的）。
- 删除是**有损**的，务必先看 dry-run 输出确认要删的确实是重复行。
- 幂等：重复跑第二次输出为 0。
- 只作用于 dev 库（由 `FW_ENV` / `.env` 决定连哪个库）。对 prod 执行属于
  「改生产」，需要明示授权，本脚本不做任何特殊处理，请自行确认环境。
"""

import argparse
import sys

sys.path.insert(0, "/root/filmweaver-dev/backend")

from app.db import Asset, Project, get_session                      # noqa: E402
from app.scenes import canonical_of, reconcile_location_assets      # noqa: E402


def _preview(session, project_id: str) -> list[tuple[str, list[str]]]:
    """dry-run 用：按归一名分组，返回会被合并/改名的组。"""
    rows = (session.query(Asset)
            .filter(Asset.project_id == project_id,
                    Asset.kind == "location").all())
    groups: dict[str, list[Asset]] = {}
    for a in rows:
        cn = canonical_of(session, project_id, a.name) or (a.name or "").strip()
        if cn:
            groups.setdefault(cn, []).append(a)
    out = []
    for canon, items in sorted(groups.items()):
        if len(items) > 1 or items[0].name != canon:
            out.append((canon, [f"{a.name}{'[有图]' if a.image_url else '[无图]'}"
                                for a in items]))
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project", help="只处理这个项目 id；缺省 = 全部")
    ap.add_argument("--apply", action="store_true",
                    help="真的写库（含删除重复行）；不给就是 dry-run")
    args = ap.parse_args()

    with get_session() as s:
        q = s.query(Project)
        if args.project:
            q = q.filter(Project.id == args.project)
        projects = q.all()
        if not projects:
            print("没有匹配的项目")
            return 1

        total_groups = 0
        for proj in projects:
            pending = _preview(s, proj.id)
            if not pending:
                continue
            total_groups += len(pending)
            print(f"\n{proj.id}  {proj.title}")
            for canon, members in pending:
                print(f"  「{canon}」 ← {'、'.join(members)}")

            if args.apply:
                rec = reconcile_location_assets(s, proj.id)
                print(f"  → 改名 {rec['renamed']} 行，合并删除 {rec['merged']} 行"
                      + (f"：{'、'.join(rec['deleted'])}" if rec["deleted"] else ""))

        if args.apply:
            s.commit()
            print(f"\n已写入：共 {total_groups} 组场景收敛到归一名")
        else:
            print(f"\nDRY-RUN：共 {total_groups} 组会被改动（加 --apply 才真的写）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
