"""被用户删除的**造型阶段**（墓碑）的统一闸门（用户 2026-09-09 需求 2）。

## 为什么阶段删除也必须是软的

用户的原话是「阶段删除后似乎没有撤销删除的能力」。此前 `DELETE /stages/{id}`
是 `session.delete(st)` —— 一条硬删，误删一个已出定妆图的阶段就等于把那张图
彻底丢掉（磁盘文件还在，但没有任何记录指向它，用户在 UI 上再也找不到）。

而重跑「服装识别」**不等于**撤销：`jobs._plan_default_stages` 是按剧本重新
规划阶段，产出的是**新行、新 id、没有图**的阶段，要重新花钱生图，且名字/区间
都可能和用户删掉的那条不同。所以"重跑一遍就好了"这条退路根本不成立。

## 语义边界（与资产软删同一套，见 `asset_gate.py`）

| | |
|---|---|
| **断掉** | 不再注入参考图、不计入生图缺口/规划、资产页不显示、不能被合并/改区间 |
| **不动** | 镜头里该角色照旧存在，剧本一个字不改 |
| **保留** | 定妆图与磁盘文件全在（`media` 的 GC 引用扫描**故意**连墓碑一起扫），可 restore |

## 一条刻意的取舍：墓碑**不占**集区间

`_plan_default_stages` 用兄弟阶段已覆盖的集号算 `taken`，`patch_stage`/
`merge_stages` 用兄弟阶段判区间重叠。墓碑一律**不参与**这些判断——否则用户删掉
一个阶段后，那段集号依旧被"一个看不见的东西"占着，既建不了新阶段也调不了区间，
完全违背"我不想要它了"的本意。

代价是 restore 时可能与期间新建的阶段撞区间。那种情况下恢复会返回 409 并说清
和谁撞了，让用户先调区间——比"悄悄恢复出两套并存的造型、生图时随机选一个"好。
"""
from __future__ import annotations

from .db import AssetStage


def alive(q):
    """给一个 `session.query(AssetStage)` 挂上"排除墓碑"的过滤。

    用法：`alive(session.query(AssetStage).filter(...))`。
    墓碑列是后加的，老库里全是 NULL，所以 `is_(None)` 对老数据天然为真。
    """
    return q.filter(AssetStage.deleted_at.is_(None))


def alive_stages(session, project_id: str, character_name: str | None = None):
    """该项目（可选限定角色）在用的阶段行。"""
    q = alive(session.query(AssetStage)
              .filter(AssetStage.project_id == project_id))
    if character_name is not None:
        q = q.filter(AssetStage.character_name == character_name)
    return q.all()


def is_deleted(session, stage_id: str) -> bool:
    """这个阶段是不是被用户删掉了（指针行解析时用：不穿透已删的源）。"""
    if not stage_id:
        return False
    row = (session.query(AssetStage.id)
           .filter(AssetStage.id == stage_id,
                   AssetStage.deleted_at.isnot(None))
           .first())
    return row is not None
