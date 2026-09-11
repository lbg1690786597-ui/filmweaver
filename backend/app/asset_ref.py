"""同角色跨造型保脸：解析「该角色已有的定妆图」用作图生图参考。

纯文生图会让同一个角色在不同造型/不同批次之间换脸。批量生成
（`jobs.run_asset_batch._gen_character`）早就按"先出基准图、其余阶段都喂它"
的规则串起来了，但**资产弹窗里手动点「✨ 生成」走的是另一条同步路径
（`POST /v2/assets/generate`），一直是裸文生图** —— 于是用户手动补的那张
和批量出的那批不是同一张脸。这里把判定抽成一份，两条路共用。
"""
from __future__ import annotations

from .db import Asset, AssetStage


def character_base_ref(session, project_id: str, character_name: str,
                       exclude_stage_ids: set[str] | None = None,
                       exclude_url: str | None = None) -> str | None:
    """返回该角色可用作参考的已有定妆图 URL；一张都没有则 None。

    优先级与 `run_asset_batch` 同口径：
    **其它造型阶段的图（取时间上最早的那个阶段）> 角色通用资产图**。

    `exclude_stage_ids` / `exclude_url` 用来排除"正在重新生成的这一张"——
    拿它自己当参考等于原地复制一版，而用户点重新生成就是想换一版。

    ⚠️ 角色被用户删掉（`Asset.deleted_at` 墓碑）时一律返回 None，**连造型阶段
    的图也不用**：用户说了不要这个角色，它的脸就不该再出现在任何新图里。
    单个造型阶段被删（`AssetStage.deleted_at`，2026-09-09 起）同理排除，
    只是粒度更细：角色还在，只是那一套造型不再当参考。
    """
    from . import asset_gate
    if asset_gate.is_deleted(session, project_id, "character", character_name):
        return None
    skip = exclude_stage_ids or set()
    # 被用户删掉的造型阶段也不能当基准脸：他删的正是"这一套不要了"，
    # 拿它的图去生成别的阶段等于把删掉的造型又带回画面里（stage_gate）。
    from . import stage_gate
    q = stage_gate.alive(
        session.query(AssetStage)
        .filter(AssetStage.project_id == project_id,
                AssetStage.character_name == character_name,
                AssetStage.image_url.isnot(None)))
    if skip:
        q = q.filter(AssetStage.id.notin_(skip))
    if exclude_url:
        q = q.filter(AssetStage.image_url != exclude_url)
    st = q.order_by(AssetStage.ep_from).first()
    if st is not None:
        return st.image_url

    aq = (session.query(Asset)
          .filter(Asset.project_id == project_id, Asset.kind == "character",
                  Asset.name == character_name, Asset.image_url.isnot(None)))
    if exclude_url:
        aq = aq.filter(Asset.image_url != exclude_url)
    a = aq.first()
    return a.image_url if a else None
