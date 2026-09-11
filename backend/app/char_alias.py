"""角色名归一（N2）——把同一个人的多种写法归到一个 canonical 名下。

## 为什么需要

场景侧有 `SceneAlias` + `canonicalize_scenes`，角色侧此前**没有对应机制**。
剧本本身就会给同一个人多种写法，拆解如实记录（这是对的），于是：

    '陆明' 208 镜  ←→  '少年陆明' 3 镜        同一人的少年时期
    '江卫东的秘书' 1 镜 ←→ '江卫东秘书' 1 镜    同一人的两种写法

不归一 → `AssetStage` 里「陆明」43 个阶段 +「少年陆明」3 个阶段被当成两个人
各画各的定妆图，同一个角色在少年戏与成年戏里长得毫不相干。

## ⚠️ 为什么判定必须走 LLM，不能用字面子串

实测这些名字对**字面高度相似但绝非同一人**：

    '陆明父亲'    ⊃ '陆明'      父子是两个人！
    '江卫东的秘书' ⊃ '江卫东'    秘书是另一个角色！
    '审查组长'    ⊃ '审查组'     组长是人，审查组是机构

按子串合并会把父子、上下级并成一个人——那不是"没优化"，是**数据损坏**：
两个角色从此共用一张脸，且用户很难反查到是归一干的。

所以：
1. 判定交给 LLM 做语义判断（同 `canonicalize_scenes` 的思路）
2. 提示词里把这些反例**明确列出来**，而不是指望模型自己想到
3. 归组保守——拿不准就不合并。少归一只是少省一次图，错归一是脸都换了
4. `source='manual'` 的行 AI 重跑时不覆盖，用户能纠正误判

## age_stage

归一到同一 canonical 后，`age_stage`（少年/青年/中年/老年）仍区分——
「少年陆明」与「陆明」是同一个人但长相不同，各自出图是**对的**。
这正好接上 Q1 人物档案里的年龄段：同一人不同人生阶段，用年龄段区分，
而不是当成两个人。
"""
from __future__ import annotations

import json
import logging
import uuid

from .db import CharacterAlias, Shot, get_session

log = logging.getLogger(__name__)

_SYS = (
    "你是剧本角色梳理员。下面给你一部剧里拆解出来的**角色名清单**（含出场镜头数）。"
    "请判断其中哪些名字指的是**同一个人**，把它们归并到一个标准名下。\n"
    "\n"
    "【必须合并的情况】\n"
    "- 同一人的不同人生阶段：「少年陆明」与「陆明」→ 标准名「陆明」\n"
    "- 同一人的不同写法：「江卫东的秘书」与「江卫东秘书」→ 择一为标准名\n"
    "- 带职务/称谓前缀的同一人：「保洁王阿姨」与「王阿姨」→「王阿姨」\n"
    "\n"
    "【⚠️ 绝对不能合并的情况——名字相似但是不同的人】\n"
    "- 亲属关系：「陆明父亲」**不是**「陆明」，是他爸，两个人\n"
    "- 从属关系：「江卫东的秘书」**不是**「江卫东」，是另一个角色\n"
    "- 人 vs 机构：「审查组长」是人，「审查组」是机构，不能合并\n"
    "- 同姓不同人：「张医生」与「张护士」是两个人\n"
    "拿不准就**不要合并**——少合并只是少省一张图，错合并会让两个角色共用一张脸。\n"
    "\n"
    "标准名取**出场最多、最简洁**的那个写法。\n"
    "对每个原始名还要判断它的人生阶段 age_stage："
    "少年/青年/中年/老年，判断不出就填 null。\n"
    "（「少年陆明」age_stage=「少年」，「陆明」若是成年戏填「中年」或 null）\n"
    "\n"
    "只输出确实需要归并的组（组内 ≥2 个原始名）。没有任何可归并的就返回空数组。\n"
    '严格输出 JSON：{"groups":[{"canonical":"陆明",'
    '"members":[{"raw":"陆明","age_stage":null},'
    '{"raw":"少年陆明","age_stage":"少年"}]}]}，只输出 JSON。'
)


def _parse_json(raw: str) -> dict:
    """容错解析（与 costumes._parse_json 同口径）。失败抛 ValueError。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


def collect_character_names(session, project_id: str) -> dict[str, int]:
    """该项目拆解出的全部角色名 → 出场镜头数。"""
    counts: dict[str, int] = {}
    for sh in session.query(Shot).filter(Shot.project_id == project_id).all():
        chars = sh.characters
        if isinstance(chars, str):
            try:
                chars = json.loads(chars)
            except (ValueError, TypeError):
                chars = []
        for c in (chars or []):
            if isinstance(c, str) and c.strip():
                counts[c] = counts.get(c, 0) + 1
    return counts


def canonical_character_map(session, project_id: str) -> dict[str, str]:
    """`{原始角色名: 归一名}`。没有映射的名字**不出现**在结果里。

    调用方按 `mapping.get(raw, raw)` 使用——查不到就用原名，
    保证没跑过归一的项目行为完全不变。
    """
    rows = (session.query(CharacterAlias)
            .filter(CharacterAlias.project_id == project_id).all())
    return {r.raw_name: r.canonical for r in rows if r.canonical}


def age_stage_map(session, project_id: str) -> dict[str, str]:
    """`{原始角色名: 人生阶段}`，未判定的不出现。"""
    rows = (session.query(CharacterAlias)
            .filter(CharacterAlias.project_id == project_id).all())
    return {r.raw_name: r.age_stage for r in rows if r.age_stage}


async def canonicalize_characters(project_id: str,
                                  model_id: str | None = None) -> dict:
    """跑一次角色名归一，结果写进 `character_aliases`。

    幂等：只更新 `source='ai'` 的行，人工改过的（`source='manual'`）保持不动。
    角色名 ≤1 个时直接返回，不浪费一次模型调用。

    返回 `{"groups": [...], "updated": n, "llm": bool}`。
    """
    from .providers.llm import LLMProvider

    with get_session() as session:
        counts = collect_character_names(session, project_id)
        manual = {r.raw_name for r in
                  session.query(CharacterAlias)
                  .filter(CharacterAlias.project_id == project_id,
                          CharacterAlias.source == "manual").all()}

    if len(counts) <= 1:
        return {"groups": [], "updated": 0, "llm": False}

    listing = "\n".join(f"- {n}（{c} 镜）"
                        for n, c in sorted(counts.items(), key=lambda kv: -kv[1]))
    try:
        llm = LLMProvider(model_id=model_id)
        raw = await llm.complete(_SYS, f"角色名清单：\n{listing}", temperature=0.0)
        groups = _parse_json(raw).get("groups") or []
    except Exception as e:  # noqa: BLE001 归一失败不阻断，退回"不归一"
        log.warning("[char_alias] 项目 %s 角色归一失败，退回不归一: %r", project_id, e)
        return {"groups": [], "updated": 0, "llm": False}

    updated = 0
    out_groups: list[dict] = []
    with get_session() as session:
        for g in groups:
            canon = (g.get("canonical") or "").strip()
            members = g.get("members") or []
            if not canon or len(members) < 2:
                continue
            # 归一名必须是清单里真实存在的名字——模型偶尔会造一个新名字出来
            if canon not in counts:
                log.info("[char_alias] 跳过：归一名 %r 不在角色清单里", canon)
                continue
            kept: list[dict] = []
            for m in members:
                raw_name = (m.get("raw") or "").strip() if isinstance(m, dict) else str(m).strip()
                if not raw_name or raw_name not in counts:
                    continue
                if raw_name in manual:
                    continue          # 人工映射不被 AI 覆盖
                age = (m.get("age_stage") or None) if isinstance(m, dict) else None
                row = (session.query(CharacterAlias)
                       .filter(CharacterAlias.project_id == project_id,
                               CharacterAlias.raw_name == raw_name).first())
                if row is None:
                    row = CharacterAlias(id=uuid.uuid4().hex[:12],
                                         project_id=project_id,
                                         raw_name=raw_name, canonical=canon,
                                         age_stage=age, source="ai")
                    session.add(row)
                else:
                    row.canonical, row.age_stage, row.source = canon, age, "ai"
                updated += 1
                kept.append({"raw": raw_name, "age_stage": age})
            if len(kept) >= 2:
                out_groups.append({"canonical": canon, "members": kept})
        session.commit()

    log.info("[char_alias] 项目 %s：归并 %d 组、%d 条映射",
             project_id, len(out_groups), updated)
    return {"groups": out_groups, "updated": updated, "llm": True}
