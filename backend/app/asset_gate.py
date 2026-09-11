"""被用户删除的资产（墓碑）的**统一闸门**（用户 2026-09-09 需求 4）。

## 为什么删除必须是软的

用户的要求是「删掉的资产不该再在后面的生成过程中可见、被调用」。
`DELETE` 掉那一行做不到这件事——有四条路径会让它原地复活或继续花钱：

| # | 位置 | 它做了什么 |
|---|---|---|
| ① | `routes_v2` 拆解完成后的资产增量合并 | 剧本里还有这个角色 → 补一行 |
| ② | `scenes.ensure_location_asset` | 镜头还挂着这个场景名 → 补一行 |
| ③ | 资产 upsert（任何写入路径） | 按 name 找不到就新建 |
| ④ | `readiness.locations_no_image` | 从 **`Shot.location`** 算缺口、**根本不看资产表** → 真删之后依然报"缺图"，用户点一次「补齐」就又花钱把它画回来 |

前三条是"建回来"，第四条更糟：它不建行，但会**直接下单生图**。
所以判据不能是"资产表里有没有这一行"，必须是"用户有没有说过不要它"——
这就是墓碑 `Asset.deleted_at` 的作用。

## 语义边界（用户决策：「只断资产链，不动剧本」）

| | |
|---|---|
| **断掉** | 不再注入参考图、不计入缺图缺口、不被自动流程重建、资产页不显示、不再为它跑场景描述/形象档案 |
| **不动** | 镜头里该角色/场景**照旧存在**，剧本一个字不改，镜头不停用 |
| **保留** | 已生成的图与磁盘文件全在（`media` 的 GC 引用扫描**故意**不过滤墓碑），可 restore |

最后一条值得强调：`media._referenced_names` 扫的是"哪些文件还被引用"，
它必须**连墓碑一起扫**。过滤掉的话，用户删一个资产，下一次媒体清理就会把
那张图从磁盘上抹掉，restore 回来是一条指向 404 的记录——软删就白软了。

## 为什么不用 `Asset.disabled INTEGER`

`shots.disabled` 那个先例是"停用但保留"的开关，语义是用户随时来回切的。
这里要的是"删除"，时间戳能回答"什么时候删的"（列表里给用户看），
布尔值不能；而恢复同样只是把它置空，不损失任何能力。
"""
from __future__ import annotations

from .db import Asset


def alive(q):
    """给一个 `session.query(Asset)` 挂上"排除墓碑"的过滤。

    用法：`alive(session.query(Asset).filter(...))`。
    墓碑列是后加的，老库里全是 NULL，所以 `is_(None)` 对老数据天然为真。
    """
    return q.filter(Asset.deleted_at.is_(None))


def deleted_names(session, project_id: str, kind: str | None = None) -> set[str]:
    """该项目被用户删掉的资产名集合。

    给那些**不查资产表**的地方用——典型是 `readiness.locations_no_image`：
    它从 `Shot.location` 算缺口，只能拿这个集合去减。
    """
    q = (session.query(Asset.name)
         .filter(Asset.project_id == project_id, Asset.deleted_at.isnot(None)))
    if kind:
        q = q.filter(Asset.kind == kind)
    return {(n or "").strip() for (n,) in q.all() if (n or "").strip()}


def is_deleted(session, project_id: str, kind: str, name: str) -> bool:
    """这个名字的资产是不是被用户删掉了。"""
    n = (name or "").strip()
    if not n:
        return False
    row = (session.query(Asset.id)
           .filter(Asset.project_id == project_id, Asset.kind == kind,
                   Asset.name == n, Asset.deleted_at.isnot(None))
           .first())
    return row is not None
