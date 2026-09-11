"""场景文字描述生成（Q3）——把剧本里散落的空间线索汇成一段可用于生图的描述。

## 为什么不复用 costumes.py 的"逐集扫描"骨架

计划文档建议复用那套骨架，但实测数据否定了这个方向：

    '陆承宇办公室': 55 个镜头，跨 15 集
    '新家-客厅':   17 个镜头，跨  6 集

场景是**跨集稳定的物理空间**——同一个房间在第 5 集和第 40 集是同一个房间。
按集扫描会让同一个房间产出 N 份描述再去合并，正好重蹈 N1（服装碎片化）的覆辙：
同一件白大褂被 44 集各写一遍、字面永不相等、合并率≈0。

所以这里按**场景**分批：一个场景的所有镜头片段合在一起送一次，
天然得到一份统一描述，不存在"同一空间多份描述要合并"的问题。
顺带比逐集扫描省调用：115 个场景 ≈ 115 次，而逐集是 56 集 × 每集重复扫同样的房间。

## 描述里写什么

只写**镜头能拍到的物理事实**：空间类型、面积体量、主要陈设与材质、
光线来源与色温、时间感（日/夜）、新旧与整洁程度。

不写剧情、不写人物、不写情绪——那些是镜头级提示词的事，
混进场景参考图只会让模型往画面里加人（正是 Q4 要消除的问题）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re

from .db import Asset, Project, Shot, get_session

log = logging.getLogger(__name__)

#: 单个场景喂给模型的剧本片段上限。场景镜头多时截断——
#: 空间描述所需的信息在前几个镜头就够了，再多是剧情不是陈设。
_SCENE_TEXT_CAP = 3000

#: 一个场景最多取多少个镜头的片段。同上，防止 55 镜的办公室把上下文顶爆。
_MAX_SHOTS_PER_SCENE = 12

_SYS = (
    "你是影视美术指导。下面给你一部剧中**同一个场景**的若干镜头片段，"
    "请为这个场景写一段用于生成**场景参考图**的画面描述。\n"
    "\n"
    "只写镜头能拍到的**物理事实**：\n"
    "1. 空间类型与体量（如：约 40 平的独立办公室 / 狭窄的出租屋客厅）\n"
    "2. 主要陈设与材质（家具、器物、墙面地面的材质与颜色）\n"
    "3. 光线来源与氛围（自然光/人造光、方向、色温、明暗）\n"
    "4. 时间感与新旧程度（白天/夜晚、崭新/陈旧、整洁/杂乱）\n"
    "\n"
    "**严禁**写以下内容：\n"
    "- 任何人物、人影、人的动作或情绪（这是空镜头参考图，画面里不能有人）\n"
    "- 剧情、台词、事件（那些由镜头提示词负责，混进来会让模型往画面里加人）\n"
    "- 主观评价（如「压抑的」「温馨的」），只写造成这种感觉的**具体物象**\n"
    "\n"
    "长度 60~150 字，中文，一段话，不分点。剧本没写到的细节可以按该空间的"
    "常理补全（如「办公室」配办公桌与座椅），但不要编造剧本明确否定的东西。\n"
    '严格输出 JSON：{"description":"..."}，只输出 JSON。'
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


def strip_shot_prefix(name: str) -> str:
    """去掉场景名里混进来的镜号前缀（N3）。

    拆解偶尔把场记编号写进 `Shot.location`，于是资产名成了
    `'5-1 去医院的车内'`——同一个车内因为带不同镜号而分裂成多个资产。
    实测「错位的十二年」有 4 个这样的场景名。
    """
    return re.sub(r"^\s*\d+\s*[-–—]\s*\d+\s*", "", name or "").strip()


async def describe_one_scene(name: str, refs: list[str],
                             model_id: str | None = None) -> str | None:
    """为单个场景生成描述。失败返回 None（调用方保持原样，不阻断）。"""
    from .providers.llm import LLMProvider

    body = "\n---\n".join(refs)[:_SCENE_TEXT_CAP]
    if not body.strip():
        return None
    try:
        llm = LLMProvider(model_id=model_id)
        raw = await llm.complete(
            _SYS, f"场景名：{name}\n\n该场景的镜头片段：\n{body}",
            temperature=0.3)
        desc = (_parse_json(raw).get("description") or "").strip()
        return desc or None
    except Exception as e:  # noqa: BLE001 单场景失败不阻断整批
        log.warning("[scene_desc] 场景 %r 描述生成失败: %r", name, e)
        return None


async def generate_scene_descriptions(project_id: str,
                                      model_id: str | None = None,
                                      overwrite: bool = False,
                                      progress_cb=None) -> dict:
    """为项目的所有场景生成描述并写入 `Asset.prompt`（Q3）。

    `overwrite=False`（默认）时跳过已有描述的场景——用户手改过的描述
    绝不能被 AI 重跑覆盖掉（这是 A6 那次数据丢失的教训）。

    返回 `{"total","generated","skipped","failed"}`。
    """
    from .config import get_settings
    from .scenes import canonical_map, canonical_of, normalize_location

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise ValueError("project not found")
        shots = (session.query(Shot).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        # 现有场景资产：**归一名** → 是否已有描述。资产名也要过一遍归一：
        # 老项目那行叫「夜 内 楚家公馆-客厅」，不归一就当成"这个场景还没描述"，
        # 白跑一次模型再写出第二份说法不一样的描述。
        existing: dict[str, bool] = {}
        for a in session.query(Asset).filter(
                Asset.project_id == project_id,
                Asset.kind == "location").all():
            cn = canonical_of(session, project_id, a.name) or a.name
            existing[cn] = existing.get(cn, False) or bool((a.prompt or "").strip())
        canon = canonical_map(session, project_id, shots=shots)
        # 用户删掉的场景不再跑描述（需求 4）：跑了也没人用，纯粹白花一次 LLM。
        from . import asset_gate
        gone = asset_gate.deleted_names(session, project_id, "location")

    # 按场景归集镜头片段（不按集——见模块文档字符串）。
    # 用**归一名**归集：同一个房间在各集写法不同（「夜 内 楚家公馆-客厅」与
    # 「楚家公馆-客厅」），按原名归集会给一个房间写出两份互相打架的描述，
    # 且落库时建出两行资产、各出一张不一样的图。
    by_scene: dict[str, list[str]] = {}
    for sh in shots:
        raw = strip_shot_prefix(sh.location or "")
        if not raw:
            continue
        loc = (canon.get((sh.location or "").strip())
               or normalize_location(raw)[0] or raw)
        if len(by_scene.setdefault(loc, [])) < _MAX_SHOTS_PER_SCENE:
            by_scene[loc].append((sh.script_ref or "").strip())

    todo = [(n, refs) for n, refs in by_scene.items()
            if n not in gone and (overwrite or not existing.get(n, False))]
    total, done = len(todo), 0
    if not todo:
        return {"total": 0, "generated": 0, "skipped": len(by_scene), "failed": 0}

    # 并发用**既有**的 default_concurrency，不新增也不下调任何并发数（并发铁律）
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    results: dict[str, str] = {}
    failed = 0

    async def _one(name: str, refs: list[str]) -> None:
        nonlocal done, failed
        async with sem:
            desc = await describe_one_scene(name, refs, model_id)
        if desc:
            results[name] = desc
        else:
            failed += 1
        done += 1
        if progress_cb:
            try:
                progress_cb(done, total)
            except Exception:  # noqa: BLE001 进度回调异常不该影响生成
                pass

    await asyncio.gather(*[_one(n, r) for n, r in todo])

    # 落库：没有资产行的场景要补建，否则描述写不进去
    from .scenes import ensure_location_asset
    with get_session() as session:
        for name, desc in results.items():
            ensure_location_asset(session, project_id, name).prompt = desc
        session.commit()

    log.info("[scene_desc] 项目 %s：%d 个场景生成描述，%d 个失败，%d 个已有描述跳过",
             project_id, len(results), failed, len(by_scene) - total)
    return {"total": total, "generated": len(results),
            "skipped": len(by_scene) - total, "failed": failed}


#: 每个项目一把锁：同一项目的多条链路（补资产图 / 预生成提示词 / 出片）
#: 都会调 `ensure_scene_descriptions`，不加锁会并发跑同一批场景、重复花钱。
_ENSURE_LOCKS: dict[str, asyncio.Lock] = {}


async def ensure_scene_descriptions(project_id: str,
                                    model_id: str | None = None) -> dict:
    """**幂等**地补齐场景描述；失败只记日志，绝不抛异常。

    ## 为什么要有这一层

    `generate_scene_descriptions` 只挂在 `POST /projects/{id}/scenes/describe`
    上，而**全库没有任何调用方**（前端没有按钮、后端没有链路调它）。
    实测项目「912」4 个场景资产的 `Asset.prompt` 全是 NULL，后果有两处：

    1. 场景参考图退化成只报场景名（`asset_prompt.scene_prompt` 的降级分支）；
    2. 更要紧的是 `_auto_inject_refs_detailed` 的 notes 取的就是 `Asset.prompt`，
       为空时该场景落进 `_build_prompt_ctx` 的 `blind` 兜底——**优化器对这个
       空间一无所知**，于是每镜自行发明陈设：同一个「半岛酒店顶楼餐厅」被写成
       「豪华高档的豪门会客室 + 大理石茶几」「璀璨水晶吊灯」「高档餐厅包厢」。
       这正是用户报的「同一场景下桌子外观多次偏移」。

    所以把它接进出图/出片/提示词三条链路（都在**用**描述的地方就地补齐），
    而不是指望用户先去点一个不存在的按钮。

    幂等来源：`overwrite=False` 会跳过已有描述的场景，全都有描述时直接返回、
    一次 LLM 调用都不发。因此可以在每条链路开头无条件 await。
    """
    lock = _ENSURE_LOCKS.setdefault(project_id, asyncio.Lock())
    async with lock:
        try:
            seen = await _describe_from_existing_images(project_id)
        except Exception as e:     # noqa: BLE001
            log.warning("[scene_desc] 项目 %s 视觉反推场景描述失败：%s",
                        project_id, e)
            seen = 0
        try:
            out = await generate_scene_descriptions(project_id, model_id=model_id,
                                                    overwrite=False)
        except Exception as e:  # noqa: BLE001 补描述失败不能挡住出图/出片
            log.warning("[scene_desc] 项目 %s 场景描述补齐失败，按无描述继续: %r",
                        project_id, e)
            return {}
        if out.get("generated"):
            log.info("[scene_desc] 项目 %s 就地补齐 %s 个场景描述", project_id,
                     out.get("generated"))
        if seen:
            out = {**out, "from_image": seen}
        return out


async def _describe_from_existing_images(project_id: str) -> int:
    """**已经有图**却没有描述的场景：改成看图反推，而不是照剧本另写一份。

    ## 为什么要分这一路

    描述与参考图必须说同一件事。正常顺序是"先有描述→按描述出图"，两者同源。
    但老项目的场景图是在**没有描述**的年代出的（`scene_prompt` 只拿到一个
    场景名），此时若按剧本补一份描述，就会凭空造出第二个事实：
    描述写「黑色大理石餐桌」而图里是木质圆桌——提示词锚到文字、参考图给的是
    另一张桌子，反而比没有描述更糟。

    所以：**有图的走视觉反推**（文字对齐图），没图的才按剧本写
    （随后图按这份文字生成）。

    ⚠️ 这是一条**后台批量回填**路径，不在任何交互链路上——反推一张图要 ~8s。
    角色侧曾把同样的反推挂在换图/上传的请求里，把"传一张图"拖成几十秒且整页
    锁死，已于 2026-09-10 摘除，见 `vision_desc` 模块 docstring。

    返回反推成功的场景数。失败只记日志，剩下的交给按剧本生成那一路。
    """
    from .vision_desc import derive

    from . import asset_gate
    with get_session() as session:
        todo = [(a.id, a.name, a.image_url) for a in asset_gate.alive(
            session.query(Asset).filter(
                Asset.project_id == project_id, Asset.kind == "location",
                Asset.image_url.isnot(None))).all()
            if not (a.prompt or "").strip()]
    if not todo:
        return 0

    from .config import get_settings
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    got: dict[str, str] = {}

    async def _one(aid: str, name: str, url: str) -> None:
        async with sem:
            desc = await derive(url, kind="location")
        if desc:
            got[aid] = desc
        else:
            log.warning("[scene_desc] 场景 %r 已有图但视觉反推失败，"
                        "回退按剧本生成描述", name)

    await asyncio.gather(*[_one(i, n, u) for i, n, u in todo])
    if got:
        with get_session() as session:
            for aid, desc in got.items():
                a = session.get(Asset, aid)
                # 只填空的：手写描述（非 AUTO_PREFIX）在上面已被 todo 排除，
                # 这里再挡一次并发写入的竞态。
                if a is not None and not (a.prompt or "").strip():
                    a.prompt = desc
            session.commit()
        log.info("[scene_desc] 项目 %s：%d 个已有图的场景按图反推出描述",
                 project_id, len(got))
    return len(got)
