"""生产就绪度体检（「▶ 全部生成视频」前的二次确认弹窗数据源）。

## 为什么需要这个模块

「🎬 首帧精控」(i2va) 路线的流程链路比其它预设长一截：
资产定妆图 → 场景锚定图 → 每镜首帧图 → 首帧生视频。链路里一处
**静默失效点**，用户在 UI 上完全看不见：

视频模型不支持 i2va（如 H3 未配首帧工作流）时，`run_shot_videos` 会静默
回退全参考，只在 `shot_versions.meta.mode_fallback` 留一行记录。

本模块把这些隐患在**出片之前**一次性摊开，交给弹窗展示。纯只读，不写任何库。

## 一个必须如实说明的事实

后端**不会**因为"没首帧"而报错：`run_shot_videos._run_one` 会在生成视频前
自动补首帧。所以弹窗文案是"缺首帧的镜头将在生成时自动补"，而不是"会报错"。
唯一真会带着空首帧下发的路径：镜头高级设置里手动把 `generation_mode` 锁成
i2va 却没填首帧图（override 优先级最高，绕开了自动补那一支）——该情形归入
`warnings`。
"""
from __future__ import annotations

import json

from .db import (Asset, AssetStage, Project, Shot, effective_characters,
                 get_session)


def _override_of(shot: Shot) -> dict:
    try:
        return json.loads(shot.profile_override) if shot.profile_override else {}
    except (ValueError, TypeError):
        return {}


def _shot_gen_mode(shot: Shot, proj_gen_mode: str | None) -> str | None:
    """本镜最终生效的生成模式（镜头 override > 项目预设），与 jobs.py 同口径。"""
    return _override_of(shot).get("generation_mode") or proj_gen_mode


def compute_readiness(project_id: str) -> dict:
    """算出该项目的生产就绪度快照。

    复用既有能力，不另起查询口径：
    - 生成模式/图像模型 → `jobs._resolve_project_gen_settings`
    - 视频模型 → `jobs._resolve_project_video_model`
    - 分辨率档位 → `jobs._resolve_project_resolution`
    - 角色/场景集合 → `db.effective_characters` / `scenes.canonical_locations`
      （与实际注入同契约，避免"弹窗说齐了、注入时却少一张"）
    - i2va 能力 → `provider.mode_support()`
    """
    from .config import get_settings
    from .jobs import (_resolve_project_gen_settings, _resolve_project_resolution,
                       _resolve_project_video_model)
    from .providers.registry import registry

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            return {"error": "project not found"}
        gen_mode, image_model = _resolve_project_gen_settings(proj)
        video_model = (_resolve_project_video_model(proj)
                       or get_settings().video_model)
        # 生产检查弹窗要用它算"分辨率可选档位"（画幅决定档位表）
        base_aspect = proj.base_aspect or "9:16"
        # 新建项目时选的分辨率档位。必须回给前端，否则「本次参数」面板
        # 无从知道项目值是什么，只能默认显示列表第一项（1080p）——
        # 用户明明选的 720p，面板上却写着 1080p，那是在骗人。
        # 可能为 None：老项目 default_profile 里没有这一项，那就是"模型默认"。
        resolution = _resolve_project_resolution(proj)
        shots = (session.query(Shot).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        # 造型阶段：**排除用户删掉的**（`AssetStage.deleted_at` 墓碑，见 stage_gate）。
        # 不排的后果和资产墓碑一样：删掉的造型照旧报"缺定妆图"，用户点一次
        # 「补齐」就又花钱把它画回来了。
        from . import stage_gate
        stages = (stage_gate.alive(
                  session.query(AssetStage)
                  .filter(AssetStage.project_id == project_id))
                  .order_by(AssetStage.character_name, AssetStage.ep_from).all())
        # 资产：**排除用户删掉的**（`Asset.deleted_at` 墓碑，见 asset_gate 模块头）。
        # 只从这里排还不够——下面 used_locs / used_chars 是从 `Shot` 算的、
        # 根本不看资产表，所以还要拿 `_gone` 去减，否则删掉的场景照样报"缺图"，
        # 用户点一次「补齐」就又花钱把它画回来了。
        from . import asset_gate
        assets = asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id)).all()
        _gone = asset_gate.deleted_names(session, project_id)

        # ---- 镜头维度 ----
        # 与 run_shot_videos 一致：外部素材(is_special)与停用镜头都不送去生成
        active = [s for s in shots if not s.disabled and not s.is_special]
        need_video = [s for s in active if not s.video_url]

        # ---- 首帧维度 ----
        # 只统计"这一轮真会去生成视频"且走 i2va 的镜头（已出片的不再重跑）
        i2va_shots = [s for s in need_video
                      if _shot_gen_mode(s, gen_mode) == "i2va"]
        missing_frames: list[dict] = []
        locked_no_frame: list[int] = []   # 手动锁 i2va 但无首帧 → 真会报错的那条路径
        for s in i2va_shots:
            ov = _override_of(s)
            if s.first_frame_url or ov.get("first_frame_url"):
                continue
            missing_frames.append({"id": s.id, "order": s.order,
                                   "episode": s.episode, "location": s.location})
            if ov.get("generation_mode") == "i2va":
                locked_no_frame.append(s.order)

        # ---- 资产维度 ----
        # 按**全部有效镜头**统计（不是只按"本轮待生成"的镜头）。
        #
        # 原实现只看 need_video，于是"全部镜头都已出片"的项目算出来的资产缺口恒为 0：
        # 造型阶段明明缺图（比如重新识别出的「丝绸睡裙」变体一张图都没有），
        # 生产检查弹窗里既不提示、「🖼 先补齐资产图」按钮也不出现，一键成片的补资产
        # 环节同样跳过——用户在资产页只能一直看着"每个角色一张图"。
        # 资产库是否完整是**项目级**属性，跟"这一轮还剩几个镜头要出片"无关；
        # 首帧统计才该按本轮待生成的镜头算（已出片的不重跑），那部分保持不变。
        used_chars: set[str] = set()
        used_locs: set[str] = set()
        char_eps: dict[str, set[int]] = {}
        # 角色出现过的**归一场景**集合：判定"场景绑定服装对本项目是否有效"用它。
        # 场景绑定服装的判据是"人物再次进入这个场景"，与集号无关，所以不能沿用
        # char_eps 那套集区间判断（否则第 1 集建立的睡衣在第 10 集会被当成"缺图"，
        # 或反过来被算成缺口去重复出图）。
        from .scenes import canonical_locations, canonical_map, canonical_of
        # 复用已加载的 shots（B29）：原先 canonical_map 内部会**再查一遍**
        # 该项目全部镜头，1424 镜的项目等于把整张镜头表加载两遍。
        canon = canonical_map(session, project_id, shots=shots)
        char_scenes: dict[str, set[str]] = {}
        for s in active:
            cn = canon.get((s.location or "").strip(), (s.location or "").strip())
            for c in effective_characters(s):
                used_chars.add(c)
                char_eps.setdefault(c, set()).add(s.episode)
                if cn:
                    char_scenes.setdefault(c, set()).add(cn)
            # 归一后再收：场景资产是按归一名存的，这里若收原名，
            # 「夜 内 楚家公馆-客厅」会被算成一个"缺图场景"去重复出一张图
            # （而它和「楚家公馆-客厅」本就是同一个房间、已经有图了）。
            # 传 canon 进去是为了不逐名查库（B29），语义与出片链路上那次调用一致。
            for lc in canonical_locations(session, project_id, s, canon=canon):
                used_locs.add(lc)
        # 用户删掉的角色/场景不再计入缺口（需求 4）。放在收集之后统一减，
        # 而不是在循环里逐个判——循环里判会漏掉 char_eps / char_scenes 这些
        # 副产物，它们带着已删角色继续参与服装继承的判定。
        if _gone:
            used_chars -= _gone
            used_locs -= _gone
            for n in _gone:
                char_eps.pop(n, None)
                char_scenes.pop(n, None)

        # 角色通用定妆图（Asset kind=character）：阶段无图时 _auto_inject_refs 的回退项。
        # 资产页展示的就是这一层（每角色 1 张），阶段图是它的按集细分。
        char_generic = {a.name for a in assets
                        if a.kind == "character" and a.image_url}

        # 两趟扫描：先算出"哪些角色已有可注入的阶段图"，再据此判定每个缺图阶段
        # 到底是"只丢造型区分"还是"真的一张参考图都注入不到"。
        # （一趟扫不行：缺图的变体阶段常常排在它的基础阶段之前，单趟会把
        #  fallback 误判成 False，把"其实有基础定妆图兜着"的阶段报成红牌。）
        from .costumes import resolve_stage_image
        covered: set[str] = set()          # 有"可注入"阶段图的角色
        no_image: list[AssetStage] = []
        followers = 0                      # 指针行：共用源那张图，**不该再出图**
        scene_bound_n = 0

        def _relevant(st: AssetStage) -> bool:
            """本阶段对该项目是否"真的会被用到"（决定它缺图算不算缺口）。"""
            eps = char_eps.get(st.character_name, set())
            loc = (st.location or "").strip()
            if st.scene_bound and loc:
                # 场景决定型服装：只要该角色在**任何一集**进过这个归一场景就有效
                return loc in char_scenes.get(st.character_name, set())
            if loc:
                return (loc in char_scenes.get(st.character_name, set())
                        and any(st.ep_from <= e <= st.ep_to for e in eps))
            return any(st.ep_from <= e <= st.ep_to for e in eps)

        for st in stages:
            if st.character_name not in used_chars:
                continue
            if st.scene_bound and (st.location or "").strip():
                scene_bound_n += 1
            hit = _relevant(st)
            img = resolve_stage_image(session, st)
            if not st.image_url and st.source_stage_id:
                # 指针行：与源阶段是同一件衣服，注入时解析到源那张图。
                # 绝不能进 stages_no_image——那会让它被当成缺口去生成一张**新的**图，
                # 同一件衣服就长出两个样子（正是要消灭的不一致），还多花一次钱。
                followers += 1
                if hit and img:
                    covered.add(st.character_name)
                continue
            if not img:
                if hit:
                    no_image.append(st)
            elif hit:
                covered.add(st.character_name)

        def _stage_row(st: AssetStage) -> dict:
            return {"id": st.id, "character_name": st.character_name,
                    "stage_name": st.stage_name,
                    "ep_from": st.ep_from, "ep_to": st.ep_to,
                    "image_url": st.image_url,
                    "location": st.location,
                    "scene_bound": bool(st.scene_bound),
                    # True = 该角色另有可注入的图（同集基础阶段图 or 通用定妆图）
                    # → 仍能保人物一致，只是丢这一阶段特有的服装/妆容区分
                    "fallback": (st.character_name in char_generic
                                 or st.character_name in covered)}

        # 阶段无专属图（有图可回退时不阻断，仅丢造型区分）
        stages_no_image: list[dict] = [_stage_row(st) for st in no_image]

        # 真·无参考图的角色 = 既没有命中集区间的阶段图，也没有角色通用图。
        # 只有这一档才会让首帧退化成纯文生图（人物一致性无从谈起）。
        chars_no_asset = [
            {"name": n, "episodes": sorted(char_eps.get(n, set()))}
            for n in sorted(used_chars - covered - char_generic)
        ]
        # 场景资产名也要过一遍归一再比：老项目的资产行是按 Shot.location 原值
        # 建的（「夜 内 楚家公馆-客厅」），而 used_locs 已经是归一名。不归一就会
        # 把一个**已经有图**的房间报成缺图，去重复生成一张。
        loc_img = {c for c in (canonical_of(session, project_id, a.name)
                               for a in assets
                               if a.kind == "location" and a.image_url) if c}
        locations_no_image = sorted(used_locs - loc_img)

        # 「🖼 补齐缺失资产」真正会生成的图片张数。
        # 不能用 len(stages_no_image) + len(chars_no_asset)：识别跑过之后，
        # 一个角色的每套衣服都是一个缺图阶段，而这个角色**同时**也在
        # chars_no_asset 里（它一张图都还没有），两边把同一批图数了两遍
        # （实测「测试3」：24 个缺图阶段 + 8 个无图角色 = 报 32，实际只出 25 张）。
        # 无图角色只有在**没有任何阶段覆盖它的出场集**时才会额外补建一个
        # 「默认造型」阶段（jobs._plan_default_stages 会避开已被占用的集）。
        stage_eps: dict[str, set[int]] = {}
        for st in stages:
            stage_eps.setdefault(st.character_name, set()).update(
                range(st.ep_from, st.ep_to + 1))
        chars_need_stage = [
            r["name"] for r in chars_no_asset
            if set(r["episodes"]) - stage_eps.get(r["name"], set())
        ]
        assets_to_generate = (len(stages_no_image) + len(chars_need_stage)
                              + len(locations_no_image))

        # 花费闸门用的报数：要出几张图、免费复用几张
        costumes = {
            "stages_total": len(stages),
            # 识别是否跑过。没跑过时下面所有"要出几张图"的报数都不作数——
            # 它只等于"没有定妆图的角色数"，与剧情真正需要的服装套数无关。
            "scanned": bool(stages),
            "scene_bound": scene_bound_n,
            "followers": followers,          # 指针行：共用同一件衣服的图，不出图不花钱
            "to_generate": len(no_image),    # 真要花钱生成的张数
        }

    # ---- 模型能力（注册表在进程内，出 session 后查即可）----
    provider = registry.get_video(video_model)
    if provider is None:
        i2va_ok, i2va_reason = False, f"未注册的视频模型：{video_model}"
    else:
        sup = provider.mode_support().get("i2va", {})
        i2va_ok = bool(sup.get("available"))
        i2va_reason = None if i2va_ok else (sup.get("reason")
                                            or f"{video_model} 不支持首帧输入")

    # ---- 提示分级 ----
    # 必须区分「还没做」与「会出错」：此前全是纯字符串，前端只能一律渲染成红字，
    # 于是刚导入剧本点「AI 生产」满屏标红——而那些红字说的全是流程还没走到，
    # 不是故障。level 决定前端用灰/黄/红：
    #   info  = 流程未开始，属正常（用户照着流程走就会消失）
    #   warn  = 会自动降级但能跑完
    #   error = 真会失败，动手前该先处理
    warnings: list[dict] = []
    if not costumes["scanned"]:
        warnings.append({
            "level": "info",
            "text": "尚未识别全剧服装造型。这是流程的第 ② 步——跑一次（纯文本、"
                    "不出图、不花生图的钱）之后，资产报数才反映剧情真正需要的服装套数。",
            "action": "costume_scan",
        })
    if gen_mode == "i2va" and not i2va_ok:
        warnings.append({
            "level": "warn",
            "text": f"当前视频模型 {video_model} 不支持首帧输入"
                    f"（{i2va_reason}），本次将回退全参考路线",
            "action": None,
        })
    if locked_no_frame:
        orders = "、".join(f"#{o}" for o in locked_no_frame[:10])
        warnings.append({
            "level": "error",
            "text": f"{len(locked_no_frame)} 个镜头在「⚙ 高级设置」里被锁定为 i2va "
                    f"但没有首帧图（{orders}）：这类镜头会带着空首帧下发，"
                    f"很可能直接失败，建议先补首帧或解除锁定",
            "action": None,
        })

    return {
        "project_id": project_id,
        "generation_mode": gen_mode,
        "video_model": video_model,
        "image_model": image_model,
        "base_aspect": base_aspect,
        "resolution": resolution,
        "i2va_supported": i2va_ok,
        "i2va_reason": i2va_reason,
        "shots": {
            "total": len(shots),
            "active": len(active),
            "with_video": len(active) - len(need_video),
            "need_video": len(need_video),
        },
        "first_frames": {
            "mode_active": gen_mode == "i2va" or bool(i2va_shots),
            "required": len(i2va_shots),
            "ready": len(i2va_shots) - len(missing_frames),
            "missing": missing_frames,
        },
        "assets": {
            "stages_no_image": stages_no_image,
            "chars_no_asset": chars_no_asset,
            "locations_no_image": locations_no_image,
            # 无图角色里还需要额外补建「默认造型」阶段的（其余角色的缺口已经
            # 体现在 stages_no_image 里了，别重复计数）
            "chars_need_stage": chars_need_stage,
            # 「🖼 补齐缺失资产」点下去真会生成的图片张数（去重后的口径）
            "to_generate": assets_to_generate,
        },
        "costumes": costumes,
        "warnings": warnings,
    }
