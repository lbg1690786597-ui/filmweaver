"""/v2 编排 API。MVP：项目管理 + 剧本优化/拆解（走 LLM Provider，文本通道可实测）。"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import hashlib
import json
import logging
import uuid
from typing import NamedTuple, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import case, func

from .providers.registry import registry
from .providers.llm import LLMProvider
from .providers.image import ImageProvider
from .db import (Asset, AssetStage, Job, Project, Shot, ShotVersion, get_session,
                 reset_clip_window)
from .script_import import smart_split_chapters
from . import drama_timing
from . import project_purge                # 项目彻底删除：独占文件计算 + 清盘
from . import stale as stale_mod          # 过期原因与消解规则（单一真源）
from . import style_preset as _sp         # 生产模式 × 画风预设（单一真源）
from . import asset_gate                  # 被用户删除的资产（墓碑）闸门
from . import stage_gate                  # 被用户删除的造型阶段（墓碑）闸门
from .continuity import refresh_present_characters

router = APIRouter(prefix="/v2", tags=["v2"])
logger = logging.getLogger(__name__)

# 分辨率档位 → megapixels（H3 工作流 #115 ResolutionSelector 按 比例+MP 推导实际宽高，
# 对齐 32 倍数；映射经 resolution_for() 验证：9:16 下 480p=480x864 / 720p=736x1280 /
# 1080p=1088x1920 / 2K=1440x2560）。veo 通道固定输出，忽略此设置。
# 显存包线（RUNNINGHUB-MINIMAX-H3.md 实测）：2MP 仅 ≤3s 安全、1MP ≤8s；2K 更严。
RESOLUTION_TIERS: dict[str, float] = {
    "480p": 0.4, "720p": 0.9, "1080p": 2.0, "2k": 3.5,
}


def shot_seconds_cap(profile: dict | None) -> tuple[float, float | None]:
    """项目档案 → (单镜时长上限秒, 分辨率MP)。拆镜与回写时长的**唯一**来源。

    上限**由项目选定的视频模型自己说了算**，因为不同模型的约束根本不同：
      · RunningHub H3 —— 受我们这边的显存 MP·s 预算约束，**随分辨率变化**：
        0.5MP 能出 40s、2.0MP 只有 8s。
      · seedance —— 厂商侧硬钳 1~15s，与分辨率无关。
      · veo —— 固定只出 8s。

    ⚠️ 不能把 H3 的显存包线套到 seedance/veo 上：那是 RunningHub 的
    GPU 约束，跟火山/网关通道毫无关系。套上去会让 1080p 的 seedance 被
    误砍到 7.5s（它实际能出 15s），白白多切一倍镜头。

    超上限不会报错，这是危险之处：seedance 静默钳到 15s，而旁白音频仍是
    完整长度 —— 画面早停、声音还在响，用户看到"对不上"却查不出原因。

    模型未知/未指定（老项目档案）时退回按分辨率算的 H3 包线——
    H3 是默认视频模型，这个兜底与实际最可能用的通道一致。
    """
    from .script_import import max_narration_sec, with_headroom
    prof = profile or {}
    mp = RESOLUTION_TIERS.get(str(prof.get("resolution") or "").lower())

    model = str(prof.get("video_model") or "").strip()
    if model:
        p = registry.get_video(model)
        if p is not None:
            raw = p.max_seconds(mp)
            if raw and raw > 0:
                return with_headroom(raw), mp
    return max_narration_sec(mp), mp


def profile_of(proj) -> dict:
    """Project.default_profile（JSON 字符串列）→ dict，坏数据一律当空档案。"""
    try:
        prof = json.loads(proj.default_profile) if (proj and proj.default_profile) else {}
    except (ValueError, TypeError):
        return {}
    return prof if isinstance(prof, dict) else {}


def narration_max_chars(proj, video_model: str | None = None) -> int | None:
    """解说剧单镜 `script_ref` 的字数上限；非解说剧返回 None（不设限）。

    解说剧的镜头时长 = 旁白朗读时长，而旁白能读多久由视频模型的上限决定
    （720p 海螺 H3 只有 19.1s）。拆镜提示词按"7-15 秒视频"设计，一镜拆出
    116 字要读 26 秒——**读不完**，声音会盖到下一镜上。所以解说剧必须把这个
    字数上限带进拆解，让镜头一开始就切得足够细。

    字数用**最慢**语速反推（见 `_CHARS_PER_SEC_SLOW`）：算上限时假设读得慢，
    最坏情况刚好贴线；用均值反推会让慢段超出包线。

    `video_model`：一键成片会显式指定本次要用的视频模型，可能与项目档案里
    存的不同；给了就以它为准，否则用档案里的。
    """
    if (getattr(proj, "production_mode", None) or "") != "narration":
        return None
    from .script_import import _CHARS_PER_SEC_SLOW
    prof = dict(profile_of(proj))
    if video_model:
        prof["video_model"] = video_model
    cap, _mp = shot_seconds_cap(prof)
    # 兜底下限 20 字：再紧的上限也不该把镜头切成没法看的碎句；
    # 真出现这种档案（超高分辨率）说明该项目本就不适合做解说剧。
    return max(20, int(cap * _CHARS_PER_SEC_SLOW))


def breakdown_shot_cap(proj, video_model: str | None = None) -> float | None:
    """真人剧拆镜时「一个镜头最长能多少秒」；拿不到模型信息返回 None（用历史窗口）。

    与 `narration_max_chars` 是**同一个问题的两种口径**：
      · 解说剧的镜头长度由旁白读多久决定 → 把上限换算成字数（那个函数）
      · 真人剧没有旁白，镜头长度就是下发给视频模型的时长 → 直接用秒数（本函数）
    两边都必须问模型要上限，因为它们的答案差了一倍：seedance-2.0 是 15s，
    2.5 是 30s。以前真人剧这条路径**根本没问**，写死 7-15 秒，于是选了 2.5 的
    项目照样被拆成 8-12 秒一镜——2.5 唯一的优势（单镜 30s 长镜）被拆解阶段扔掉了。

    ⚠️ 这里**不扣** `with_headroom` 的 2 秒安全余量。那 2 秒是给 TTS 语速波动留的
    （旁白比预估读得慢就会越过显存包线），真人剧没有旁白这个变量；时长是直接
    下发给视频模型的参数，贴着厂商硬钳走是安全的（超了才会被静默钳掉）。

    ⚠️ 只认**厂商硬钳**（`max_seconds(None)`：与分辨率无关的固定上限），
    不认 H3 那种**随分辨率变的显存包线**（它 `max_seconds(None)` 返回 None）。
    两者性质不同：前者是"这个模型天生就能一镜出这么长"，是创作口径；
    后者是"我们这台机器在这个分辨率下扛得住多久"，是资源口径。
    拿显存包线当创作目标会让 480p 的 H3 项目突然按 38-47 秒一镜去拆——
    那不是用户选分辨率时想要的，也没有任何实拍依据。

    `video_model`：一键成片会显式指定本次的视频模型，给了就以它为准。
    """
    if (getattr(proj, "production_mode", None) or "") == "narration":
        return None                     # 解说剧走 narration_max_chars，不用秒数口径
    prof = dict(profile_of(proj))
    if video_model:
        prof["video_model"] = video_model
    model = str(prof.get("video_model") or "").strip()
    if not model:
        return None
    p = registry.get_video(model)
    if p is None:
        return None
    raw = p.max_seconds(None)           # None = 只问厂商硬钳，不问显存包线
    return float(raw) if raw and raw > 0 else None


#: 拿不到模型信息时，镜头时长的兜底上限（15s = seedance-2.0 / 老档案的口径）。
_SHOT_DUR_CEIL_FALLBACK = 15.0


def shot_duration_ceiling(proj) -> float:
    """时间轴上单个镜头**允许被设成**的最长秒数。

    必须跟着项目选定的视频模型走，不能写死 15：
      · seedance-2.5 一镜 30s —— 写死 15 的话，拆解好好地给出 28s 的长镜，
        用户在时间轴上随手拖一下裁剪手柄，这一镜就被砍成 15s。用户看到的是
        "我明明只想微调，它自己少了一半"，且没有任何提示。
      · 解说剧的 H3 在 0.5MP 下能出 38s（时长由 TTS 实测长度回写），
        同样会被 15 的钳制截断，画面早停而旁白还在响。
    拿不到模型/档案（老项目）时退回 15，与本改动之前一致。

    只**放宽**、绝不收紧：结果永远 ≥15。H3 在 1080p 下的显存包线只有 9.5s，
    直接拿它当上限会让存量项目里已经存在的 15s 镜头再也调不回去——
    那是个体验倒退，且与"本次只为 2.5 松绑"的目标无关。
    """
    cap = None
    prof = profile_of(proj)
    model = str(prof.get("video_model") or "").strip()
    if model:
        p = registry.get_video(model)
        if p is not None:
            mp = RESOLUTION_TIERS.get(str(prof.get("resolution") or "").lower())
            raw = p.max_seconds(mp)
            if raw and raw > 0:
                cap = float(raw)
    return max(_SHOT_DUR_CEIL_FALLBACK, cap) if cap else _SHOT_DUR_CEIL_FALLBACK


# 生产模式 → 默认视频模型（契约 C3；前端拉取，不硬编码）。
# defaults 供前端"点预设→定位全部选项"联动；用户改任一项则前端归入 custom。
PRODUCTION_MODES: dict[str, dict] = {
    # 2026-08 重构：生产模式从「技术参数预设」退化为「配音策略」。
    # 视频模型/分辨率/生成方式改为在创建项目时独立选择（存入 default_profile）；
    # production_mode 只决定 TTS 配音的分配策略。
    #
    # drama（真人剧）：人物台词 → 人物配音，旁白 → 旁白配音。
    #   与以前的所有逻辑相同，仅标签变化。
    #   旧值 fast/consistent/premium/first_frame/custom 在迁移时全部映射到 drama。
    "drama":     {"label": "🎭 真人剧"},
    # narration（解说剧）：整段剧本（含对白）→ 旁白 TTS 流水，画面静音。
    #   剧本文字按句子边界切分到各镜头，TTS 合成后镜头时长跟旁白实际时长走。
    "narration": {"label": "📖 解说剧"},
    # anime（动漫剧，2026-09-09 新增）：配音策略**与真人剧完全相同**（用户决策
    #   「按真人剧那套（音画一体）」），区别只在画风——它选的是 style_preset 里
    #   的动漫三档。所以它在这张表里没有任何独有的技术参数。
    #   ⚠️ 动漫三档目前全部未启用，`list_production_modes` 会把这个模式标成
    #   enabled=false，前端列出但点不动。
    "anime":     {"label": "🎨 动漫剧"},
}

# 旧预设的技术参数，供迁移期间兜底读取（新项目不走这里）
_LEGACY_DEFAULTS: dict[str, dict] = {
    "fast":        {"video_model": "minimax-h3-ref2v", "image_model": "gpt-image-2",
                    "generation_mode": "full_reference", "resolution": "720p"},
    "consistent":  {"video_model": "minimax-h3-ref2v", "image_model": "gpt-image-2",
                    "generation_mode": "full_reference", "resolution": "1080p"},
    "premium":     {"video_model": "seedance-2.0",     "image_model": "gpt-image-2",
                    "generation_mode": "full_reference", "resolution": "1080p"},
    "first_frame": {"video_model": "seedance-2.0",     "image_model": "nano-banana-pro",
                    "generation_mode": "i2va",           "resolution": "1080p"},
    "custom":      {},
}


@router.get("/production-modes")
def list_production_modes() -> dict:
    """生产模式 + 每个模式下的**画风**清单（前端不硬编码任何一项）。

    模式的 label 在本文件（`PRODUCTION_MODES`），画风与可用性在
    `style_preset`（唯一事实来源）。这里把两边合起来下发：
    `modes[k].styles` / `modes[k].enabled` / `modes[k].default_style`。

    `enabled=false` 的模式与画风前端要**列出但禁用 + 挂「待完善」徽章**
    （用户决策）——看得见规划、建不出画风必然回退的项目。
    """
    cat = {m["key"]: m for m in _sp.catalog()["modes"]}
    modes: dict[str, dict] = {}
    for key, info in PRODUCTION_MODES.items():
        m = cat.get(key)
        modes[key] = {
            **info,
            # 模式不在 style_preset 表里（不该发生）→ 保守放行，不因为画风表
            # 漏登记就把一个本来能用的模式锁死。
            "enabled": m["enabled"] if m else True,
            "default_style": m["default"] if m else None,
            "styles": m["styles"] if m else [],
        }
    return {"modes": modes, "aspects": BASE_ASPECTS,
            "resolutions": list(RESOLUTION_TIERS.keys())}


# ---------- 生成路线（能力查询）----------
@router.get("/providers/image")
def list_image_providers() -> dict:
    """用户可选图像模型（渠道链后端内部维护，不暴露）。"""
    from .providers.image import IMAGE_MODELS
    return {"models": IMAGE_MODELS}


@router.get("/providers/video")
def list_video_providers() -> dict:
    """列出已注册的视频 Provider 及其能力档位与各生成模式可用性。"""
    from .providers.base import GENERATION_MODES
    providers = []
    for info in registry.list_video():
        p = registry.get_video(info["model_id"])
        info["modes"] = p.mode_support() if p else {}
        providers.append(info)
    return {"providers": providers, "generation_modes": GENERATION_MODES}


@router.get("/system/providers-health")
def providers_health() -> dict:
    """各外部通道的**配置健康度**（设置页高级区展示）。

    ⚠️ 只回布尔与 base_url，**绝不回任何 key**（哪怕前缀）——
    密钥一旦进了前端就可能被截图/日志泄露。用户只需要知道"配没配"，
    不需要看到值。要改 key 得改服务端环境变量，这是刻意的设计。
    """
    from .config import get_settings
    from .providers.asr import ASRProvider
    from .providers.tts import TTSProvider
    s = get_settings()
    return {
        "channels": [
            {"key": "gateway", "label": "文本/视频网关",
             "base_url": s.gateway_base_url, "configured": bool(s.gateway_api_key)},
            {"key": "image", "label": "图像通道",
             "base_url": s.gateway_base_url,
             "configured": bool(s.image_api_key or s.gateway_api_key)},
            {"key": "ark", "label": "火山方舟（Seedance）",
             "base_url": s.ark_base_url, "configured": bool(s.ark_api_key)},
            {"key": "runninghub", "label": "RunningHub（海螺/TTS）",
             "base_url": s.runninghub_base_url, "configured": bool(s.runninghub_api_key)},
            {"key": "api4me", "label": "api4me（语音识别）",
             "base_url": s.api4me_base_url, "configured": bool(s.api4me_api_key)},
        ],
        "features": {
            "tts": TTSProvider().available,
            "asr": ASRProvider().available,
        },
        "note": "密钥由服务端环境变量管理，前端不展示也不可修改",
    }


# ---------- 项目 ----------
#: 画幅基准可选项（新建向导展示；生成与导出默认继承）
BASE_ASPECTS = ["9:16", "16:9", "3:4", "4:3", "1:1", "21:9"]


class ProjectCreate(BaseModel):
    title: str
    base_aspect: str = "9:16"
    default_profile: Optional[str] = None
    production_mode: Optional[str] = None  # drama | narration | anime（旧值 fast/consistent/… 仍接受，迁移期兼容）
    #: 画风预设 key（urban/period/anime_3d/…，见 style_preset）。
    #: 不传 = 取该模式的默认档。非法值会被 `sanitize` 丢成 None，不报错——
    #: 画风是增强项，不该让一个拼错的 key 挡住建项目。
    art_style: Optional[str] = None
    #: 技术参数（video_model/image_model/generation_mode/resolution）存入 default_profile JSON
    custom_settings: Optional[dict] = None


class ProjectOut(BaseModel):
    id: str
    title: str
    base_aspect: str
    default_profile: Optional[str] = None
    production_mode: Optional[str] = None
    #: 用户选的画风 key（可能是尚未启用的档，如古风——那是意图记录）
    art_style: Optional[str] = None
    #: **实际生效**的画风 key。与 art_style 不同就说明选的那档还没启用、
    #: 本次按都市档出图。前端据此显示「当前按都市生成」的提示。
    effective_style: Optional[str] = None
    schema_version: str = "1.0.0"


@router.post("/projects", response_model=ProjectOut)
def create_project(body: ProjectCreate) -> ProjectOut:
    # 接受新值（drama/narration）和旧预设值（迁移兼容）
    valid_modes = set(PRODUCTION_MODES.keys()) | set(_LEGACY_DEFAULTS.keys())
    if body.production_mode and body.production_mode not in valid_modes:
        raise HTTPException(status_code=400,
                            detail=f"未知生产模式: {body.production_mode}")
    if body.base_aspect not in BASE_ASPECTS:
        raise HTTPException(status_code=400,
                            detail=f"不支持的画幅 {body.base_aspect}；可选: {', '.join(BASE_ASPECTS)}")
    pid = uuid.uuid4().hex[:12]
    # 技术参数（video_model/image_model/generation_mode/resolution）统一存 default_profile。
    # 两种模式（drama/narration）都可以携带 custom_settings，
    # 不再有"只有 custom 才能带参数"的限制。
    default_profile = body.default_profile
    if body.custom_settings:
        default_profile = json.dumps(body.custom_settings, ensure_ascii=False)
    # 画风：清洗后入库。`sanitize` **保留尚未启用的合法档**（如古风）——
    # 那是用户的意图记录，等它放开就自动生效，不用重设；不属于该模式或不存在
    # 的 key 一律丢成 None（= 用默认档），不报错。
    art_style = _sp.sanitize(body.production_mode, body.art_style)
    with get_session() as session:
        session.add(
            Project(
                id=pid,
                title=body.title,
                base_aspect=body.base_aspect,
                default_profile=default_profile,
                production_mode=body.production_mode,
                art_style=art_style,
                # 必须显式存：`pid` 是 uuid4().hex[:12]，**纯随机、不含时间**，
                # 从 id 还原不出创建顺序（列表页一度按 id 排序并注释"字典序即时序"，
                # 排出来其实是随机序）。格式与 jobs.created_at 一致，可直接字典序比较。
                created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
        )
        session.commit()
    return ProjectOut(
        id=pid,
        title=body.title,
        base_aspect=body.base_aspect,
        default_profile=default_profile,
        production_mode=body.production_mode,
        art_style=art_style,
        effective_style=_sp.resolve(body.production_mode, art_style).key,
    )


@router.get("/projects/{project_id}", response_model=ProjectOut)
def get_project(project_id: str) -> ProjectOut:
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        return ProjectOut(
            id=proj.id,
            title=proj.title,
            base_aspect=proj.base_aspect,
            default_profile=proj.default_profile,
            # production_mode 漏传了（B35）：ProjectOut 声明了这个字段，
            # 这里不填就恒为 null —— 响应模型在说谎。POST /projects 回填了它，
            # 于是"建项目返回 consistent、随后 GET 同一项目返回 null"。
            # 快/精/自定义档决定下发哪个视频模型，谁照这个响应做判断就会误判成默认档。
            production_mode=proj.production_mode,
            art_style=proj.art_style,
            effective_style=_sp.resolve(proj.production_mode, proj.art_style).key,
            schema_version=proj.schema_version,
        )


@router.get("/projects")
def list_projects(trash: bool = False) -> dict:
    """TB-11：列表接口带统计，消除前端 N+1 补拉。

    每个项目附带缩略图、已出片/总镜头数、总时长，前端 ProjectCards 直接消费，
    不再逐项目发 detail 请求（30 个项目 = 30 个请求）。

    统计口径与 detail 一致：只算未停用镜头。缩略图取该项目 order 最小的
    那个已出片镜头的 thumb_url——第一镜最能代表这部片子，比 max() 随机取一个好。

    `trash=false`（默认）只返回在用项目；`trash=true` **只**返回回收站里的墓碑行。
    两者互斥而非叠加：回收站是一块独立视图，混在一起会让用户以为删除没生效。
    """
    with get_session() as session:
        q = session.query(Project)
        q = q.filter(Project.deleted_at.isnot(None)) if trash \
            else q.filter(Project.deleted_at.is_(None))
        projs = q.all()

        # 一次查询把所有项目的镜头统计算出来（避免 N+1）
        stat_rows = (
            session.query(
                Shot.project_id,
                func.count(Shot.id),
                func.sum(case((Shot.video_url.isnot(None), 1), else_=0)),
                func.sum(func.coalesce(Shot.duration_sec, 5.0)),
            )
            .filter(Shot.disabled == 0)
            .group_by(Shot.project_id)
            .all()
        )
        stats = {r[0]: (int(r[1] or 0), int(r[2] or 0), float(r[3] or 0.0))
                 for r in stat_rows}

        # 「最近活动」= 该项目最后一个任务的时刻。
        # 刻意**不加** projects.updated_at 列：那要在几十个写路径上逐个 touch，
        # 漏一个就静默说谎（用户明明刚改过，列表里却显示三周前）。
        # 由 jobs 派生则永远与事实一致，代价只是这一条 group-by。
        act_rows = (session.query(Job.project_id, func.max(Job.created_at))
                    .filter(Job.project_id.isnot(None))
                    .group_by(Job.project_id).all())
        last_active = {r[0]: r[1] for r in act_rows if r[1]}

        # 每个项目的封面：order 最小的已出片镜头的缩略图
        thumb_rows = (
            session.query(Shot.project_id, Shot.thumb_url, Shot.order)
            .filter(Shot.disabled == 0, Shot.thumb_url.isnot(None))
            .order_by(Shot.project_id, Shot.order)
            .all()
        )
        thumbs: dict[str, str] = {}
        for pid, turl, _order in thumb_rows:
            thumbs.setdefault(pid, turl)

        return {
            "projects": [
                {
                    "id": p.id,
                    "title": p.title,
                    "base_aspect": p.base_aspect,
                    "default_profile": p.default_profile,
                    "production_mode": p.production_mode,
                    "episodes_count": len(json.loads(p.episodes)) if p.episodes else 0,
                    "schema_version": p.schema_version,
                    # ---- TB-11 新增统计字段 ----
                    "shots_total": stats.get(p.id, (0, 0, 0.0))[0],
                    "shots_done": stats.get(p.id, (0, 0, 0.0))[1],
                    "total_sec": stats.get(p.id, (0, 0, 0.0))[2],
                    "thumb_url": thumbs.get(p.id),
                    # ---- 排序/回收站字段 ----
                    # created_at 可能为 null：迁移回填只认 jobs，从没跑过任务的
                    # 老空项目无从推断创建时刻。前端排序把 null 一律排最后，
                    # 不编造时间。
                    "created_at": p.created_at,
                    "deleted_at": p.deleted_at,
                    "last_active_at": last_active.get(p.id),
                }
                for p in projs
            ]
        }


# ---------- 项目：改名 / 回收站 / 彻底删除 ----------
class ProjectPatch(BaseModel):
    title: str


@router.patch("/projects/{project_id}")
def rename_project(project_id: str, body: ProjectPatch) -> dict:
    """重命名项目。

    ⚠️ `title` 不只是展示用：`jobs.py` 会把它作为片名传进生成提示词
    （`scene_prompt(..., title=title, ...)`）。所以改名会影响**此后**新生成
    的图与视频的语境，已生成的内容不受影响。前端改名框必须把这句写给用户看。

    除此之外 title 没有连接键作用（与角色/场景资产改名不同，那边改名要迁移
    引用），所以这里只做一次 UPDATE。
    """
    title = (body.title or "").strip()
    if not title:
        raise HTTPException(status_code=422, detail="项目名不能为空")
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        proj.title = title[:255]
        session.commit()
        return {"ok": True, "id": project_id, "title": proj.title}


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, purge: bool = False) -> dict:
    """删除项目。默认是**打墓碑进回收站**，数据与文件一个不动。

    `purge=true` 才真删库行 + 清该项目独占的磁盘文件，且**前置要求项目已在
    回收站**——不提供"一步删干净"的入口是刻意的：不可逆操作至少要隔一次
    页面切换，光靠一个确认框挡不住手快。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        if not purge:
            if not proj.deleted_at:
                proj.deleted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
                session.commit()
            return {"ok": True, "mode": "trashed", "deleted_at": proj.deleted_at}
        if not proj.deleted_at:
            raise HTTPException(status_code=409, detail="请先移入回收站，再执行彻底删除")
        result = project_purge.purge(session, project_id)
        logger.info("[project] 彻底删除 %s: %s", project_id, result)
        return {"ok": True, "mode": "purged", **result}


@router.post("/projects/{project_id}/restore")
def restore_project(project_id: str) -> dict:
    """从回收站恢复。墓碑期间数据与文件全在，所以恢复就是清掉时间戳。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        proj.deleted_at = None
        session.commit()
        return {"ok": True, "id": project_id}


@router.get("/projects/{project_id}/purge-preview")
def purge_preview(project_id: str) -> dict:
    """彻底删除会删掉什么（只算不删），给确认框填具体数字。

    没有这个预览的话，确认框只能写"此操作不可恢复"这种空话；有了它用户能看到
    "12 个文件 / 3.4 GB"，才判断得出自己是不是删错了项目。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        return project_purge.preview(session, project_id)


# ---------- 剧本导入：分集解析（T-R0-02，契约 C2）----------
class ScriptImportIn(BaseModel):
    text: str
    project_id: Optional[str] = None
    confirm: bool = False  # False=仅解析预览；True=落库


class EpisodeOut(BaseModel):
    order: int
    title: str
    word_count: int
    preview: str  # 前 120 字


@router.post("/script/import")
def script_import(body: ScriptImportIn) -> dict:
    """解析剧本分集（第N集/章/话/回 + 分隔线 + 长度兜底）。

    confirm=False 仅返回预览；confirm=True 且带 project_id 时落库
    （episodes 存 JSON 元信息，raw_script 存全文）。
    """
    return _do_script_import(body.text, body.project_id, body.confirm)


@router.post("/script/import-file")
async def script_import_file(
    file: UploadFile = File(...),
    project_id: Optional[str] = Form(None),
    confirm: bool = Form(False),
) -> dict:
    """文件版剧本导入：支持 txt/md/docx/pdf（.doc 提示转存）。解析为文本后与文本版同流程。"""
    from .script_files import parse_script_file
    content = await file.read()
    if len(content) > 50 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="文件超过 50MB 上限")
    try:
        text = parse_script_file(file.filename or "unknown", content)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if not text.strip():
        raise HTTPException(status_code=400, detail="文件中未提取到文字内容")
    return _do_script_import(text, project_id, confirm)


def _do_script_import(text: str, project_id: Optional[str], confirm: bool) -> dict:
    """导入共用核心：分集解析 →（可选）落库 → 返回预览。"""
    chapters = smart_split_chapters(text)
    if not chapters:
        raise HTTPException(status_code=400, detail="剧本内容为空")

    if confirm and project_id:
        with get_session() as session:
            proj = session.get(Project, project_id)
            if not proj:
                raise HTTPException(status_code=404, detail="project not found")
            proj.raw_script = text
            proj.episodes = json.dumps(
                [{"order": c["order"], "title": c["title"],
                  "word_count": c["word_count"]} for c in chapters],
                ensure_ascii=False,
            )
            session.commit()

    return {
        "episodes": [
            EpisodeOut(order=c["order"], title=c["title"],
                       word_count=c["word_count"],
                       preview=c["content"][:120]).model_dump()
            for c in chapters
        ],
        "saved": bool(confirm and project_id),
        # 文件导入时前端需要拿解析出的文本用于确认后落库
        "text": text,
    }


# ---------- 按集编辑剧本（剧本页直接编辑；改动即把该集镜头标 stale）----------
class EpisodeContentIn(BaseModel):
    content: str


@router.get("/projects/{project_id}/episodes/content")
def episodes_content(project_id: str) -> dict:
    """按集返回剧本正文（剧本页每集一个文本框）。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        raw = proj.raw_script or ""
    chapters = smart_split_chapters(raw) if raw else []
    return {"episodes": [
        {"order": c["order"], "title": c["title"], "content": c["content"]}
        for c in chapters
    ]}


@router.put("/projects/{project_id}/episodes/{order}/content")
def update_episode_content(project_id: str, order: int, body: EpisodeContentIn) -> dict:
    """更新某一集正文：重组 raw_script 落库，并把该集已有镜头标记 stale（过期）。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        raw = proj.raw_script or ""
        chapters = smart_split_chapters(raw) if raw else []
        target = next((c for c in chapters if c["order"] == order), None)
        if target is None:
            raise HTTPException(status_code=404, detail=f"第 {order} 集不存在")
        target["content"] = body.content.strip()
        # 重组全文（标题行 + 正文），保持 smart_split_chapters 可再解析
        proj.raw_script = "\n".join(f"{c['title']}\n{c['content']}" for c in chapters)
        proj.episodes = json.dumps(
            [{"order": c["order"], "title": c["title"],
              "word_count": len(c["content"])} for c in chapters],
            ensure_ascii=False)
        # 该集镜头标过期（不删：旧拆解仍可看，重拆时才替换）
        # 原因 rebreak = 严重度最高，批量直写不会覆盖掉更严重的原因（没有更严重的）。
        n = (session.query(Shot)
             .filter(Shot.project_id == project_id, Shot.episode == order)
             .update({"stale": 1, "stale_reason": stale_mod.REBREAK}))
        session.commit()
        return {"ok": True, "stale_shots": n}


# ---------- 提示词优化框架状态（T-R0-03，契约 C2）----------
@router.get("/prompt-opt/status")
def prompt_opt_status() -> dict:
    from .prompt_opt import get_status
    return get_status()


# ---------- R1：人物资产阶段（集×镜头双层轴，契约 C5）----------
class StageOut(BaseModel):
    id: str
    character_name: str
    stage_name: str
    ep_from: int
    ep_to: int
    shot_from: Optional[int] = None
    shot_to: Optional[int] = None
    image_url: Optional[str] = None
    description: Optional[str] = None
    status: str
    #: 服装继承（"同一场景下同一人物服装相同"）：
    #: location = 本造型绑定的**归一场景名**；scene_bound = 是否场景决定型（可跨集沿用）。
    #: 两者都在资产页可改——AI 的 scene_bound 判定难免有争议，最终解释权归用户。
    location: Optional[str] = None
    scene_bound: bool = False
    #: 指针行：与该 id 的阶段是同一件衣服、共用它那张图（自己不出图）。
    source_stage_id: Optional[str] = None
    #: 指针行解析后的实际可用图（source 的 image_url）。前端据此显示缩略图，
    #: 不必自己再去追指针。
    effective_image_url: Optional[str] = None
    #: 本阶段区间内该角色**最终注入**的镜头 order 列表（P1-2 起 = (拆解真值 ∪ 人工add) − 人工remove，
    #: 与 jobs.py::_auto_inject_refs 完全同源 db.effective_characters）。
    #: 轨道按此渲染，避免"没出场却显示覆盖"的误导。
    present_orders: list[int] = []
    #: P1-2 人工覆写标记：本阶段区间内被人工「加入」注入的镜头 order（present_orders 子集，
    #: 轨道画斜纹/描边）与被人工「排除」的镜头 order（形成的空洞是手调的，tooltip/重置用）。
    manual_add_orders: list[int] = []
    manual_remove_orders: list[int] = []
    #: 虚拟段（无对应 AssetStage 行）：角色被拖拽注入但没有任何阶段覆盖这些镜头时，
    #: 服务端合成此段保证「轨道显示 = 实际注入」。不可 patch/merge/生成定妆（前端据此降级）。
    virtual: bool = False


def _stage_out(s: "AssetStage", present_orders: list[int] | None = None,
               manual_add: list[int] | None = None,
               manual_remove: list[int] | None = None,
               session=None) -> StageOut:
    from .costumes import resolve_stage_image
    eff = s.image_url
    if not eff and s.source_stage_id and session is not None:
        eff = resolve_stage_image(session, s)
    return StageOut(
        id=s.id, character_name=s.character_name, stage_name=s.stage_name,
        ep_from=s.ep_from, ep_to=s.ep_to, shot_from=s.shot_from, shot_to=s.shot_to,
        image_url=s.image_url, description=s.description, status=s.status,
        location=s.location, scene_bound=bool(s.scene_bound),
        source_stage_id=s.source_stage_id, effective_image_url=eff,
        present_orders=present_orders or [],
        manual_add_orders=manual_add or [],
        manual_remove_orders=manual_remove or [],
    )


def _present_orders_map(session, project_id: str) -> tuple[
        dict[str, list[int]], dict[str, list[int]], dict[str, list[int]]]:
    """角色名 → (最终注入 orders, 人工加入 orders, 人工排除 orders)，均按 order 升序。

    最终注入走 db.effective_characters（与 jobs.py::_auto_inject_refs 同源），
    人工增删来自 Shot.ref_overrides（L3），供轨道标记「这段是我手调的」。
    """
    from .db import effective_characters
    rows = (session.query(Shot)
            .filter(Shot.project_id == project_id)
            .order_by(Shot.order).all())
    present: dict[str, list[int]] = {}
    added: dict[str, list[int]] = {}
    removed: dict[str, list[int]] = {}
    for sh in rows:
        try:
            l1 = {c for c in json.loads(sh.characters or "[]")
                  if isinstance(c, str) and c}
        except json.JSONDecodeError:
            l1 = set()
        for c in effective_characters(sh):
            present.setdefault(c, []).append(sh.order)
            if c not in l1:  # 注入了但拆解真值没有 → 人工加的
                added.setdefault(c, []).append(sh.order)
        try:
            ov = json.loads(sh.ref_overrides) if sh.ref_overrides else {}
        except json.JSONDecodeError:
            ov = {}
        for c in ov.get("remove", []):
            if isinstance(c, str) and c in l1:  # 真值有但被人工排除
                removed.setdefault(c, []).append(sh.order)
    return present, added, removed


def _stage_shot_conflict(a: AssetStage, b: AssetStage) -> bool:
    """两阶段在镜号维度上是否冲突。任一方没有镜号限制 → 视为覆盖全区间。

    绑了场景的阶段（`location` 非空）也算变体：它只在"人物身处该场景"时
    生效，天然是叠在基础造型之上的局部覆写，与基础阶段共存是设计意图。
    没有这条例外，"睡衣@卧室"这类场景决定型服装会被判成与基础阶段冲突，
    用户在资产页连保存都保存不了。

    模块级函数（原先长在 `patch_stage` 里）：`restore_stage` 要用同一套判据——
    恢复一个阶段和改一个阶段的区间，在"会不会撞上兄弟阶段"这件事上是同一个问题，
    各写一份必然漂移（一边允许场景变体共存、另一边不允许）。
    """
    def _is_base(x: AssetStage) -> bool:
        return (x.shot_from is None and x.shot_to is None
                and not (x.location or "").strip())
    if _is_base(a) or _is_base(b):
        # 至少一方是基础阶段：基础 vs 基础 = 冲突；基础 vs 变体 = 允许分层
        return _is_base(a) and _is_base(b)
    if (a.shot_from is None and a.shot_to is None) or \
       (b.shot_from is None and b.shot_to is None):
        # 场景绑定但不限镜号的两条：只有绑同一个场景才算冲突
        #（同一角色在同一场景不能有两套并存的造型，那样无法裁决）
        return ((a.location or "").strip() == (b.location or "").strip())
    a_lo = a.shot_from if a.shot_from is not None else -(10 ** 9)
    a_hi = a.shot_to if a.shot_to is not None else 10 ** 9
    b_lo = b.shot_from if b.shot_from is not None else -(10 ** 9)
    b_hi = b.shot_to if b.shot_to is not None else 10 ** 9
    return a_lo <= b_hi and b_lo <= a_hi


def _stage_range_label(st: AssetStage) -> str:
    """「第1-5集 #17-19镜」——冲突提示里指认是哪一条。"""
    return (f"第{st.ep_from}-{st.ep_to}集"
            + (f" #{st.shot_from}-{st.shot_to}镜"
               if (st.shot_from is not None or st.shot_to is not None) else ""))


def _conflicting_sibling(session, st: AssetStage) -> AssetStage | None:
    """同角色的**在用**阶段里，第一个与 st 区间冲突的。没有则 None。

    墓碑不参与（见 `stage_gate`：删掉的阶段不该继续占着集区间）。
    """
    siblings = stage_gate.alive(
        session.query(AssetStage)
        .filter(AssetStage.project_id == st.project_id,
                AssetStage.character_name == st.character_name,
                AssetStage.id != st.id)).all()
    for sib in siblings:
        if st.ep_from <= sib.ep_to and sib.ep_from <= st.ep_to \
                and _stage_shot_conflict(st, sib):
            return sib
    return None


@router.get("/projects/{project_id}/stages")
def list_stages(project_id: str) -> dict:
    with get_session() as session:
        # 墓碑阶段不进 stages：本函数的契约是「轨道显示 = 实际注入」，
        # 而删掉的阶段已经不再注入。它们单独走 deleted_stages（资产页的
        # 「已删除」组据此给恢复入口），且**不 claim orders**——否则那些镜头
        # 会被算作"已有阶段覆盖"，虚拟段就不出，用户看不到自己没造型了。
        rows = (stage_gate.alive(
            session.query(AssetStage)
            .filter(AssetStage.project_id == project_id))
            .order_by(AssetStage.character_name, AssetStage.ep_from).all())
        present, added, removed = _present_orders_map(session, project_id)
        # 每阶段只带自己 ep 区间（及可选 shot_from/to 精修）内的出场镜头
        ep_of = {sh.order: sh.episode for sh in
                 session.query(Shot).filter(Shot.project_id == project_id).all()}
        out = []
        claimed: dict[str, set[int]] = {}   # 角色 → 已被某阶段覆盖的 orders
        for s in rows:
            in_range = (lambda o: s.ep_from <= ep_of.get(o, -1) <= s.ep_to
                        and (s.shot_from is None or o >= s.shot_from)
                        and (s.shot_to is None or o <= s.shot_to))
            orders = [o for o in present.get(s.character_name, []) if in_range(o)]
            m_add = [o for o in added.get(s.character_name, []) if in_range(o)]
            m_rm = [o for o in removed.get(s.character_name, []) if in_range(o)]
            out.append(_stage_out(s, orders, m_add, m_rm, session=session).model_dump())
            claimed.setdefault(s.character_name, set()).update(orders)
        # 虚拟段（保证「轨道显示 = 实际注入」）：角色被注入但不被任何阶段覆盖——
        # ①拖拽注入的无阶段角色（含 custom 刚归类）②镜头在该角色所有阶段区间之外。
        # 墓碑资产不出图：本函数的契约是「轨道显示 = 实际注入」，而删掉的
        # 角色已经不再注入（`jobs._auto_inject_refs_detailed` 过滤），
        # 这里若照旧显示图，轨道就在骗人。
        img_of = {a.name: a.image_url for a in asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id,
                                        Asset.kind == "character")).all()}
        for name, orders in present.items():
            orphan = [o for o in orders if o not in claimed.get(name, set())]
            if not orphan:
                continue
            eps = [ep_of.get(o, 1) for o in orphan]
            orphan_set = set(orphan)
            out.append(StageOut(
                id=f"__nostage__{name}", character_name=name,
                stage_name="未设阶段", ep_from=min(eps), ep_to=max(eps),
                image_url=img_of.get(name), description=None, status="draft",
                present_orders=orphan,
                manual_add_orders=[o for o in added.get(name, []) if o in orphan_set],
                manual_remove_orders=[], virtual=True).model_dump())
        # 已删除的阶段：只给资产页的「已删除」组做恢复入口用，不参与轨道计算。
        # 带上 image_url 是为了让用户看图认出"删掉的是哪一套造型"——名字往往
        # 只是「造型2」，光看名字认不出。
        gone = [
            {"id": s.id, "character_name": s.character_name,
             "stage_name": s.stage_name, "ep_from": s.ep_from, "ep_to": s.ep_to,
             "shot_from": s.shot_from, "shot_to": s.shot_to,
             "image_url": s.image_url, "description": s.description,
             "location": s.location, "deleted_at": s.deleted_at}
            for s in (session.query(AssetStage)
                      .filter(AssetStage.project_id == project_id,
                              AssetStage.deleted_at.isnot(None))
                      .order_by(AssetStage.character_name,
                                AssetStage.ep_from).all())
        ]
        return {"stages": out, "deleted_stages": gone,
                "locations": _locations_map(session, project_id)}


def _locations_map(session, project_id: str) -> list[dict]:
    """P1-3 场景轨数据：每场景一行，最终注入 orders + 人工增删标记 + 参考图。

    L1 = Shot.location（拆解落库，单值），图源 = Asset(kind=location).image_url，
    L3 = ref_overrides.add_loc/remove_loc（与角色轨同契约 effective_locations）。

    轨道按**归一名**成行：同一个房间在各集写法不同（「夜 内 楚家公馆-客厅」
    与「楚家公馆-客厅」），按原名成行会把一个房间拆成好几条轨、每条各挂一张
    不同的参考图。场景资产也是按归一名存的，这里同口径才取得到图。
    """
    from .scenes import canonical_locations, canonical_of
    rows = (session.query(Shot)
            .filter(Shot.project_id == project_id)
            .order_by(Shot.order).all())
    present: dict[str, list[int]] = {}
    added: dict[str, list[int]] = {}
    removed: dict[str, list[int]] = {}
    for sh in rows:
        l1 = {canonical_of(session, project_id, sh.location)} if sh.location else set()
        for c in canonical_locations(session, project_id, sh):
            present.setdefault(c, []).append(sh.order)
            if c not in l1:
                added.setdefault(c, []).append(sh.order)
        try:
            ov = json.loads(sh.ref_overrides) if sh.ref_overrides else {}
        except json.JSONDecodeError:
            ov = {}
        for c in ov.get("remove_loc", []):
            if isinstance(c, str) and c:
                cn = canonical_of(session, project_id, c)
                if cn in l1:
                    removed.setdefault(cn, []).append(sh.order)
    img_of = {a.name: a.image_url for a in asset_gate.alive(
        session.query(Asset).filter(Asset.project_id == project_id,
                                    Asset.kind == "location")).all()}
    # 出现顺序按首镜 order 排，轨道行序与剧情推进一致
    return [
        {"name": name, "image_url": img_of.get(name),
         "present_orders": orders,
         "manual_add_orders": added.get(name, []),
         "manual_remove_orders": removed.get(name, [])}
        for name, orders in sorted(present.items(), key=lambda kv: kv[1][0])
    ]


class StagePatchIn(BaseModel):
    stage_name: Optional[str] = None
    ep_from: Optional[int] = None
    ep_to: Optional[int] = None
    shot_from: Optional[int] = None
    shot_to: Optional[int] = None
    description: Optional[str] = None
    image_url: Optional[str] = None
    status: Optional[str] = None  # draft | confirmed
    #: 服装继承的两个可改字段（用户对 AI 的 scene_bound 判定有最终解释权）。
    #: location 传空串 = 解除场景绑定。
    location: Optional[str] = None
    scene_bound: Optional[bool] = None
    #: 连同换图一起把旧造型描述清空（用户上传了自己的图时前端传 true）。
    #: 见 `_CLEAR_DESC_WHY`。只有"外来的新图"该传它——采用 AI 候选图不传，
    #: 那张图本来就是照着这段描述生出来的。
    clear_description: Optional[bool] = None


#: 为什么"换成用户自己的图"必须把旧描述清掉（2026-09-10 用户反馈的外观漂移）
#:
#: 造型描述在 `costumes.py` 拆剧本时就写好了 —— 那会儿一张图都还没有，
#: 写的是"剧本里这个人应该穿什么"。用户后来上传自己的定妆图，这段文字
#: 与新图毫无关系，但出片时 `jobs._auto_inject_refs_detailed` 仍把它作为
#: 参考图的文字锚点注入，且提示词里明写「原稿中与之矛盾的服装描写一律以此
#: 为准改写」（jobs.py 的 ref_notes 段）—— 于是**文字压过了参考图**，
#: 人物外观必然漂移。
#:
#: 清空之后走的是 jobs.py 里 `blind` 那条确定性兜底：没有文字造型的参考图，
#: 提示词**禁止**书写其服装/发型/配饰，外观完全交给参考图钳制。
#: 这正是"我传了自己的图"最想要的行为。
_CLEAR_DESC_WHY = "用户上传了自己的图，旧造型描述已与该图无关"


@router.patch("/stages/{stage_id}")
async def patch_stage(stage_id: str, body: StagePatchIn) -> dict:
    # 2026-09-10：这里原本在换图时同步等一次视觉反推（~8s 的多模态调用，
    # 还要把图整份 base64 上行）。它把"上传一张图"拖成了几十秒，且期间
    # 资产弹窗不许关闭 = 整页锁死。反推已改为弹窗里的手动按钮
    # （POST /v2/assets/describe-image），上传链路不再碰模型。
    with get_session() as session:
        st = session.get(AssetStage, stage_id)
        if not st:
            raise HTTPException(status_code=404, detail="stage not found")
        # 已删除的阶段不接受编辑：让用户先恢复，再改。否则会出现"改了一个
        # 看不见的东西"——保存成功、界面上什么都没变。
        if st.deleted_at:
            raise HTTPException(status_code=409,
                                detail="该造型阶段已删除，请先恢复再编辑")
        if body.status is not None and body.status not in ("draft", "confirmed"):
            raise HTTPException(status_code=400, detail="status 只能是 draft/confirmed")
        for k in ("stage_name", "ep_from", "ep_to", "shot_from", "shot_to",
                  "description", "image_url", "status"):
            v = getattr(body, k)
            if v is not None:
                setattr(st, k, v)
        # location/scene_bound 单独处理：location="" 是有意义的输入（解除场景绑定），
        # 不能被上面那圈 `is not None` 的通用逻辑当成"没传"。
        if body.location is not None:
            st.location = body.location.strip() or None
        if body.scene_bound is not None:
            st.scene_bound = 1 if body.scene_bound else 0
        if st.scene_bound and not (st.location or "").strip():
            raise HTTPException(status_code=400,
                                detail="场景决定型服装必须绑定场景（location）")
        # 人工给了图 → 它自己就是源，解除指针（否则显示的还是别人的图）
        if body.image_url:
            st.source_stage_id = None
        # 用户上传自己的图 → 旧描述与新图无关，清掉（见 _CLEAR_DESC_WHY）。
        # 放在通用赋值之后：本次若同时手写了描述，以用户的字为准，不被清空。
        if body.clear_description and body.description is None:
            st.description = None
        if st.ep_to < st.ep_from:
            raise HTTPException(status_code=400, detail="ep_to 不能小于 ep_from")
        if st.ep_from < 1:
            raise HTTPException(status_code=400, detail="ep_from 不能小于 1")
        # 区间越界校验：不能超过项目实际集数
        proj = session.get(Project, st.project_id)
        episodes = json.loads(proj.episodes) if proj and proj.episodes else []
        max_ep = max(
            [len(episodes)]
            + [sh.episode for sh in session.query(Shot)
               .filter(Shot.project_id == st.project_id).all()],
            default=1,
        ) or 1
        if st.ep_to > max_ep:
            raise HTTPException(status_code=400,
                                detail=f"ep_to 超出全剧集数（共 {max_ep} 集）")
        # 同角色阶段区间不得重叠（两区间重叠 ⟺ a.from <= b.to 且 b.from <= a.to）
        #
        # 例外：**服装变体**（带 shot_from/shot_to 的阶段）本来就是叠在基础阶段之上的
        # 局部覆写——「丝绸睡裙」只覆盖第2集的 #17-#19，与「默认造型」ep1-5 在集维度上
        # 必然重叠，这是设计意图而不是错误（_auto_inject_refs 按特异性优先选变体）。
        # 只有当两边**镜号区间也重叠**时才是真冲突（同几个镜头有两套造型，无法裁决）。
        # 判据在模块级的 _stage_shot_conflict（restore_stage 共用同一套）。
        sib = _conflicting_sibling(session, st)
        if sib is not None:
            raise HTTPException(
                status_code=409,
                detail=f"与阶段「{sib.stage_name}」({_stage_range_label(sib)}) 区间重叠",
            )
        session.commit()
        return _stage_out(st).model_dump()


@router.delete("/stages/{stage_id}")
def delete_stage(stage_id: str) -> dict:
    """删除造型阶段（用户 2026-09-09 需求 2）。**写墓碑，不真删行。**

    用户原话：「阶段删除后似乎没有撤销删除的能力」。此前这里是 `session.delete(st)`,
    误删一个已出定妆图的阶段就等于把那张图彻底丢掉——而"重跑服装识别"并不能
    找回它：那是按剧本**重新规划**，产出的是新 id、没有图的阶段，要重新花钱生图，
    名字与区间都可能和用户删掉的那条不同。

    墓碑之后：阶段立刻不再被注入/规划/合并（`stage_gate` 统一闸门），
    但行与图都还在，`POST /stages/{id}/restore` 能原样恢复。
    """
    with get_session() as session:
        st = session.get(AssetStage, stage_id)
        if not st:
            raise HTTPException(status_code=404, detail="stage not found")
        if st.deleted_at:
            # 幂等：重复删不报错（前端重试/双击都可能打两次）
            return {"ok": True, "already_deleted": True,
                    "character_name": st.character_name,
                    "stage_name": st.stage_name, "deleted_at": st.deleted_at}
        st.deleted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        out = {"ok": True, "character_name": st.character_name,
               "stage_name": st.stage_name, "deleted_at": st.deleted_at,
               #: 这张定妆图还在磁盘上（GC 连墓碑一起扫），恢复后照旧可用
               "kept_image": bool(st.image_url)}
        # 指针行的源被删 → 跟随者会失去图源（costumes.resolve_stage_image 不穿透
        # 墓碑）。告诉用户有几条跟着一起失效，而不是让他事后发现"那几段没图了"。
        out["followers"] = (session.query(AssetStage)
                            .filter(AssetStage.source_stage_id == st.id,
                                    AssetStage.deleted_at.is_(None)).count())
        session.commit()
    return out


@router.post("/stages/{stage_id}/restore")
def restore_stage(stage_id: str) -> dict:
    """撤销删除造型阶段：清掉墓碑，阶段与定妆图原样回来。

    唯一会失败的情形是**区间已被别人占了**（墓碑不占集区间，所以删掉之后用户
    可能在同一段集里建了新造型）。那种情况返回 409 说清和谁撞了，让用户先调
    区间——悄悄恢复出两套并存的造型更糟：生图/注入时只能随机选一套。
    """
    with get_session() as session:
        st = session.get(AssetStage, stage_id)
        if not st:
            raise HTTPException(status_code=404, detail="stage not found")
        if not st.deleted_at:
            return {"ok": True, "already_alive": True,
                    "stage": _stage_out(st).model_dump()}
        sib = _conflicting_sibling(session, st)
        if sib is not None:
            raise HTTPException(
                status_code=409,
                detail=(f"无法恢复：区间与现有阶段「{sib.stage_name}」"
                        f"({_stage_range_label(sib)}) 重叠，"
                        "请先调整那条阶段的区间"))
        st.deleted_at = None
        session.commit()
        return {"ok": True, "stage": _stage_out(st).model_dump()}


class StageMergeIn(BaseModel):
    stage_ids: list[str]
    #: 保留哪个阶段的图/名/描述；缺省 = 有定妆图者优先，否则取第一个
    keep_id: Optional[str] = None


@router.post("/stages/merge")
def merge_stages(body: StageMergeIn) -> dict:
    """合并同一角色的多个造型阶段（资产页勾选合并，修「相似设定不能合一」）。

    语义：保留 keep 阶段（图/名/描述），ep 区间取所有被合并阶段的并集
    （min ep_from .. max ep_to），其余阶段删除；shot_from/to 清空（跨集后
    集内精修失去意义）。与未参与合并的兄弟阶段区间重叠时 409（提示一并勾选）。
    """
    if len(set(body.stage_ids)) < 2:
        raise HTTPException(status_code=400, detail="至少勾选 2 个阶段才能合并")
    with get_session() as session:
        rows = (session.query(AssetStage)
                .filter(AssetStage.id.in_(body.stage_ids)).all())
        if len(rows) != len(set(body.stage_ids)):
            raise HTTPException(status_code=404, detail="部分阶段不存在")
        # 墓碑不能参与合并：合并会改区间、删行、迁图，把一个"已删除"的东西
        # 卷进来只会让恢复变得没意义（用户恢复出来的还是不是原来那条？）。
        if any(r.deleted_at for r in rows):
            raise HTTPException(status_code=409,
                                detail="所选阶段中有已删除的，请先恢复或取消勾选")
        if len({r.project_id for r in rows}) > 1 or len({r.character_name for r in rows}) > 1:
            raise HTTPException(status_code=400, detail="只能合并同一角色的阶段")
        if body.keep_id:
            keep = next((r for r in rows if r.id == body.keep_id), None)
            if not keep:
                raise HTTPException(status_code=400, detail="keep_id 不在所选阶段中")
        else:
            keep = next((r for r in rows if r.image_url), rows[0])
        ep_from = min(r.ep_from for r in rows)
        ep_to = max(r.ep_to for r in rows)
        # 墓碑不占区间（见 stage_gate），所以判重叠只看在用的兄弟阶段
        siblings = stage_gate.alive(
            session.query(AssetStage)
            .filter(AssetStage.project_id == keep.project_id,
                    AssetStage.character_name == keep.character_name,
                    ~AssetStage.id.in_(body.stage_ids))).all()
        for sib in siblings:
            if ep_from <= sib.ep_to and sib.ep_from <= ep_to:
                raise HTTPException(
                    status_code=409,
                    detail=f"合并后区间(第{ep_from}-{ep_to}集)与未勾选的阶段"
                           f"「{sib.stage_name}」(第{sib.ep_from}-{sib.ep_to}集)重叠，"
                           "请把它一并勾选或先调整其区间")
        keep.ep_from, keep.ep_to = ep_from, ep_to
        keep.shot_from = keep.shot_to = None
        # 保留者缺图/缺描述时，从被合并者中兜底补齐（不丢已有资产）
        if not keep.image_url:
            keep.image_url = next(
                (r.image_url for r in rows if r.id != keep.id and r.image_url), None)
        if not keep.description:
            keep.description = next(
                (r.description for r in rows if r.id != keep.id and r.description), None)
        merged_names = [r.stage_name for r in rows if r.id != keep.id]
        for r in rows:
            if r.id != keep.id:
                session.delete(r)
        session.commit()
        return {"ok": True, "kept": _stage_out(keep).model_dump(),
                "merged_names": merged_names}


class StageConfirmAllIn(BaseModel):
    project_id: str
    #: 指定阶段 id；缺省=该项目所有「有图但仍是 draft」的阶段
    stage_ids: Optional[list[str]] = None


@router.post("/stages/confirm-all")
def confirm_all_stages(body: StageConfirmAllIn) -> dict:
    """批量把定妆图阶段置为 confirmed。**已废弃，仅留作 API 兼容。**

    历史上 `jobs._auto_inject_refs` 只注入 confirmed 的定妆图，AI 生成的阶段
    默认 draft，于是"资产明明生成了却没被注入"。现在注入只看有没有图——
    生成/上传即视为选定，不再需要额外一道确认，所以本端点对注入**无任何影响**，
    UI 上也已没有入口。status 现仅是资产页的人工标记。
    """
    with get_session() as session:
        q = stage_gate.alive(
            session.query(AssetStage)
            .filter(AssetStage.project_id == body.project_id,
                    AssetStage.image_url.isnot(None),
                    AssetStage.status != "confirmed"))
        if body.stage_ids:
            q = q.filter(AssetStage.id.in_(list(body.stage_ids)))
        rows = q.all()
        for st in rows:
            st.status = "confirmed"
        session.commit()
        return {"ok": True, "confirmed": len(rows),
                "ids": [st.id for st in rows]}


# ---------- 生产就绪度体检（出片前二次确认弹窗的数据源）----------
@router.get("/projects/{project_id}/readiness")
def project_readiness(project_id: str) -> dict:
    """只读体检：镜头/资产/首帧/模型能力是否具备开跑条件。

    弹窗打开时拉一次；job 结束后再拉一次刷新。不写任何库、不产生任何费用。
    """
    from .readiness import compute_readiness
    data = compute_readiness(project_id)
    if data.get("error"):
        raise HTTPException(status_code=404, detail=data["error"])
    return data


# ---------- 场景归一字典（"同一场景下同一人物服装相同"的判据）----------
@router.get("/projects/{project_id}/scenes")
def list_scenes(project_id: str) -> dict:
    """场景归一字典：`{归一场景名: [该项目里的原始写法...]}` + 每组的镜头数。

    为什么要把它摊到 UI 上：服装继承、场景基准帧共享**全都以归一名为准**。
    归错了（两个不同房间被合成一个）画面就会错，所以必须让用户看得见、改得动。
    只读，不触发任何模型调用。
    """
    from .scenes import canonical_map, normalize_location
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        from .db import SceneAlias
        canon = canonical_map(session, project_id)
        src = {r.raw_name: r.source for r in (session.query(SceneAlias)
               .filter(SceneAlias.project_id == project_id).all())}
        counts: dict[str, int] = {}
        for sh in (session.query(Shot)
                   .filter(Shot.project_id == project_id).all()):
            lo = (sh.location or "").strip()
            if lo:
                counts[lo] = counts.get(lo, 0) + 1
        groups: dict[str, dict] = {}
        for raw, cn in sorted(canon.items()):
            g = groups.setdefault(cn, {"canonical": cn, "members": [], "shots": 0})
            g["members"].append({
                "raw_name": raw, "shots": counts.get(raw, 0),
                # manual = 用户改过，AI 重跑归一不会推翻
                "source": src.get(raw, "auto"),
                "time_of_day": normalize_location(raw)[1],
                "int_ext": normalize_location(raw)[2],
            })
            g["shots"] += counts.get(raw, 0)
    return {"scenes": sorted(groups.values(),
                             key=lambda g: (-g["shots"], g["canonical"]))}


class SceneAliasIn(BaseModel):
    project_id: str
    raw_name: str
    #: 归一场景名。改这个就是"把这个写法并到那个场景去"
    canonical: str


@router.patch("/scenes/alias")
def patch_scene_alias(body: SceneAliasIn) -> dict:
    """人工改一条场景归一映射（`source='manual'`，AI 重跑时不被覆盖）。

    误合并的修法就是把其中一个写法的 canonical 改回它自己的名字。
    """
    from .scenes import set_alias
    canonical = (body.canonical or "").strip()
    if not canonical:
        raise HTTPException(status_code=400, detail="canonical 不能为空")
    with get_session() as session:
        if session.get(Project, body.project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        changed = set_alias(session, body.project_id, body.raw_name,
                            canonical, source="manual")
        session.commit()
    return {"ok": True, "changed": changed,
            "raw_name": body.raw_name, "canonical": canonical}


class SceneCanonIn(BaseModel):
    project_id: str
    model_id: Optional[str] = None


@router.post("/projects/{project_id}/scenes/canonicalize")
async def canonicalize_project_scenes(project_id: str,
                                      body: Optional[SceneCanonIn] = None) -> dict:
    """跑一次场景别名合并（一次文本模型调用，**不生成任何图、不花生图钱**）。

    幂等：只更新 AI 来源的映射，人工改过的保持不动。
    `stages_draft` 内部也会先跑它，这里单独开一个入口是为了让用户能先看归一结果、
    确认没有误合并，再决定要不要去识别服装。
    """
    from .scenes import canonicalize_scenes
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    try:
        out = await canonicalize_scenes(project_id,
                                        body.model_id if body else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"场景归一失败: {e!r}")
    return {"ok": True, "updated": out["updated"], "llm": out["llm"],
            "scenes": out["scenes"]}


class ScenePreviewIn(BaseModel):
    model_id: Optional[str] = None


@router.post("/projects/{project_id}/scenes/preview")
async def preview_project_scenes(project_id: str,
                                 body: Optional[ScenePreviewIn] = None) -> dict:
    """算一份归一建议并翻译成"执行后会变什么"，**一个字都不写库**。

    与 `/scenes/canonicalize` 的区别就是"写不写"：那条算完直接落库，
    而归一是**有损**的（同一归一名下的多行场景资产会被合并成一行，
    删掉的那行可能已经出过图、花过钱）。所以界面走的是这条：
    先看每组影响多少镜头、会删哪一行资产，逐组确认后再调 `/scenes/apply-groups`。

    成本：一次文本模型调用，不出图。前端应由用户点按钮触发，别在打开面板时自动跑。
    """
    from .scenes import preview_groups, propose_scene_groups
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    try:
        prop = await propose_scene_groups(project_id,
                                          body.model_id if body else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"场景归一建议失败: {e!r}")
    with get_session() as session:
        groups = preview_groups(session, project_id, prop["groups"], prop["meta"])
    return {"ok": True, "llm": prop["llm"], "groups": groups}


class SceneGroupIn(BaseModel):
    canonical: str
    members: list[str]


class SceneApplyIn(BaseModel):
    #: 用户**逐组确认过**的分组。只写这些组，不碰其它组。
    groups: list[SceneGroupIn]


@router.post("/projects/{project_id}/scenes/apply-groups")
def apply_project_scene_groups(project_id: str, body: SceneApplyIn) -> dict:
    """把用户确认过的那几组归一写进库（`source='manual'`，AI 重跑不推翻）。

    刻意**不**提供"把建议全盘接受"的入口：归一有损，
    全盘接受意味着用户在没看过的合并上也点了同意（见文档 U3）。

    资产收敛只作用于本次这些组的归一名（`scoped_assets=True`）——
    库里可能还留着早先 `stages_draft` 内部跑归一时写下的 AI 别名，
    那些组用户没看过，不该被这次确认顺带合并掉。
    """
    from .scenes import apply_scene_groups, normalize_location, raw_locations
    if not body.groups:
        raise HTTPException(status_code=400, detail="没有要应用的分组")
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        known = set(raw_locations(session, project_id))
        seen: set[str] = set()
        groups: list[dict] = []
        meta: dict[str, tuple[str | None, str | None]] = {}
        for g in body.groups:
            canon = (g.canonical or "").strip()
            if not canon:
                raise HTTPException(status_code=400, detail="归一名不能为空")
            members = [m.strip() for m in g.members if (m or "").strip()]
            if not members:
                raise HTTPException(status_code=400,
                                    detail=f"「{canon}」这一组没有成员")
            for m in members:
                # 不在本项目镜头里出现过的名字一律拒绝：这条接口只收敛既有写法，
                # 不是"任意写别名"的入口（那会往字典里塞永远匹配不到的死行）
                if m not in known:
                    raise HTTPException(
                        status_code=400,
                        detail=f"「{m}」不是本项目的场景名（可能镜头已改动，请重新预览）")
                if m in seen:
                    raise HTTPException(status_code=400,
                                        detail=f"「{m}」出现在多个分组里")
                seen.add(m)
                meta[m] = normalize_location(m)[1:]
            groups.append({"canonical": canon, "members": members})
        res = apply_scene_groups(session, project_id, groups,
                                 source="manual", meta=meta, scoped_assets=True)
        session.commit()
    return {"ok": True, "applied_groups": len(groups),
            "updated": res["updated"], "assets": res["assets"]}


class SceneDescIn(BaseModel):
    model_id: Optional[str] = None
    #: True = 连已有描述的场景一起重写。默认 False——用户手改过的描述
    #: 绝不能被 AI 重跑覆盖（A6 那次数据丢失的教训）。
    overwrite: bool = False


@router.post("/projects/{project_id}/scenes/describe")
async def describe_project_scenes(project_id: str,
                                  body: Optional[SceneDescIn] = None) -> dict:
    """为项目的所有场景生成文字描述并写入 `Asset.prompt`（Q3，纯文本调用不出图）。

    ## 为什么需要它

    场景参考图的提示词原来长这样：

        影视场景参考图：星云塔顶层-星空餐厅。要求：完整呈现空间布局…

    模型只拿到一个**场景名**——因为 `Asset.prompt` 恒为空（实测两个项目
    117/117 与 65/65 全空），永远走兜底分支。角色侧有 costumes.py 产出造型描述，
    场景侧此前**没有任何环节**产出描述，这是结构性缺口。

    跑完之后同一个接口的提示词会带上空间/陈设/材质/光线的具体描述，
    生图质量与画风稳定性都会明显不同。
    """
    from .scene_desc import generate_scene_descriptions
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    try:
        out = await generate_scene_descriptions(
            project_id,
            model_id=body.model_id if body else None,
            overwrite=bool(body.overwrite) if body else False)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"场景描述生成失败: {e!r}")
    return {"ok": True, **out}


class CharAliasIn(BaseModel):
    model_id: Optional[str] = None


@router.post("/projects/{project_id}/characters/canonicalize")
async def canonicalize_project_characters(project_id: str,
                                          body: Optional[CharAliasIn] = None) -> dict:
    """跑一次角色名归一（一次文本模型调用，**不出图、不花生图钱**，N2）。

    把同一个人的多种写法归到一个标准名下：
        「少年陆明」+「陆明」→「陆明」（同一人的少年期，`age_stage` 区分）
        「江卫东的秘书」+「江卫东秘书」→ 择一（同一人的两种写法）

    ⚠️ 判定走 LLM 语义而非字面子串——实测「陆明父亲」⊃「陆明」但**是两个人**，
    按子串合并会让父子共用一张脸。归组保守：拿不准就不合并。

    幂等：只更新 `source='ai'` 的行，用户手改过的（`source='manual'`）不动。
    """
    from .char_alias import canonicalize_characters
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    try:
        out = await canonicalize_characters(project_id,
                                            body.model_id if body else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"角色归一失败: {e!r}")
    return {"ok": True, **out}


class CharAliasPatchIn(BaseModel):
    project_id: str
    raw_name: str
    #: 归一后的角色名。改这个就是"把这个写法并到那个角色去"；
    #: 填回它自己的名字 = 取消归一（误合并的修法）
    canonical: str
    age_stage: Optional[str] = None


@router.patch("/characters/alias")
def patch_character_alias(body: CharAliasPatchIn) -> dict:
    """人工改一条角色归一映射（`source='manual'`，AI 重跑时不被覆盖）。

    误合并的修法就是把其中一个写法的 canonical 改回它自己的名字。
    """
    import uuid as _uuid
    from .db import CharacterAlias
    with get_session() as session:
        if session.get(Project, body.project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        raw = (body.raw_name or "").strip()
        canon = (body.canonical or "").strip()
        if not raw or not canon:
            raise HTTPException(status_code=422, detail="raw_name 与 canonical 均不能为空")
        row = (session.query(CharacterAlias)
               .filter(CharacterAlias.project_id == body.project_id,
                       CharacterAlias.raw_name == raw).first())
        if row is None:
            row = CharacterAlias(id=_uuid.uuid4().hex[:12],
                                 project_id=body.project_id, raw_name=raw,
                                 canonical=canon, age_stage=body.age_stage,
                                 source="manual")
            session.add(row)
        else:
            row.canonical = canon
            row.age_stage = body.age_stage
            row.source = "manual"
        session.commit()
        return {"ok": True, "raw_name": raw, "canonical": canon,
                "age_stage": row.age_stage, "source": "manual"}


# ---------- 服装解析报告（花费闸门：先报数，用户点了才出图）----------
#: 每镜×角色的服装来源。与 jobs._auto_inject_refs 的 _rank 档位一一对应，
#: 是"注入时到底会用哪张图"的**说明书**，不是另一套判断逻辑。
_COSTUME_REASONS = {
    "explicit_variant": "剧本明写的镜号变体",
    "scene_inherited": "同场景沿用（场景决定型服装）",
    "scene_event": "同场景同集的事件型服装",
    "base_stage": "该集基础造型",
    "generic_asset": "角色通用定妆图",
    "none": "无可用参考图",
}


@router.get("/projects/{project_id}/costume-report")
def costume_report(project_id: str) -> dict:
    """逐镜×角色列出"这一镜会穿哪套、图从哪来"，并报出要花钱生成几张。

    这是用户确认的**花费闸门**数据源："先报数、等我点确认"——识别完先把清单和
    张数摊出来（免费复用的单独标出），用户点了才真去出图。

    判定与 `jobs._auto_inject_refs` 同口径（同一套档位、同一个归一场景判据），
    所以报告里写的就是生成时实际会发生的事，不会"报告一套、注入另一套"。
    """
    from .costumes import resolve_stage_image
    from .db import Asset, effective_characters
    from .scenes import canonical_map
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
        canon = canonical_map(session, project_id)
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        # 墓碑阶段不进诊断：它不会被注入，也不该被算进"要花钱生成几张"
        stages = stage_gate.alive(
            session.query(AssetStage)
            .filter(AssetStage.project_id == project_id)).all()
        # 墓碑角色的通用资产图不算"已有图"：它不会被注入，诊断表里报有图
        # 会让用户以为不用管，实际出图时那一镜没有任何角色参考。
        generic = {a.name for a in asset_gate.alive(
            session.query(Asset).filter(Asset.project_id == project_id,
                                        Asset.kind == "character")).all()
                   if a.image_url}
        by_char: dict[str, list[AssetStage]] = {}
        for st in stages:
            by_char.setdefault(st.character_name, []).append(st)

        rows: list[dict] = []
        for sh in shots:
            if sh.disabled or sh.is_special:
                continue
            cn = canon.get((sh.location or "").strip(), (sh.location or "").strip())
            for c in effective_characters(sh):
                pick, reason = None, "none"
                best = (9, 0)
                for st in by_char.get(c, []):
                    lo, hi = st.shot_from, st.shot_to
                    loc = (st.location or "").strip()
                    in_ep = st.ep_from <= sh.episode <= st.ep_to
                    has_shots = lo is not None or hi is not None
                    miss = ((lo is not None and sh.order < lo)
                            or (hi is not None and sh.order > hi))
                    if has_shots and not miss:
                        rank = (0, (hi - lo) if (lo is not None and hi is not None)
                                else 10 ** 6)
                        why = "explicit_variant"
                    elif st.scene_bound and loc and loc == cn:
                        rank, why = (1, 0), "scene_inherited"
                    elif loc and loc == cn and in_ep:
                        rank, why = (2, 0), "scene_event"
                    elif not has_shots and not loc and in_ep:
                        rank, why = (3, 0), "base_stage"
                    else:
                        continue
                    if rank < best:
                        best, pick, reason = rank, st, why
                if pick is None and c in generic:
                    reason = "generic_asset"
                img = resolve_stage_image(session, pick) if pick is not None else None
                rows.append({
                    "order": sh.order, "episode": sh.episode,
                    "scene": cn, "character": c,
                    "stage_id": pick.id if pick is not None else None,
                    "stage_name": pick.stage_name if pick is not None else None,
                    "reason": reason, "reason_label": _COSTUME_REASONS[reason],
                    "has_image": bool(img) or (pick is None
                                              and reason == "generic_asset"),
                })

        # 报数：要花钱的 = 自己没图、也不是指针行的阶段；免费的 = 指针行 + 已有图
        to_generate = [st for st in stages
                       if not st.image_url and not st.source_stage_id]
        free_reuse = [st for st in stages
                      if not st.image_url and st.source_stage_id]
        stage_rows = [{
            "id": st.id, "character_name": st.character_name,
            "stage_name": st.stage_name,
            "ep_from": st.ep_from, "ep_to": st.ep_to,
            "shot_from": st.shot_from, "shot_to": st.shot_to,
            "location": st.location, "scene_bound": bool(st.scene_bound),
            "has_image": bool(st.image_url),
            "reuse_of": st.source_stage_id,
        } for st in sorted(stages, key=lambda x: (x.character_name, x.ep_from,
                                                  x.shot_from or 0))]
    covered = sum(1 for r in rows if r["has_image"])
    return {
        "stages": stage_rows,
        "shots": rows,
        "summary": {
            "stages_total": len(stages),
            "to_generate": len(to_generate),      # 需要真去出图的张数（花钱）
            "free_reuse": len(free_reuse),        # 复用同一件衣服的图（免费）
            "scene_bound": sum(1 for st in stages
                               if st.scene_bound and (st.location or "").strip()),
            "shot_char_pairs": len(rows),
            "shot_char_covered": covered,
            "shot_char_uncovered": len(rows) - covered,
        },
    }


class StageDraftIn(BaseModel):
    project_id: str
    #: 角色先验：{角色名: none|growth|multi}（设计稿"成长路线"三选项，作为 AI 提示）
    priors: Optional[dict[str, str]] = None
    model_id: Optional[str] = None

_STAGE_SYSTEM_LEGACY_NOTE = (
    "全剧服装识别已迁到 app/costumes.py（逐集并发扫描 + 完整性复查）。"
    "原来那份一次性提示词把 script[:6000] 和前 300 个镜头一起喂进去，"
    "对 8000 字的 5 集短剧就已经截掉四分之一，与"
    "「尽可能全面地生成所有剧情所需的服装」这条要求直接矛盾。"
)

#: 兜底占位阶段的名字。一键成片/首帧链路在"角色一张定妆图都没有"时会补建这样
#: 一行来挂图（见 jobs._plan_default_stages 的调用点），它不含任何造型信息。
_PLACEHOLDER_STAGE = "默认造型"


def _is_placeholder_stage(st: AssetStage) -> bool:
    """是否为"兜底占位"阶段（可被真正的造型规划取代）。

    判定：名字是「默认造型」、description 空、且没有镜头级 shot 区间。
    这三条同时成立只可能出自自动补建的兜底路径——用户/AI 真规划出来的阶段
    一定带 description（会喂进生图提示词），变体一定带 shot 区间。
    """
    return (st.stage_name == _PLACEHOLDER_STAGE
            and not (st.description or "").strip()
            and st.shot_from is None and st.shot_to is None)


def _clip_ep_ranges(rows: list[dict], blocked: set[int]) -> list[dict]:
    """把基础阶段的集区间裁掉已被"受保护阶段"占用的集，必要时拆成多段。

    受保护阶段（已出图、且不是兜底占位）的集区间不可被本次规划覆盖，否则同一集
    会出现两条基础阶段，`_auto_inject_refs` 就得在两条等价候选里瞎猜。
    这里对每条规划区间求「可用集」的连续段：全被占 → 丢弃该条；部分被占 → 拆段
    （每段继承同样的 stage_name/description）。
    """
    out: list[dict] = []
    for r in rows:
        avail = [e for e in range(r["ep_from"], r["ep_to"] + 1) if e not in blocked]
        if not avail:
            continue
        runs: list[list[int]] = []
        for e in avail:
            if runs and e == runs[-1][1] + 1:
                runs[-1][1] = e
            else:
                runs.append([e, e])
        for a, b in runs:
            out.append({**r, "ep_from": a, "ep_to": b})
    return out


@router.post("/stages/draft")
async def stages_draft(body: StageDraftIn) -> dict:
    """全剧服装识别 → 造型阶段落库（HTTP 入口，同步等结果）。

    长剧建议走 `costume_scan` job（有进度、可关窗口），本入口留给资产页的
    「✨ AI 识别造型」按钮和既有调用方。
    """
    # 与批量生图互斥。识别会**删掉所有无图阶段行**再重建，而 asset_batch
    # 正在往这些行写 image_url —— 行被删掉后，已生成（已付费）的图就成了
    # 孤儿，用户看到绿勾和空槽位。
    # jobs 侧的 _EXCLUSIVE_GROUPS 只管 job 之间；本接口是同步 HTTP，
    # 不经 find_active_job，所以必须在这里自己挡一次。
    from .jobs import find_active_job
    busy = find_active_job("asset_batch", body.project_id, None)
    if busy:
        raise HTTPException(
            status_code=409,
            detail="资产批量生图正在进行中，此时重新识别造型会删掉正在写入的阶段行。"
                   "请等待生图完成或先停止该任务。",
        )
    return await run_stages_draft(body.project_id, body.model_id, body.priors)


async def run_stages_draft(project_id: str, model_id: str | None = None,
                           priors: Optional[dict[str, str]] = None,
                           progress_cb=None) -> dict:
    """全剧服装识别 → 造型阶段落库。

    识别本体在 `app/costumes.py`（逐集并发扫描 + 完整性复查，见该模块头部说明）。
    这里只负责把识别结果**增量地**落进 `asset_stages`，规则三条：

    1. **已出图的阶段一律不删不改区间**（用户的钱已经花在那张图上）。本次规划只在
       它没占用的集/镜头上做增量；唯一例外是"兜底占位阶段"
       （`_is_placeholder_stage`），它没有任何造型信息，会被真正的规划取代，
       图继承过去不浪费。
    2. **同一件衣服只有一张图**。同角色同衣服名在相隔很远的镜头段各出现一次时，
       只有第一段是"源"，其余段建成指针行（`source_stage_id`）共用源那张图。
       已出图的行天然优先当源。
    3. **场景绑定原样落库**（`location` + `scene_bound`）。注入时它是一整个优先级
       档位：剧本明写的镜号变体 > 场景绑定服装 > 基础阶段 > 角色通用图，
       其中场景绑定档**不看集区间**——"第 1 集卧室白色睡衣，第 10 集同一个卧室
       剧本没写衣着"就是靠这一档沿用同一张图的。

    `progress_cb(pct, note)`：0-100 的粗粒度进度（归一 → 逐集识别 → 落库），
    供 `jobs.run_costume_scan` 往 job 上报；HTTP 入口不传。

    **纯文本调用，不生成任何图片**（识别只决定"有哪些造型"，出图是另一步，
    由用户在生产检查弹窗里看过报数再点）。
    """
    from .costumes import recognize_costumes

    def _p(pct: int, note: str = "") -> None:
        if progress_cb:
            try:
                progress_cb(pct, note)
            except Exception:  # noqa: BLE001 上报进度失败不影响识别
                logger.debug("[stages_draft %s] progress_cb 抛错，忽略", project_id)

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        if not (proj.optimized_script or proj.raw_script):
            raise HTTPException(status_code=400, detail="项目没有剧本，请先导入")
        # 既有的"已出图"阶段按角色归档。**不整个角色跳过**（那曾是一个真实 bug：
        # 角色只要出过一张图，造型规划就被永久冻结，于是每个角色永远只有一张资产图）。
        # 保护的本意只是"别把用户已花钱出图的阶段删掉/改区间"，那是**改写**；
        # 而**新增**阶段并不冒犯这条。
        # 墓碑阶段不进 kept：它既不该被"保护"（用户就是要它消失），也不该占集区间
        # 让规划避开——那会让重跑识别后照旧缺一段造型，且用户看不出为什么。
        kept: dict[str, list[dict]] = {}
        for s in (stage_gate.alive(
                  session.query(AssetStage)
                  .filter(AssetStage.project_id == project_id,
                          AssetStage.image_url.isnot(None)))
                  .order_by(AssetStage.ep_from).all()):
            kept.setdefault(s.character_name, []).append({
                "id": s.id, "stage_name": s.stage_name,
                "ep_from": s.ep_from, "ep_to": s.ep_to,
                "shot_from": s.shot_from, "shot_to": s.shot_to,
                "image_url": s.image_url,
                "placeholder": _is_placeholder_stage(s),
            })

    # 场景归一必须先于服装识别：识别时要让模型用**归一场景名**回填 scene 字段，
    # 否则"同一个场景"根本判不出来（实测 22 个场景名跨集复用率为 0）。
    # 幂等、且人工改过的映射不会被覆盖，所以每轮都跑无副作用。
    from .scenes import canonicalize_scenes
    _p(3, "场景归一中")
    try:
        scene_info = await canonicalize_scenes(project_id, model_id)
    except Exception as e:  # noqa: BLE001 归一失败退回确定性清洗，不阻断识别
        logger.warning("[stages_draft %s] 场景归一失败，按原名处理: %r",
                       project_id, e)
        scene_info = {"scenes": [], "updated": 0, "llm": False}

    _p(15, "逐集扫描服装")

    def _scan_progress(done: int, total: int) -> None:
        # 逐集识别占 15-90：这一段最久（每集一次 LLM 调用），进度必须动起来
        _p(15 + int(75 * done / max(1, total)), f"已扫描 {done}/{total} 集")

    try:
        plan = await recognize_costumes(project_id, model_id, priors,
                                        progress_cb=_scan_progress)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"AI 识别失败: {e!r}")

    # ⚠️ 动库之前先确认方案是完整的。
    #
    # 下面的重建是「先无条件删除所有无图阶段，再按 plan 写回」。
    # 如果 LLM 这次全线失败（限流/超时/服务抖动），plan 会是空的 ——
    # 删除照常执行，重建循环遍历空列表，结果就是用户点了一下
    # 「AI 识别造型」，整套已规划好的造型阶段和指针行全没了，
    # 接口还返回 200「识别完成」。
    #
    # 单集失败也不行：那样重建出来的方案缺了几集，同样是用残缺覆盖完整。
    failed_eps = plan.get("failed_episodes") or []
    if failed_eps:
        raise HTTPException(
            status_code=502,
            detail=(f"第 {', '.join(map(str, failed_eps[:8]))} "
                    f"{'等 ' + str(len(failed_eps)) + ' 集' if len(failed_eps) > 8 else '集'}"
                    "识别失败，已中止以免覆盖现有造型方案。请稍后重试。"),
        )
    if not (plan.get("base") or plan.get("variants")):
        raise HTTPException(
            status_code=502,
            detail="AI 未识别出任何造型，已中止以免清空现有方案。请检查剧本内容或稍后重试。",
        )

    _p(92, "写入造型阶段")

    max_ep = plan["max_ep"]
    base_by_char: dict[str, list[dict]] = {}
    var_by_char: dict[str, list[dict]] = {}
    for r in plan["base"]:
        base_by_char.setdefault(r["character"], []).append(r)
    for r in plan["variants"]:
        var_by_char.setdefault(r["character"], []).append(r)

    created = 0
    variants = 0
    bound = 0                       # 场景绑定服装数（跨集沿用同一张图的那批）
    followers = 0                   # 指针行数（复用同衣图，不额外出图）
    reused = 0                      # 继承了兜底占位图的新阶段数（省下的生图钱）
    locked_names: set[str] = set()  # 有受保护阶段、本次只做增量的角色
    with get_session() as session:
        # 只清无图的阶段，保留已出图的（那条时间线不被覆盖）。
        # 指针行也一并清掉——它没有自己的图，重算成本为零，留着反而会指向已删的源。
        #
        # ⚠️ `deleted_at.is_(None)`：**墓碑必须留着**。一个被用户删掉的无图阶段
        # 若在这里被真删，「已删除」组里的恢复入口就跟着消失了——用户点一次
        # 「服装识别」，之前删掉的东西就再也撤销不回来（软删白软了）。
        session.query(AssetStage).filter(
            AssetStage.project_id == project_id,
            AssetStage.deleted_at.is_(None),
            AssetStage.image_url.is_(None)).delete()

        for name in sorted(set(base_by_char) | set(var_by_char)):
            mine = kept.get(name, [])
            holders = [k for k in mine if k["placeholder"]]      # 可被取代的兜底行
            locked = [k for k in mine if not k["placeholder"]]   # 受保护，不动
            if locked:
                locked_names.add(name)
            # 受保护的**基础**阶段（无 shot 区间）占掉的集，本次不再规划基础阶段；
            # 受保护的变体只占几个镜头，不封整集，所以不进 blocked。
            blocked = {e for k in locked
                       if k["shot_from"] is None and k["shot_to"] is None
                       for e in range(k["ep_from"], k["ep_to"] + 1)}
            # 已出图的变体签名，用于去重（同一件衣服同一段镜头不重复建、不重复烧钱）
            var_seen = {(k["stage_name"], k["shot_from"], k["shot_to"])
                        for k in mine if k["shot_from"] is not None
                        or k["shot_to"] is not None}
            # 同衣服的"源"登记表：已出图的行天然优先当源（图已经在它身上）
            owner: dict[str, str] = {}
            for k in mine:
                owner.setdefault(k["stage_name"], k["id"])

            # ---- 基础阶段 ----
            base = [{"stage_name": r["stage_name"], "ep_from": r["ep_from"],
                     "ep_to": min(r["ep_to"], max_ep),
                     "description": r["description"]}
                    for r in sorted(base_by_char.get(name, []),
                                    key=lambda x: x["ep_from"])
                    if r["ep_from"] <= max_ep]
            # 避让受保护阶段占用的集。全被占的角色 base 会变成空——这时兜底占位行
            # 必须留着，否则该角色会一张图都没有。
            base = _clip_ep_ranges(base, blocked)
            for st in base:
                # 继承兜底占位图：占位行本来就没有造型信息，它那张图对新基础阶段
                # 同样适用。一个占位图只继承给一条新阶段。
                inherit = next((h for h in holders if not h.get("_used")
                                and h["ep_from"] <= st["ep_to"]
                                and h["ep_to"] >= st["ep_from"]), None)
                if inherit is None:
                    inherit = next((h for h in holders if not h.get("_used")), None)
                if inherit is not None:
                    inherit["_used"] = True
                    reused += 1
                sid = uuid.uuid4().hex[:12]
                session.add(AssetStage(
                    id=sid, project_id=project_id,
                    character_name=name, stage_name=st["stage_name"],
                    ep_from=st["ep_from"], ep_to=st["ep_to"],
                    description=st["description"], status="draft",
                    image_url=inherit["image_url"] if inherit else None,
                ))
                owner.setdefault(st["stage_name"], sid)
                created += 1
            # 占位行只在真被取代（本次为该角色写下了基础阶段）时才删；否则留着，
            # 不能让角色因为一次规划失手变成"零定妆图"。
            if base:
                for h in holders:
                    old = session.get(AssetStage, h["id"])
                    if old is not None:
                        session.delete(old)

            # ---- 服装变体 ----
            # 排序保证"源"先落库、指针行后落库（follow=False 优先），
            # 否则指针会指向一个还不存在的 id。
            for st in sorted(var_by_char.get(name, []),
                             key=lambda x: (bool(x["follow"]),
                                            x["shot_from"] or 0)):
                key = (st["stage_name"], st["shot_from"], st["shot_to"])
                if key in var_seen:
                    continue          # 同一件衣服同一段镜头已出图，不重复建
                src = owner.get(st["stage_name"])
                # follow=True（同衣的后续镜头段）或该衣服已有源 → 建指针行共用图
                is_follower = bool(st["follow"]) or src is not None
                sid = uuid.uuid4().hex[:12]
                session.add(AssetStage(
                    id=sid, project_id=project_id,
                    character_name=name, stage_name=st["stage_name"],
                    ep_from=max(1, min(st["ep_from"], max_ep)),
                    ep_to=max(1, min(max(st["ep_from"], st["ep_to"]), max_ep)),
                    shot_from=st["shot_from"], shot_to=st["shot_to"],
                    description=st["description"], status="draft",
                    location=st["scene"] or None,
                    scene_bound=1 if st["scene_bound"] else 0,
                    source_stage_id=src if is_follower else None,
                ))
                if not is_follower:
                    owner[st["stage_name"]] = sid
                else:
                    followers += 1
                created += 1
                variants += 1
                if st["scene_bound"]:
                    bound += 1
        session.commit()
    return {
        "created": created,
        "variants": variants,
        # 场景决定型服装数：这批会在"人物再次进入同一场景、剧本没写衣着"时
        # 沿用同一张图（跨多少集都算），是"同一场景同一人物服装相同"的落点
        "scene_bound": bound,
        # 指针行数：与别的阶段是同一件衣服，共用图、不额外出图（省下的生图钱）
        "followers": followers,
        "reused_images": reused,
        # 扫描覆盖面：逐集并发扫了几段（用于向用户证明没有截断剧本）
        "episodes_scanned": plan["scanned"],
        # 归一后的场景数（同一个物理空间跨集只算一个）
        "scenes": len(scene_info.get("scenes") or []),
        # 语义：不是"整个角色被跳过"，而是"这些角色有已出图的阶段被保留，
        # 本次只在它没覆盖的集/镜头上做增量"
        "skipped_with_image": sorted(locked_names),
    }



class StageCandidatesIn(BaseModel):
    n: int = 4
    model_id: Optional[str] = None


@router.post("/stages/{stage_id}/candidates")
async def stage_candidates(stage_id: str, body: StageCandidatesIn) -> dict:
    """⚠️ **已被取代，新代码不要用**：候选定妆图请走 job 化的
    `POST /v2/assets/candidates` + `GET /v2/assets/candidates`。

    这是**同步版**：在一次 HTTP 请求里等所有图出完才返回。缺点致命——出 4 张要
    一两分钟，期间请求挂着、关掉弹窗就丢结果、任务抽屉里看不见、失败了什么也没留下。
    job 化那条路解决了以上全部，现网页端用的就是它。

    保留原因**只有一个**：桌面客户端自带前端产物（`frontendDist: "../dist"`），
    已安装的旧 Beta 里跑的是调这条路由的旧代码。删掉 = 那些用户的资产弹窗当场报错，
    而他们只能靠自己去点「检查更新」才能拿到新前端（S2 已经吃过这个教训）。
    所以它只是**兼容层**，不再是功能入口：

      · 前端包装 `api.stageCandidates` 已删除，`desktop/src` 里不应再出现它；
      · 不要给这条路由加新能力（换模型/排除图/张数上限之类）—— 加了只会让
        "候选图到底走哪条路"重新变成两个答案。复审误判就是这么来的，见
        `docs/AUDIT-2026-09-11-全面复审.md` 的 U6。

    与批量生图同口径：该角色**别的阶段**已有图时喂进去做参考，否则同一个人
    换个造型就换张脸。本阶段自己的图排除在外（拿它当参考等于原地复制）。
    """
    with get_session() as session:
        st = session.get(AssetStage, stage_id)
        if not st:
            raise HTTPException(status_code=404, detail="stage not found")
        # 已删除的阶段不给生候选图：那是**花钱**的操作，而出来的图无处可去
        # （PATCH 会被墓碑校验挡掉）。让用户先恢复。
        if st.deleted_at:
            raise HTTPException(status_code=409,
                                detail="该造型阶段已删除，请先恢复再生成候选图")
        prompt = (f"角色定妆照, {st.character_name}, {st.stage_name}, "
                  f"{st.description or ''}, 全身, 正面, 高质量, 短剧风格, 纯色背景")
        from .asset_ref import character_base_ref
        base = character_base_ref(session, st.project_id, st.character_name,
                                  exclude_stage_ids={stage_id})
    provider = ImageProvider(model_id=body.model_id)
    try:
        urls = await provider.generate(prompt, n=max(1, min(body.n, 9)),
                                       ref_urls=[base] if base else None)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"候选图生成失败: {e!r}")
    return {"urls": urls, "prompt": prompt, "ref_used": base}


class ShotOverrideIn(BaseModel):
    #: 镜头级策略覆盖（契约 C7 最高优先级）；null=清除覆盖回到继承
    profile_override: Optional[dict] = None
    is_special: Optional[bool] = None


@router.post("/shots/{shot_id}/override")
def set_shot_override(shot_id: str, body: ShotOverrideIn) -> dict:
    """保存镜头级覆盖（模型/模式/时长/画质/参考素材/提示词，R1-1 三层策略）。"""
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")
        shot.profile_override = (
            json.dumps(body.profile_override, ensure_ascii=False)
            if body.profile_override else None)
        if body.is_special is not None:
            shot.is_special = 1 if body.is_special else 0
        session.commit()
        return {"ok": True, "shot_id": shot_id,
                "has_override": shot.profile_override is not None}


# ---------- 时间轴归一（P0-3）：镜头轨是唯一真源 ----------
# 设计：外部素材（片头/片尾/转场/实拍）作为 is_special=1 的镜头插入镜头轨，
# 与 AI 镜头共用同一条轨、同一套导出逻辑，不再有第二条"剪辑时间轴"。
# 轻剪辑只保留三件事：改时长（整数秒，上限随视频模型）、改顺序、停用。


class SpecialShotIn(BaseModel):
    project_id: str
    #: 展示名（片头/片尾/转场/实拍片段等）
    name: str
    #: 已上传素材的相对地址（/fw/media/uploads/xxx）
    video_url: str
    #: 插入位置：放在该 order 之后；缺省=追加到末尾
    after_order: Optional[int] = None
    duration_sec: Optional[float] = None


def _remap_anchors(session, project_id: str, mapping: dict[int, int]) -> int:
    """把音频/字幕的锚点 order 按 mapping 搬迁。返回搬动的行数。

    ⚠️ 为什么必须做：AudioClip.start_shot_order / SubtitleClip.start_shot_order
    是**普通整数**，不是外键。重编号只改 Shot.order，这些锚点原地不动，
    结果就是分割镜头、插入片头、调序、增量拆解之后，
    所有挂在后面的旁白与字幕**整体错位到别的镜头上**，且没有任何提示。
    （超出新末尾的锚点还会在 SRT 导出时被静默跳过。）

    mapping: 旧 order → 新 order。没列出的 order 保持不动。
    """
    if not mapping:
        return 0
    from .db import AudioClip, SubtitleClip
    moved = 0
    for model in (AudioClip, SubtitleClip):
        rows = (session.query(model)
                .filter(model.project_id == project_id).all())
        for r in rows:
            new = mapping.get(r.start_shot_order)
            if new is not None and new != r.start_shot_order:
                r.start_shot_order = new
                moved += 1
    if moved:
        logger.info("[renumber %s] 同步搬迁 %d 条音频/字幕锚点", project_id, moved)
    return moved


def _renumber(session, project_id: str) -> None:
    """把 order 规整为 1..N 连续整数（插入/移动后调用），并同步搬迁锚点。"""
    shots = (session.query(Shot).filter(Shot.project_id == project_id)
             .order_by(Shot.order).all())
    mapping: dict[int, int] = {}
    for i, s in enumerate(shots, start=1):
        if s.order != i:
            mapping[s.order] = i
            s.order = i
    # 与重编号同一事务：分开提交的话，中间崩溃会留下错位的锚点
    _remap_anchors(session, project_id, mapping)


@router.post("/shots/special")
def add_special_shot(body: SpecialShotIn) -> dict:
    """把外部素材作为特殊镜头插入镜头轨（片头/片尾/转场/实拍）。"""
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        name = (body.name or "").strip()
        if not name:
            raise HTTPException(status_code=422, detail="name required")
        if not (body.video_url or "").strip():
            raise HTTPException(status_code=422, detail="video_url required")

        shots = (session.query(Shot).filter(Shot.project_id == body.project_id)
                 .order_by(Shot.order).all())
        if body.after_order is None:
            insert_at = (shots[-1].order + 1) if shots else 1
        else:
            insert_at = body.after_order + 1
            for s in shots:
                if s.order >= insert_at:
                    s.order += 1
        session.flush()

        dur = body.duration_sec
        if dur is not None:
            # 上限跟项目的视频模型走：粘贴一段 28s 的 2.5 长镜时，写死 15
            # 会让副本比原件短一半（时间轴上就是"粘贴出来的那条对不上"）。
            dur = max(1.0, min(shot_duration_ceiling(
                session.get(Project, body.project_id)), float(dur)))
        # 继承插入位置前一镜的集号，保证按集分组/集号色条不出现空洞
        prev_ep = 1
        for s in shots:
            if s.order < insert_at:
                prev_ep = s.episode
        shot = Shot(
            id=uuid.uuid4().hex[:12], project_id=body.project_id, order=insert_at,
            script_ref=name, link_to_prev="cut", characters="[]",
            location=None, video_url=body.video_url.strip(),
            episode=prev_ep, status="adopted", is_special=1,
            special_name=name, duration_sec=dur,
        )
        session.add(shot)
        session.flush()
        _renumber(session, body.project_id)
        session.commit()
        return {"ok": True, "shot_id": shot.id, "order": shot.order}


class RefOverridesIn(BaseModel):
    """P1-2 资产轨拖拽落库：一次事务批量增删某角色/场景的注入覆写（L3）。

    语义（PLAN §4.4）：向外拖 → 被纳入的镜头进 shot_ids_add；向内拖 → 被排除的进
    shot_ids_remove；「↺ 重置为 AI 判定」→ reset_shot_ids（清掉该角色在这些镜头上的
    全部人工痕迹）。写入时与 L1（Shot.characters）对消：
    - add 且 L1 本来就有 → 只是撤销此前的 remove；
    - remove 且 L1 本来就没有 → 只是撤销此前的 add；
    保证 ref_overrides 里只存「与 AI 判定不同」的最小差集，重拆后语义依旧成立。
    P1-3：is_location=True 时 character 字段填场景名，覆写走 add_loc/remove_loc，
    L1 真值为 Shot.location（单值）。
    """
    project_id: str
    character: str
    shot_ids_add: list[str] = []
    shot_ids_remove: list[str] = []
    reset_shot_ids: list[str] = []
    is_location: bool = False


@router.post("/shots/ref-overrides")
def patch_ref_overrides(body: RefOverridesIn) -> dict:
    from .db import effective_characters
    from .scenes import canonical_locations, canonical_of
    char = (body.character or "").strip()
    if not char:
        raise HTTPException(status_code=422, detail="character required")
    ids = set(body.shot_ids_add) | set(body.shot_ids_remove) | set(body.reset_shot_ids)
    if not ids:
        return {"ok": True, "affected": [], "stale": []}
    if set(body.shot_ids_add) & set(body.shot_ids_remove):
        raise HTTPException(status_code=400, detail="同一镜头不能同时 add 和 remove")

    # 角色与场景共用同一套对消逻辑，仅 L1 取值与 JSON 键名不同
    k_add = "add_loc" if body.is_location else "add"
    k_rm = "remove_loc" if body.is_location else "remove"

    affected: list[dict] = []
    stale_orders: list[int] = []
    with get_session() as session:
        # 场景侧全程走**归一名**：场景轨展示的是归一名，用户点"移除"传回来的
        # 就是归一名。若拿它去比原名 L1（「夜 内 楚家公馆-客厅」），
        # 下面 `char in l1` 恒为假 → remove 压根不会写进去，移除**静默失效**。
        if body.is_location:
            char = canonical_of(session, body.project_id, char) or char

        def effective(s) -> list[str]:
            return (canonical_locations(session, body.project_id, s)
                    if body.is_location else effective_characters(s))

        shots = (session.query(Shot)
                 .filter(Shot.project_id == body.project_id, Shot.id.in_(ids))
                 .order_by(Shot.order).all())
        found = {s.id for s in shots}
        missing = ids - found
        if missing:
            raise HTTPException(status_code=404,
                                detail=f"镜头不存在或不属于该项目: {sorted(missing)}")
        for s in shots:
            before = set(effective(s))
            if body.is_location:
                cn = canonical_of(session, body.project_id, s.location)
                l1 = {cn} if cn else set()
            else:
                try:
                    l1 = {c for c in json.loads(s.characters or "[]")
                          if isinstance(c, str) and c}
                except json.JSONDecodeError:
                    l1 = set()
            try:
                ov = json.loads(s.ref_overrides) if s.ref_overrides else {}
            except json.JSONDecodeError:
                ov = {}
            add = [c for c in ov.get(k_add, []) if isinstance(c, str)]
            remove = [c for c in ov.get(k_rm, []) if isinstance(c, str)]
            if body.is_location:
                # 存量覆写里可能还是原名，与归一后的 char 比不相等 →
                # "撤销加入/撤销排除"会失效。写回前就地归一，顺手把老数据洗干净。
                add = list(dict.fromkeys(
                    x for x in (canonical_of(session, body.project_id, c)
                                for c in add) if x))
                remove = list(dict.fromkeys(
                    x for x in (canonical_of(session, body.project_id, c)
                                for c in remove) if x))

            if s.id in set(body.reset_shot_ids):
                add = [c for c in add if c != char]
                remove = [c for c in remove if c != char]
            elif s.id in set(body.shot_ids_add):
                remove = [c for c in remove if c != char]      # 撤销排除
                if char not in l1 and char not in add:
                    add.append(char)                            # 真值没有才需显式 add
            else:  # shot_ids_remove
                add = [c for c in add if c != char]             # 撤销加入
                if char in l1 and char not in remove:
                    remove.append(char)                         # 真值有才需显式 remove

            # 只存最小差集；全空则回 NULL（= 完全跟随 AI 判定）
            keep = {k: v for k, v in ov.items() if k not in (k_add, k_rm)}
            if add:
                keep[k_add] = add
            if remove:
                keep[k_rm] = remove
            s.ref_overrides = (json.dumps(keep, ensure_ascii=False) if keep else None)

            after = set(effective(s))
            changed = after != before
            # 已出片镜头的注入集合真的变了 → 标记待重生成（不自动重跑，避免烧钱）
            if changed and s.video_url:
                s.refs_stale = 1
                stale_orders.append(s.order)
            affected.append({"shot_id": s.id, "order": s.order,
                             "changed": changed,
                             "effective_characters": sorted(after),
                             "refs_stale": bool(s.refs_stale)})
        session.commit()
    return {"ok": True, "affected": affected, "stale": sorted(stale_orders)}


def transform_rev(raw: str | None) -> str:
    """`transform_meta` 的版本号（2.3 乐观锁）——**由内容算出，不新增列**。

    为什么不加 `updated_at`/`version` 列：
      · 新列对**老数据**一律是 NULL/0，那批镜头等于没有锁，而它们恰恰是
        用户手里最多的数据；内容哈希对每一行**当场就有效**。
      · 哈希的语义正是锁要表达的那句话——「我这次改动是基于这份内容的」。
        两个端各自把同一个值写一遍时（例如都把 opacity 拖到 100）内容相同、
        rev 相同，不会冒出一个假冲突；而列式版本号会。

    已知且可接受的边界：A→B→A 的回退会让 rev 回到 A，此时持有旧 rev 的端
    可以写入——但它写的确实是**基于当前内容**的改动，不存在"盖掉了谁的东西"，
    所以这不是 ABA 漏洞，只是"没有冲突"。

    取 sha1 前 12 位：这是并发检测用的短令牌，不是安全用途；
    每次写入都会换值，碰撞的后果最坏也只是漏掉一次冲突提示。
    """
    if not raw:
        return "0"           # 没有任何调整也要有个稳定的版本号，否则首次写入无从比对
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


class ShotTimelineIn(BaseModel):
    """轻剪辑：时长 / 顺序 / 停用 / 画面调整。各项都可单独下发。"""
    #: 目标时长（秒）；服务端按 2 位小数钳到 [1, 模型单镜上限]。
    #: 小数是刻意允许的（3.2）：剪辑的落点由台词/动作决定，不会正好落在整秒。
    duration_sec: Optional[float] = None
    #: 目标位置（1-based order）；移动后全项目重新连续编号
    to_order: Optional[int] = None
    disabled: Optional[bool] = None
    #: TB-03/TB-10 画面与音频调整（缩放/旋转/位移/不透明度/镜像/变速/音量/淡化）。
    #: 传空字典 {} = 清除全部调整，回到原始画面。
    transform_meta: Optional[dict] = None
    #: 2.3 乐观锁：客户端这次改动**所基于的** transform_meta 版本号
    #: （见 transform_rev()，由 /detail 与本接口的响应下发）。
    #: 与当前库里的不一致 → 409，不静默覆盖。
    #: None = 不做并发校验（老客户端、以及只改时长/顺序的调用）。
    base_transform_rev: Optional[str] = None
    #: Render V2 多轨：移到第几条视频轨（0=主轨，1+=Overlay）
    track_index: Optional[int] = None
    #: 移到 Overlay 轨时的起始秒（主轨忽略）
    overlay_start_sec: Optional[float] = None
    #: 3.1 取片窗口的入点（秒，相对**素材**开头）。导出与字幕定时读的是窗口，
    #: 不是 duration_sec —— 所以"左边缘修剪"必须走这里，改 duration_sec 没用。
    clip_in_sec: Optional[float] = None
    #: 3.1 取片窗口的长度（秒）。落库时**同步回写 duration_sec**，见下方不变式说明。
    clip_dur_sec: Optional[float] = None
    #: 3.1 取消入点：把 clip_in_sec / clip_dur_sec 一起清空（回到"整段使用"）。
    #: 需要一个显式开关是因为 None 已经表示"本次不动该字段"，无法用它表达"清空"。
    clear_clip_window: Optional[bool] = None


@router.patch("/shots/{shot_id}/timeline")
def patch_shot_timeline(shot_id: str, body: ShotTimelineIn) -> dict:
    """镜头轨上的轻剪辑操作（唯一真源，导出直接消费本表）。"""
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")

        # 2.3 乐观锁：校验放在**任何改动之前**——本接口一次可以同时改时长、
        # 顺序和画面，若先改了前两项再发现画面冲突，用户会得到一次"半成功"的
        # 保存（时长变了、画面没变，而提示只说了冲突）。这里直接拒整笔。
        if body.transform_meta is not None and body.base_transform_rev is not None:
            cur = transform_rev(shot.transform_meta)
            if cur != body.base_transform_rev:
                raise HTTPException(
                    status_code=409,
                    detail=(f"该镜头的画面调整已被其他窗口修改"
                            f"（当前版本 {cur}，你基于 {body.base_transform_rev}）"),
                )

        if body.duration_sec is not None:
            # 钳到 [1, 模型单镜上限]。上限**不是常数 15**：seedance-2.5 是 30s，
            # 见 shot_duration_ceiling。
            #
            # 3.2：这里原来是 `round(float(...))` —— **整数秒**。那不是精度问题，
            # 是"这个软件不能用来剪片"：一句台词说完在 2.4s，用户只能选 2s
            # （切掉半个字）或 3s（留 0.6s 空镜），而且前端拖到 2.4 也会被这一行
            # 悄悄改成 2，用户看到的是"我拖了它自己弹回去"。
            # 改为保留 2 位小数（与 split_shot 的 round(x, 2) 同精度）。
            # 生成侧不受影响：provider 自己会 int(round(duration_ms/1000)) 并
            # 吸附到 duration_slots，小数进得去、出来仍是合法档位。
            ceil = shot_duration_ceiling(session.get(Project, shot.project_id))
            shot.duration_sec = float(
                max(1.0, min(float(ceil), round(float(body.duration_sec), 2))))
        # ---- 3.1 取片窗口（入点/出点）----
        #
        # 顺序要紧：窗口在 duration_sec 之后处理，因为写窗口长度时要**同步回写**
        # duration_sec 以维持不变式，必须盖在上面那一段之后。
        #
        # 不变式：`duration_sec == clip_dur_sec`（窗口存在时）。
        # `split_shot` / `unsplit_shot` 一直在维持它，本接口是第三个写入者。
        # 不维持会怎样：时间轴按 duration_sec 排版、导出按 clip_dur_sec 取片，
        # 于是"轨上是 2.4s、成片里是 5s"，且没有任何提示 —— 这正是 3.2 落地后
        # 仍然残留的那个缺口（改右边缘对 split 过的镜头不生效）。
        if body.clear_clip_window:
            # 取消入点：回到"整段使用"。**不动 duration_sec** ——
            # 后端不知道源文件多长，能诚实做到的只是"起点回到 0，长度不变"。
            shot.clip_in_sec = None
            shot.clip_dur_sec = None
        if body.clip_in_sec is not None:
            shot.clip_in_sec = max(0.0, round(float(body.clip_in_sec), 2))
        if body.clip_dur_sec is not None:
            # 下界取 0.1 而不是 1.0：`split_shot` 只保证两侧各留 0.5s，
            # 库里真实存在 0.75s / 0.99s 的碎片。若这里 floor 到 1.0，
            # 用户拖一个 0.75s 的碎片会被**拉长**成 1.0s —— 想剪短反而变长。
            # 窗口是"在已有素材上取片"，不受生成侧时长档位约束；
            # 上面那条 duration_sec 分支的 1.0 下界保持不动（那里它还是生成目标）。
            ceil2 = shot_duration_ceiling(session.get(Project, shot.project_id))
            shot.clip_dur_sec = float(
                max(0.1, min(float(ceil2), round(float(body.clip_dur_sec), 2))))
            shot.duration_sec = shot.clip_dur_sec       # ← 不变式，见上
        if shot.clip_in_sec is not None and shot.clip_dur_sec is None:
            # 只给了入点、没给长度：这是**半个窗口**，而它是有害的 ——
            # 导出侧读 `clip_in_sec ?? 0` 作为 -ss、读 `clip_dur_sec ?? duration_sec`
            # 作为 -t，于是成片会从入点起取满 duration_sec（比用户看到的长）；
            # 而前端判"有没有窗口"看的是 clip_dur_sec，会认为这镜没被修剪过。
            # 补齐成完整窗口，两边口径就一致了。正常调用方（inPatch）总是两个一起发，
            # 这里是兜住"将来有人只发一半"的结构性防线。
            shot.clip_dur_sec = float(shot.duration_sec or 0) or None
        if body.track_index is not None:
            # 移到 Overlay 轨的镜头不再参与主轨顺序累加，必须有显式起点，
            # 否则它会"消失"在时间轴上（既不排队也没有位置）
            shot.track_index = max(0, int(body.track_index))
            if shot.track_index > 0 and shot.overlay_start_sec is None:
                shot.overlay_start_sec = 0.0
        if body.overlay_start_sec is not None:
            shot.overlay_start_sec = max(0.0, float(body.overlay_start_sec))
        if body.transform_meta is not None:
            # TB-03/TB-10：空字典视为"清除全部调整"，存 NULL 让导出走常规快路径
            shot.transform_meta = (json.dumps(body.transform_meta, ensure_ascii=False)
                                   if body.transform_meta else None)
        if body.disabled is not None:
            shot.disabled = 1 if body.disabled else 0
        if body.to_order is not None:
            others = (session.query(Shot)
                      .filter(Shot.project_id == shot.project_id, Shot.id != shot.id)
                      .order_by(Shot.order).all())
            tgt = max(1, min(len(others) + 1, int(body.to_order)))
            # 其余镜头按目标位让位，自己占住 tgt，再统一重排收敛为 1..N
            for i, s in enumerate(others, start=1):
                s.order = i if i < tgt else i + 1
            shot.order = tgt
            session.flush()
            _renumber(session, shot.project_id)

        session.commit()
        return {"ok": True, "shot_id": shot.id, "order": shot.order,
                "duration_sec": shot.duration_sec, "disabled": bool(shot.disabled),
                # 3.1：把落库后的取片窗口回给客户端。前端拖左边缘是"出点钉住、
                # 入点跟手"，下一次拖动要基于**服务端认定的**入点算，
                # 不回传就只能等一次 /detail，中间那一下会基于旧入点算出错位的窗口。
                "clip_in_sec": shot.clip_in_sec, "clip_dur_sec": shot.clip_dur_sec,
                # 2.3：把落库后的新版本号一并回给客户端，让它**不必**等一次
                # /detail 就能继续连着改（连续拖动是常态，中间少一个 GET
                # 也少一个"用旧 rev 撞上自己刚写的值"的假冲突窗口）。
                "transform_rev": transform_rev(shot.transform_meta)}


class ShotBreakdownIn(BaseModel):
    """镜头拆解结果的人工修正。各项都可单独下发（None = 不动该字段）。

    用途：AI 拆镜难免有偏差（把两个动作并成一镜、认错出场角色、场景名写岔）。
    此前只能重跑整集拆解，会把用户已经调好的其他镜头一起冲掉；现在可以单镜改。
    """
    #: 该镜对应的剧本片段（提示词的原始依据）
    script_ref: Optional[str] = None
    #: 出场角色名列表。注意：这里改的是**拆解真值**，与 ref_overrides 的
    #: 人工增删是两层——那层是"注入时加/减谁"，这层是"这镜里到底有谁"。
    characters: Optional[list[str]] = None
    location: Optional[str] = None
    #: continuous = 与上一镜连续；transition = 与上一镜之间有转场
    link_to_prev: Optional[str] = None


@router.patch("/shots/{shot_id}/breakdown")
def patch_shot_breakdown(shot_id: str, body: ShotBreakdownIn) -> dict:
    """修正单镜的拆解结果。

    **不自动重算提示词**：重算要调文本模型花钱，用户可能连着微调好几个字段，
    每次都触发就是反复烧钱。改完置 stale，由用户显式点「重新生成提示词」。
    """
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")

        changed: list[str] = []
        if body.script_ref is not None:
            new_ref = body.script_ref.strip()
            if not new_ref:
                raise HTTPException(status_code=400, detail="script_ref 不能为空")
            if new_ref != (shot.script_ref or ""):
                shot.script_ref = new_ref
                changed.append("script_ref")
        if body.characters is not None:
            # 去空白去重但保持顺序：顺序决定参考图注入的优先级（前面的先占位）
            seen: set[str] = set()
            names = []
            for c in body.characters:
                n = (c or "").strip()
                if n and n not in seen:
                    seen.add(n)
                    names.append(n)
            if json.dumps(names, ensure_ascii=False) != (shot.characters or "[]"):
                shot.characters = json.dumps(names, ensure_ascii=False)
                changed.append("characters")
        if body.location is not None:
            loc = body.location.strip() or None
            # N3：拆解偶尔把镜号前缀（如「5-1」）写进 location，导致同一个物理空间
            # 在 Asset 里分裂成多个不同名字的场景资产。在写库前清洗掉前缀。
            from .scene_desc import strip_shot_prefix
            if loc:
                loc = strip_shot_prefix(loc) or loc
            if loc != shot.location:
                shot.location = loc
                changed.append("location")
        if body.link_to_prev is not None:
            lp = body.link_to_prev.strip()
            if lp not in ("continuous", "transition"):
                raise HTTPException(status_code=400,
                                    detail="link_to_prev 只能是 continuous / transition")
            if lp != shot.link_to_prev:
                shot.link_to_prev = lp
                changed.append("link_to_prev")

        if changed:
            # 拆解变了 → 现有提示词与已出片都基于旧拆解，标过期提醒重生。
            # 不删 video_url：用户可能只是修个错别字，不该把片子弄没。
            # reprompt 而非 rebreak：切分没动，重出提示词 + 重出片即可，
            # 不必把整集拆解推倒（那会作废本集其它镜头已出的片）。
            stale_mod.mark_stale(shot, stale_mod.REPROMPT)
        session.commit()
        return {"ok": True, "shot_id": shot.id, "changed": changed,
                "stale": bool(shot.stale), "stale_reason": shot.stale_reason}


class ShotPromptIn(BaseModel):
    """直接改提示词（跳过 AI 重写）。"""
    gen_prompt: str


@router.patch("/shots/{shot_id}/prompt")
def patch_shot_prompt(shot_id: str, body: ShotPromptIn) -> dict:
    """保存用户手改的提示词，并保证它**真的会被下发**。

    ⚠️ 只写 gen_prompt 是不够的：run_shot_videos 里只有纯文生视频才直接用
    gen_prompt，一旦有参考图（全参考/首帧路线，也就是绝大多数情况）就会带
    ctx 重新优化一遍，用户改的词会被 AI 悄悄重写回去。
    真正的"不被覆盖"通道是 profile_override.prompt（jobs.py:983 第一优先级），
    所以两处都写：gen_prompt 供 UI 展示，override 供生成时实际取用。
    """
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")
        text = (body.gen_prompt or "").strip()
        if not text:
            raise HTTPException(status_code=400, detail="提示词不能为空")
        shot.gen_prompt = text
        shot.prompt_state = "manual"
        ov = json.loads(shot.profile_override) if shot.profile_override else {}
        ov["prompt"] = text
        shot.profile_override = json.dumps(ov, ensure_ascii=False)
        session.commit()
        return {"ok": True, "shot_id": shot.id, "prompt_state": "manual"}


@router.delete("/shots/{shot_id}/prompt")
def reset_shot_prompt(shot_id: str) -> dict:
    """撤销手改，把提示词交还给 AI（清 override，下次生成重新优化）。

    没有这个入口的话，用户改过一次就永久锁死了——「重新生成提示词」写的是
    gen_prompt，而生成时 override.prompt 优先级更高，会一直盖着旧的手改稿。
    """
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")
        ov = json.loads(shot.profile_override) if shot.profile_override else {}
        ov.pop("prompt", None)
        shot.profile_override = (json.dumps(ov, ensure_ascii=False) if ov else None)
        shot.prompt_state = "draft"
        session.commit()
        return {"ok": True, "shot_id": shot.id, "prompt_state": "draft"}


class ShotSplitIn(BaseModel):
    """TB-01 镜头分割：在镜内第 at_sec 秒把一个镜头切成前后两段。"""

    at_sec: float


@router.post("/shots/{shot_id}/split")
def split_shot(shot_id: str, body: ShotSplitIn) -> dict:
    """在镜内指定秒处把镜头拆成两段（时间轴 Ctrl+B）。

    语义（为什么这样切）：

    - **后半段是一个新镜头行**，紧跟在原镜之后，order 由 _renumber 收敛。
      不复用原行是因为版本历史（ShotVersion）挂在 shot_id 上，复用会让
      "后半段"莫名其妙继承前半段的全部生成版本。

    - **视频与首帧不做实际裁剪**：后半段沿用同一个 video_url。真正按秒裁剪
      要重新转码（几十秒到几分钟），放在这个同步接口里会把请求挂死。
      导出时 media.py 已支持 -ss/-t 裁剪，届时按 clip_in/clip_dur 消费即可。
      因此这里把切点记进新增的两个字段，导出与预览据此取片段。

    - **后半段是派生行，不是新的待生成镜头**：status 沿用原镜，避免它被
      "生成待出片镜头"当成缺片镜头又烧一次钱。

    - 参考注入（characters/location/ref_overrides）整份复制：切开的两段在
      剧情上仍是同一场戏，参考资产理应一致。
    """
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")

        dur = float(shot.duration_sec or 5.0)
        at = float(body.at_sec)
        # 两侧各留 0.5s，避免切出 0 长度的段（导出时 -t 0 会产出空文件）
        if at <= 0.5 or at >= dur - 0.5:
            raise HTTPException(
                status_code=422,
                detail=f"切点需在 0.5s 与 {dur - 0.5:.1f}s 之间（当前镜头时长 {dur:.1f}s）")

        base_in = float(getattr(shot, "clip_in_sec", None) or 0.0)

        # 后半段
        tail = Shot(
            id=uuid.uuid4().hex[:12], project_id=shot.project_id,
            order=shot.order + 1,
            script_ref=shot.script_ref,
            link_to_prev="continuous",
            characters=shot.characters,
            location=shot.location,
            video_url=shot.video_url,
            thumb_url=shot.thumb_url,
            first_frame_url=None,          # 后半段的首帧不是原首帧，留空更诚实
            episode=shot.episode,
            status=shot.status,
            profile_override=shot.profile_override,
            is_special=shot.is_special,
            adopted_version=shot.adopted_version,
            gen_prompt=shot.gen_prompt,
            prompt_state=shot.prompt_state,
            stale=shot.stale,
            stale_reason=shot.stale_reason,   # 分割出的后半段与原镜同因同命
            duration_sec=round(dur - at, 2),
            disabled=shot.disabled,
            special_name=shot.special_name,
            ref_overrides=shot.ref_overrides,
            refs_stale=shot.refs_stale,
            clip_in_sec=base_in + at,
            clip_dur_sec=round(dur - at, 2),
        )
        # 前半段：只改时长与裁剪窗口
        shot.duration_sec = round(at, 2)
        shot.clip_in_sec = base_in
        shot.clip_dur_sec = round(at, 2)

        # 给后面的镜头让位
        for s in (session.query(Shot)
                  .filter(Shot.project_id == shot.project_id,
                          Shot.order > shot.order).all()):
            s.order += 1
        session.add(tail)
        session.flush()
        _renumber(session, shot.project_id)
        session.commit()
        return {"ok": True, "head_shot_id": shot.id, "tail_shot_id": tail.id,
                "head_order": shot.order, "tail_order": tail.order,
                "head_duration": shot.duration_sec, "tail_duration": tail.duration_sec}


class ShotUnsplitIn(BaseModel):
    """撤销分割：把 tail_shot_id 那一段合回本镜（Ctrl+B 的逆操作）。"""

    tail_shot_id: str


@router.post("/shots/{shot_id}/unsplit")
def unsplit_shot(shot_id: str, body: ShotUnsplitIn) -> dict:
    """把 split_shot 切出来的后半段合回前半段——即 Ctrl+B 的撤销。

    没有这个端点的话 Ctrl+B 就是不可撤销的：后半段是一个 is_special=0 的
    AI 镜头行，而 `delete_shot` 明确拒绝删 AI 镜头，前端凑不出逆操作。

    校验从严，宁可 409 也不做"尽力而为的合并"——合错了会静默吞掉用户
    在后半段上做的工作（重新生成的版本、改过的提示词/时长）：

      · 必须同项目、tail 紧跟在 head 之后（order 相邻）
      · 必须同一条 video_url（后半段被单独重新生成过就不是原来那一刀了）
      · 裁剪窗口必须首尾相接（tail.clip_in == head.clip_in + head.clip_dur）
      · tail 不能有自己的版本历史（有就说明它被单独生成过）
    """
    with get_session() as session:
        head = session.get(Shot, shot_id)
        tail = session.get(Shot, body.tail_shot_id)
        if not head or not tail:
            raise HTTPException(status_code=404, detail="shot not found")
        if head.project_id != tail.project_id:
            raise HTTPException(status_code=422, detail="两个镜头不属于同一项目")
        if tail.order != head.order + 1:
            raise HTTPException(
                status_code=409,
                detail=f"两段已不相邻（#{head.order} / #{tail.order}），无法合并")
        if (head.video_url or "") != (tail.video_url or ""):
            raise HTTPException(
                status_code=409, detail="后半段已被重新生成，合并会丢失该结果")
        if session.query(ShotVersion).filter(ShotVersion.shot_id == tail.id).count():
            raise HTTPException(
                status_code=409, detail="后半段已有独立的生成版本，合并会丢失它们")

        h_in = float(getattr(head, "clip_in_sec", None) or 0.0)
        h_dur = float(getattr(head, "clip_dur_sec", None) or head.duration_sec or 0.0)
        t_in = float(getattr(tail, "clip_in_sec", None) or 0.0)
        t_dur = float(getattr(tail, "clip_dur_sec", None) or tail.duration_sec or 0.0)
        if abs((h_in + h_dur) - t_in) > 0.05:
            raise HTTPException(
                status_code=409,
                detail="两段的裁剪窗口已不连续（时长被单独改过），无法合并")

        merged = round(h_dur + t_dur, 2)
        head.duration_sec = merged
        head.clip_in_sec = h_in
        head.clip_dur_sec = merged
        pid = head.project_id
        session.delete(tail)
        session.flush()
        _renumber(session, pid)
        session.commit()
        return {"ok": True, "shot_id": head.id,
                "order": head.order, "duration": merged}


@router.delete("/shots/{shot_id}")
def delete_shot(shot_id: str) -> dict:
    """删除镜头（仅允许删外部素材镜头；AI 镜头请用停用，避免破坏拆解对应关系）。"""
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")
        if not shot.is_special:
            raise HTTPException(
                status_code=400,
                detail="AI 镜头不可删除，请改用停用（PATCH /shots/{id}/timeline disabled=true）")
        pid = shot.project_id
        session.delete(shot)
        session.flush()
        _renumber(session, pid)
        session.commit()
        return {"ok": True}


# ---------- 镜头版本历史（R2，契约 C10）----------
@router.get("/shots/{shot_id}/versions")
def shot_versions(shot_id: str) -> dict:
    """版本历史（精编器回退面板用）；回退=POST adopt 指旧 version_no。"""
    with get_session() as session:
        if not session.get(Shot, shot_id):
            raise HTTPException(status_code=404, detail="shot not found")
        rows = (session.query(ShotVersion)
                .filter(ShotVersion.shot_id == shot_id)
                .order_by(ShotVersion.version_no.desc()).all())
        return {"versions": [
            {"version_no": v.version_no, "video_url": v.video_url,
             "thumb_url": v.thumb_url,
             "model_id": v.model_id, "prompt": v.prompt,
             "meta": json.loads(v.meta) if v.meta else None,
             "created_at": v.created_at}
            for v in rows
        ]}


# ---------- 首帧图（i2va 流水线）：单独生成 / 重生 ----------
class FirstFrameIn(BaseModel):
    #: True = 同时重建该镜所属 (集,场景) 的场景锚定图。
    #: 场景基准不满意时用；会影响该场景后续所有镜头的首帧基调。
    regen_anchor: bool = False
    #: 覆盖图像模型（留空走项目预设）
    image_model: Optional[str] = None


@router.post("/shots/{shot_id}/first-frame")
async def regen_first_frame(shot_id: str, body: FirstFrameIn) -> dict:
    """为单个镜头生成/重生首帧图（不出视频）。

    首帧几毛、视频几块——先审首帧再出视频可省大量废片成本，
    也是排查"场景偏移"的唯一抓手：偏移在首帧就能看出来，不必等视频跑完。
    """
    from .jobs import (_auto_inject_refs, _ensure_scene_anchor, _gen_first_frame,
                       _FRAME_REF_LIMIT, _set_shot_first_frame)
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")
        proj = session.get(Project, shot.project_id)
        pid, ep, loc = shot.project_id, shot.episode, shot.location
        script_ref = shot.script_ref
        shot_gen_prompt = shot.gen_prompt
        aspect = (proj.base_aspect if proj else None) or "9:16"
        override = json.loads(shot.profile_override) if shot.profile_override else {}

    from .jobs import _resolve_project_gen_settings
    _, proj_image_model = _resolve_project_gen_settings(proj)
    image_model = body.image_model or override.get("image_model") or proj_image_model
    aspect = override.get("aspect_ratio") or aspect

    refs = override.get("ref_urls") or []
    labels: list[str] = []
    if not refs:
        refs, labels = _auto_inject_refs(shot_id, _FRAME_REF_LIMIT)

    if body.regen_anchor and loc:
        # 强制重建场景锚点（后续同场景镜头会复用这张新基准）
        await _ensure_scene_anchor(pid, ep, loc, refs, labels, aspect,
                                   image_model, force=True)

    # strict=True：把真实原因带给用户。内容审核拒绝与渠道故障的处置完全不同
    # （前者重试无效、要改提示词或换模型；后者稍后重试即可），不能都报"生成失败"。
    from .providers.image import ContentRejected
    try:
        url = await _gen_first_frame(pid, ep, loc, script_ref, refs, labels,
                                     aspect, image_model,
                                     gen_prompt=shot_gen_prompt, strict=True)
    except ContentRejected as e:
        cats = "、".join(e.categories) if e.categories else ""
        raise HTTPException(status_code=422, detail={
            "reason": "moderation",
            "categories": e.categories,
            "message": (f"提示词被内容审核判定违规{('（' + cats + '）') if cats else ''}。"
                        "重试无效——同一提示词判定一致。"
                        "建议改写该镜提示词（弱化敏感描写），或换用其他生图模型"
                        "（各厂商审核尺度不同）。"),
        }) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={
            "reason": "channel",
            "message": f"首帧生成失败：{str(e)[:300]}",
        }) from e
    if not url:
        raise HTTPException(status_code=502, detail={
            "reason": "other", "message": "图像模型未返回图片"})
    _set_shot_first_frame(shot_id, url)
    return {"ok": True, "first_frame_url": url}


# ---------- 镜头采用（T-R0-04，契约 C2）----------
class AdoptIn(BaseModel):
    version_no: int


@router.post("/shots/{shot_id}/adopt")
async def adopt_shot_version(shot_id: str, body: AdoptIn) -> dict:
    from .media import make_thumb
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        if not shot:
            raise HTTPException(status_code=404, detail="shot not found")
        ver = (session.query(ShotVersion)
               .filter(ShotVersion.shot_id == shot_id,
                       ShotVersion.version_no == body.version_no).first())
        if not ver:
            raise HTTPException(status_code=404, detail=f"版本 {body.version_no} 不存在")
        thumb = ver.thumb_url
        video_url = ver.video_url
    # P1-1：存量版本（缩略图上线前生成的）没有 thumb，切到它会让轨道变空白。
    # 这里按需补抽一次并回写版本记录，之后再切就直接命中。抽帧在 session 外做，不占连接。
    if not thumb and video_url:
        thumb = await make_thumb(video_url)
    with get_session() as session:
        shot = session.get(Shot, shot_id)
        ver = (session.query(ShotVersion)
               .filter(ShotVersion.shot_id == shot_id,
                       ShotVersion.version_no == body.version_no).first())
        if not shot or not ver:
            raise HTTPException(status_code=404, detail="shot not found")
        if thumb and not ver.thumb_url:
            ver.thumb_url = thumb
        shot.video_url = ver.video_url
        # 3.1：切版本 = 换素材，取片窗口失效（旧窗口是相对**上一个** video_url
        # 的坐标）。这里会丢掉用户在上一版素材上修剪的入点/出点——但相比
        # 「时间轴显示 3s、成片里是黑帧」这种静默损坏，看得见的丢失是可接受的，
        # 且用户重新拖一次即可。回报 clip_window_cleared 让前端提示这件事。
        window_cleared = reset_clip_window(shot)
        # 只在真拿到缩略图时才覆盖。
        # 原来是无条件赋值：make_thumb 失败（ffmpeg 抽帧超时、源文件损坏、
        # 磁盘满）时 thumb 为 None，于是把镜头**原有的好缩略图擦成空白**——
        # 用户切一次版本，轨道上那一格就白了，而且切回去也不会自动恢复。
        # 宁可留旧图（内容可能对不上新版本，但比整格空白可用）。
        if thumb:
            shot.thumb_url = thumb
        shot.adopted_version = ver.version_no
        shot.status = "adopted"
        session.commit()
        # 回报**实际生效**的缩略图，而不是可能为 None 的本次抽帧结果 ——
        # 前端拿它直接更新卡片，报 None 会让已有的图在界面上消失
        return {"ok": True, "shot_id": shot_id,
                "adopted_version": ver.version_no, "video_url": ver.video_url,
                "thumb_url": shot.thumb_url,
                "clip_window_cleared": window_cleared}


# ---------- P2-4 音频轨（TTS 旁白 / 配乐，修 D5）----------
class AudioClipIn(BaseModel):
    project_id: str
    kind: str = "tts"                     # tts | music
    text: Optional[str] = None            # tts 必填
    url: Optional[str] = None             # music 必填（素材池音频 URL）
    duration: Optional[float] = None      # music 可传（素材池已探测）
    start_shot_order: int = 1
    start_offset_sec: float = 0.0
    voice_ref_url: Optional[str] = None   # tts 参考音色（素材池音频/视频 URL）


class AudioClipPatch(BaseModel):
    start_shot_order: Optional[int] = None
    start_offset_sec: Optional[float] = None
    text: Optional[str] = None            # 改文本后 status 回 pending（需重新合成）
    #: 6.9 修剪窗口（秒）。夹持在 [0, duration] 内，见 patch_audio_clip。
    clip_in_sec: Optional[float] = None
    clip_dur_sec: Optional[float] = None
    #: 取消修剪：把上面两列一起清空（回到"整段播放"）。
    #: 必须单独一个字段 —— `clip_dur_sec: None` 在 PATCH 语义里是"不改这一列"，
    #: 表达不了"改成 NULL"。Shot 那边同样的需求同样单开了 clear_clip（1921 行），
    #: 这里照抄它，免得两个实体对同一件事有两种写法。
    clear_clip: Optional[bool] = None


class NarrationVoiceIn(BaseModel):
    #: 参考音频 URL（/fw/media/...）；传 null 表示清除
    voice_url: str | None = None


@router.put("/projects/{project_id}/narration-voice")
def set_narration_voice(project_id: str, body: NarrationVoiceIn) -> dict:
    """设置解说音色。整片共用一个解说声，所以挂项目而非角色。

    只存 URL，不做转码——TTS provider 上传参考音时会自己处理
    （视频素材抽音轨、只取前 15s）。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        proj.narration_voice_url = (body.voice_url or "").strip() or None
        session.commit()
        return {"ok": True, "voice_url": proj.narration_voice_url}


class GenNarrationIn(BaseModel):
    project_id: str
    #: 只处理这些集；空/缺省 = 全部集
    episodes: list[int] | None = None
    #: 已存在旁白时是否覆盖重建（默认否，避免误删已合成的音频）
    replace: bool = False
    #: 参考音色（整片统一一个解说声）
    voice_ref_url: str | None = None


@router.post("/projects/{project_id}/narration/generate")
def generate_narration(project_id: str, body: GenNarrationIn) -> dict:
    """解说剧：给每个镜头建它自己那段旁白。

    只建段、不合成——合成仍走既有的 tts_batch job（用户在音频面板点合成）。
    这样切分结果可以先在音频面板里逐条读一遍、改一改，再花钱去合成。

    旁白内容是**剧本原文照读**，不经 AI 改写：解说剧的定位就是
    "剧本即解说词"，任何改写都会让用户失去对文案的控制。

    ## 不变式：第 N 镜的旁白 == 第 N 镜画面所依据的那段原文

    此前的做法是把**整集正文**丢给 `split_narration` 按"剩余字数/剩余段数"
    重新切一遍，于是同一份文本存在两套互不相干的边界：画面按 AI 拆解的叙事
    节拍切，旁白按贪心装箱切。对不齐是**必然**的，不是偶发 bug——实测项目 930
    的镜 3 画面演的是原文第 380-582 字，配的旁白却是第 250-319 字。

    `script_ref` 按定义就是"这个镜头在演哪段原文"，所以直接拿它当旁白，1:1 绑定。

    读不完的镜头（拆镜提示词按"7-15 秒视频"设计，一镜可能 116 字要读 26 秒，
    而 720p 海螺 H3 一镜只够 19.1s ≈ 85 字）**拆成更多镜头**：按句界切开，
    紧随其后插入克隆镜，画面全程有运动。镜头数会增加，这是"严格一一对应"的
    直接代价（用户已明确选择此方案）。

    `script_ref` 缺失/覆盖率过低的老项目退回原来的按集切分路径，返回体里
    如实标 `mode`——不再静默走一条对齐质量完全不同的路。

    幂等：默认跳过已有旁白的镜头；replace=true 时先删掉旧的 narration 段
    （只删本函数建的 kind="narration"，不碰用户自己加的 tts/music）。
    """
    from datetime import datetime, timezone
    from .db import AudioClip
    from .script_import import (split_narration, strip_script_markup,
                                plan_narration_by_shot, spoken_chars)

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        raw = proj.raw_script or ""
        if not raw.strip():
            raise HTTPException(status_code=400, detail="项目还没有剧本内容")
        # 音色优先用本次传入的，其次用项目上设定的解说音色。
        # 没有音色也照样建段——文案可以先校对，合成时才需要音色。
        voice = body.voice_ref_url or proj.narration_voice_url

        # 按**项目选定的分辨率 + 视频模型**决定单镜最长时长：解说剧应当在用户
        # 选的画质下尽可能出长镜，而不是拿固定秒数一刀切。0.5MP 能一镜 38s，
        # 2.0MP 只有 7.5s——用后者的标准去切前者，会白白多切数倍镜头。
        # 同时不能超过模型自身上限（seedance 15s / veo 8s），见 shot_seconds_cap。
        max_sec, mp = shot_seconds_cap(profile_of(proj))

        chapters = {c["order"]: c["content"] for c in smart_split_chapters(raw)}
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id)
                 .order_by(Shot.episode, Shot.order).all())
        if not shots:
            raise HTTPException(status_code=400, detail="还没有拆出镜头，先做剧本拆解")

        # 按集分组镜头（停用镜头不参与：它不出现在成片里，给它配旁白等于浪费）
        by_ep: dict[int, list] = {}
        for s in shots:
            if s.disabled:
                continue
            by_ep.setdefault(s.episode, []).append(s)

        want_eps = set(body.episodes) if body.episodes else set(by_ep.keys())

        if body.replace:
            (session.query(AudioClip)
             .filter(AudioClip.project_id == project_id,
                     AudioClip.kind == "narration")
             .delete(synchronize_session=False))
            session.commit()

        existing = {
            r[0] for r in session.query(AudioClip.source_shot_id)
            .filter(AudioClip.project_id == project_id,
                    AudioClip.kind == "narration",
                    AudioClip.source_shot_id.isnot(None)).all()
        }

        # ---- 走哪条路：script_ref 到底覆盖了多少剧本 ----
        #
        # 分母刻意用**整本剧本**而不是"本次要生成的那几集"：集号本身就可能是错的
        # （Bug A 会把所有镜头打成 episode=1），拿错的集号去算覆盖率只会得出错的
        # 判断。而 by_shot 路径根本不依赖集号——它只看每个镜头自己的 script_ref，
        # 所以即使集号是坏的，走它也仍然对得齐。
        script_all = len(spoken_chars(raw))
        live_all = [s for ss in by_ep.values() for s in ss]
        ref_all = sum(len(spoken_chars(s.script_ref or "")) for s in live_all)
        # 0.5 是"script_ref 有没有当真填过"的判据，不是质量线：AI 拆解正常时
        # 这个比值在 0.95~1.05，未回填 script_ref 的老项目则接近 0。
        by_shot = script_all > 0 and ref_all >= script_all * 0.5

        created, skipped, no_text, added_shots = 0, 0, 0, 0
        split_shots = 0
        now = datetime.now(timezone.utc).isoformat(timespec="seconds")
        #: [(镜头, 该镜旁白文本)]，两条路径都归到这个形状，落库代码只有一份
        pairs: list[tuple[Shot, str]] = []

        if by_shot:
            # ---- 阶段一：改镜头结构（读不完的镜头按句界拆成多镜）----
            live = [s for ep in sorted(by_ep) if ep in want_eps for s in by_ep[ep]]
            plans = plan_narration_by_shot([s.script_ref or "" for s in live],
                                           max_sec)
            plan_by_id = {s.id: segs for s, segs in zip(live, plans)}
            old_ids = {s.id for s in shots}
            # 克隆镜先占一个不与现有 order 冲突的临时号，下面统一重排。
            # Shot.order 非空，不能等重排时再填。
            next_order = max(s.order for s in shots) + 1

            new_seq: list[Shot] = []
            for s in shots:
                new_seq.append(s)
                segs = plan_by_id.get(s.id)
                if segs is None:      # 停用镜 / 本次不生成的集：原样留在序列里
                    continue
                if not segs:          # script_ref 为空：没有旁白可建，如实计数
                    pairs.append((s, ""))
                    continue
                if len(segs) > 1:
                    split_shots += 1
                    if (s.script_ref or "").strip() != segs[0]:
                        s.script_ref = segs[0]
                        s.duration_sec = _narration_duration(segs[0], max_sec)
                        # 画面所依据的文字变了，已出的片就不再对应它了。
                        # 不自动重生成（烧钱），只置 stale 让用户看得见。
                        # reprompt：script_ref 被改写，旧 gen_prompt 已失效，
                        # 重出片时必须从新 script_ref 重新优化（见 app/stale.py）。
                        if s.video_url:
                            stale_mod.mark_stale(s, stale_mod.REPROMPT)
                pairs.append((s, segs[0]))
                for seg in segs[1:]:
                    clone = Shot(
                        id=uuid.uuid4().hex[:12], project_id=project_id,
                        order=next_order, episode=s.episode,
                        script_ref=seg,
                        link_to_prev="continuous",
                        characters=s.characters,
                        location=s.location,
                        gen_prompt=s.gen_prompt,
                        prompt_state=s.prompt_state,
                        duration_sec=_narration_duration(seg, max_sec),
                        status="pending",
                    )
                    next_order += 1
                    session.add(clone)
                    new_seq.append(clone)
                    pairs.append((clone, seg))
                    added_shots += 1
            session.flush()   # 让克隆镜落到会话里，下面重排能拿到它们

            # 全局重排 1..N。音频/字幕锚点是普通整数 order、不是外键，
            # 不搬的话插了克隆镜之后所有旧旁白整体错位到别的镜头上。
            # mapping 只收**原有**镜头（克隆镜的临时号没有任何锚点指向它）。
            mapping: dict[int, int] = {}
            for i, s in enumerate(new_seq, start=1):
                if s.id in old_ids and s.order != i:
                    mapping[s.order] = i
                s.order = i
            _remap_anchors(session, project_id, mapping)
            session.commit()
        else:
            # ---- 兜底：老项目没有 script_ref，只能按集正文重切 ----
            # 这条路的对齐质量与 by_shot **不同**（两套边界，见函数文档），
            # 但总比没有旁白强。返回体里标了 mode，前端据此提示用户重拆一次。
            for ep, ep_shots in sorted(by_ep.items()):
                if ep not in want_eps:
                    continue
                segments = split_narration(chapters.get(ep, ""), len(ep_shots),
                                           max_sec=max_sec)
                # 段数多于镜头时**补镜头**，而不是丢文字：解说剧里旁白是硬约束
                # （读不完就是读不完），镜头数应当跟着切分走。原来用 zip() 截断，
                # 等于把读不完的剧本内容静默丢掉。
                if len(segments) > len(ep_shots):
                    tail = ep_shots[-1]
                    base_order = max(s.order for s in shots)
                    for _ in range(len(segments) - len(ep_shots)):
                        base_order += 1
                        clone = Shot(
                            id=uuid.uuid4().hex[:12], project_id=project_id,
                            order=base_order, episode=ep,
                            script_ref=tail.script_ref,
                            link_to_prev="continuous",
                            characters=tail.characters,
                            location=tail.location,
                            gen_prompt=tail.gen_prompt,
                            prompt_state=tail.prompt_state,
                            duration_sec=None,     # 由旁白时长回写
                            status="pending",
                        )
                        session.add(clone)
                        ep_shots.append(clone)
                        added_shots += 1
                    session.flush()   # 拿到 id 供下面绑定 source_shot_id
                pairs.extend(zip(ep_shots, segments))
            session.commit()

        # ---- 阶段二：旁白落库，与镜头 1:1 ----
        for shot, text in pairs:
            if shot.id in existing:
                skipped += 1
                continue
            if not (text or "").strip():
                no_text += 1
                continue
            session.add(AudioClip(
                id=uuid.uuid4().hex[:12], project_id=project_id,
                # 剥离 △/【】/(OS) 等标记符号：TTS 会**照着念**（实测 21 条
                # 旁白"原文字数/时长"标准差仅 0.303，剔标记后飙到 1.623），
                # 而字幕文本必须等于被念出来的文本才对得齐。只删符号不删字。
                kind="narration", text=strip_script_markup(text),
                url=None, duration=0.0,
                start_shot_order=shot.order, start_offset_sec=0.0,
                source_shot_id=shot.id,
                voice_ref_url=voice,
                status="pending", created_at=now,
            ))
            created += 1
        session.commit()

        # 覆盖率：本次要生成的这几集，剧本有多少字最终进了旁白。
        # 掉到 1.0 以下就意味着有文字没人念——930 那次是 0.48（整整一集消失）。
        want_chars = sum(len(spoken_chars(chapters.get(ep, "")))
                         for ep in want_eps)
        got_chars = sum(len(spoken_chars(t)) for _s, t in pairs)

    return {"created": created, "skipped_existing": skipped,
            "shots_without_text": no_text,
            # 为装下全部旁白而补建的镜头数（解说剧里旁白驱动镜头，不是反过来）
            "added_shots": added_shots,
            # 因"一镜读不完"而被拆开的原镜头数（Part C 生效后应接近 0）
            "split_shots": split_shots,
            #: by_shot = 旁白与镜头 1:1（正确路径）；
            #: by_chapter_fallback = 老项目没有 script_ref，按集正文重切
            "mode": "by_shot" if by_shot else "by_chapter_fallback",
            "coverage": round(got_chars / want_chars, 4) if want_chars else None,
            # 按项目分辨率算出的单镜上限（前端据此解释"为什么切了这么多镜"）
            "max_sec_per_clip": round(max_sec, 1),
            "megapixels": mp,
            # 旧旁白是在"符号剥离"上线**之前**建的，文本里仍含 △/【】/(OS)，
            # 音频也已经把它们念出来了。重合成要花 TTS 的钱，所以不自动重跑，
            # 只如实告知——不提示的话用户永远不会知道为什么有些旁白怪怪的。
            "legacy_markup_hint": (
                f"有 {skipped} 段旁白是此前生成的，文本里可能仍含 △/【】/(OS) 等标记"
                "并已被念进音频。如需修正请用「重新生成（覆盖）」重合成。"
                if skipped else None),
            "episodes": sorted(want_eps)}


def _clamp_anchor(session, project_id: str, order) -> int:
    """把锚点镜号钳进项目**实际存在**的镜号区间（音频段/字幕段共用）。

    原来四处都只写 `max(1, order)` —— 只钳下界，没有上界。于是把字幕/音频锚到
    一个不存在的镜号（前端算错、拆解后镜头变少、或直接调 API 传了 99）时，
    值会被静默存下来，而导出走的是"按镜头顺序累加时长"得到的 offsets 表：
        base = offsets.get(c.start_shot_order)   # → None
        if base is None: continue                # → 整段被跳过
    结果这段音频/字幕**永远不会出现在成片里**，前端时间轴上也没有它的落点，
    用户只看到"字幕丢了"，没有任何报错可循（B18）。

    钳到最后一镜比静默丢弃诚实：用户至少能在时间轴上看见它、再拖到想要的位置。
    注意 bounds 不过滤 disabled —— 锚在停用镜头上是可恢复的（重新启用就回来），
    不该借这次钳位把它挪走。
    """
    o = max(1, int(order or 1))
    lo, hi = (session.query(func.min(Shot.order), func.max(Shot.order))
              .filter(Shot.project_id == project_id).one())
    if lo is None:        # 项目还没拆镜，无从判断上界；留原值，拆完由重编号修正
        return o
    return min(max(o, int(lo)), int(hi))


def _audio_out(a) -> dict:
    return {"id": a.id, "kind": a.kind, "text": a.text, "url": a.url,
            "duration": a.duration, "start_shot_order": a.start_shot_order,
            "start_offset_sec": a.start_offset_sec,
            "voice_ref_url": a.voice_ref_url,
            "source_shot_id": getattr(a, "source_shot_id", None),
            # 6.9 修剪窗口。NULL 原样送出，**不要**在这里折成 0 / duration ——
            # 前端要靠 clip_dur_sec 是不是 null 来判断"这条被剪过没有"
            # （决定是否显示还原按钮）。在序列化时补默认值，那个信息就没了。
            "clip_in_sec": getattr(a, "clip_in_sec", None),
            "clip_dur_sec": getattr(a, "clip_dur_sec", None),
            "status": a.status, "error": a.error}


@router.get("/projects/{project_id}/audio-clips")
def list_audio_clips(project_id: str) -> dict:
    from .db import AudioClip
    with get_session() as session:
        rows = (session.query(AudioClip)
                .filter(AudioClip.project_id == project_id)
                .order_by(AudioClip.start_shot_order, AudioClip.start_offset_sec).all())
        from .providers.tts import TTSProvider
        return {"clips": [_audio_out(a) for a in rows],
                "tts_available": TTSProvider().available}


@router.post("/audio-clips")
def create_audio_clip(body: AudioClipIn) -> dict:
    """新建音频段。tts：status=pending 等 job 合成；music：直接 done（素材已有）。"""
    from datetime import datetime, timezone
    from .db import AudioClip
    from .script_import import strip_script_markup
    if body.kind not in ("tts", "music"):
        raise HTTPException(status_code=400, detail="kind 只能是 tts/music")
    if body.kind == "tts" and not (body.text or "").strip():
        raise HTTPException(status_code=422, detail="tts 需要 text")
    if body.kind == "music" and not (body.url or "").strip():
        raise HTTPException(status_code=422, detail="music 需要 url")
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        a = AudioClip(
            id=uuid.uuid4().hex[:12], project_id=body.project_id, kind=body.kind,
            text=strip_script_markup(body.text or "") or None, url=body.url,
            duration=max(0.0, body.duration or 0.0),
            start_shot_order=_clamp_anchor(session, body.project_id,
                                           body.start_shot_order),
            start_offset_sec=max(0.0, body.start_offset_sec),
            voice_ref_url=body.voice_ref_url,
            status="done" if body.kind == "music" else "pending",
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )
        session.add(a)
        session.commit()
        return _audio_out(a)


@router.patch("/audio-clips/{clip_id}")
def patch_audio_clip(clip_id: str, body: AudioClipPatch) -> dict:
    from .db import AudioClip
    with get_session() as session:
        a = session.get(AudioClip, clip_id)
        if not a:
            raise HTTPException(status_code=404, detail="audio clip not found")
        if body.start_shot_order is not None:
            a.start_shot_order = _clamp_anchor(session, a.project_id,
                                               body.start_shot_order)
        if body.start_offset_sec is not None:
            a.start_offset_sec = max(0.0, body.start_offset_sec)
        # 6.9 修剪。顺序是承重的：先 clear、再 in、最后 dur ——
        # dur 的上界取决于 in（剪掉的头越长，剩下能播的就越短），
        # 反过来先算 dur 就会拿旧的 in 去夹持，一次同时改两头的修剪会被夹错。
        if body.clear_clip:
            a.clip_in_sec = None
            a.clip_dur_sec = None
        # 音源总长。0 表示"还没探测出来"（素材池音频、或仍在合成中），
        # 这时**不夹上界** —— 夹了就会把任何修剪都压成 0.1 秒。
        src = float(a.duration or 0.0)
        if body.clip_in_sec is not None:
            v = max(0.0, round(float(body.clip_in_sec), 2))
            a.clip_in_sec = min(v, src) if src > 0 else v
        if body.clip_dur_sec is not None:
            a.clip_dur_sec = max(0.1, round(float(body.clip_dur_sec), 2))
        # 末尾统一夹一次 `dur ≤ 总长 - 入点`，**不能**只在收到 clip_dur_sec 时夹。
        # 只推入点的那种改法（拖左边缘）本身不带 dur，可库里那个 dur 是按旧入点
        # 算的，右移入点之后它就超出音源尾巴了 —— 导出 `-ss 12 -t 10` 打在一个
        # 12 秒的文件上，取到的是空。这一步是"这条记录自身自洽"的最后一道，
        # 与"这次请求带了什么"无关，所以放在两个分支之外。
        if src > 0 and a.clip_dur_sec is not None:
            room = max(0.1, src - float(a.clip_in_sec or 0.0))
            a.clip_dur_sec = round(min(float(a.clip_dur_sec), room), 2)
        if body.text is not None and a.kind == "tts":
            new_text = body.text.strip()
            if new_text and new_text != a.text:
                a.text = new_text
                a.status = "pending"  # 文本变了需重新合成（旧音频保留到重合成覆盖）
        session.commit()
        return _audio_out(a)


@router.delete("/audio-clips/{clip_id}")
def delete_audio_clip(clip_id: str) -> dict:
    from .db import AudioClip
    with get_session() as session:
        a = session.get(AudioClip, clip_id)
        if not a:
            raise HTTPException(status_code=404, detail="audio clip not found")
        session.delete(a)
        session.commit()
    return {"ok": True}


class DetachAudioIn(BaseModel):
    project_id: str
    #: 只处理这些镜头；空/缺省 = 整个项目里所有还没剥过的、且有音轨的镜头
    shot_ids: list[str] | None = None


@router.post("/shots/detach-audio")
async def detach_shot_audio(body: DetachAudioIn) -> dict:
    """把镜头视频里的音轨剥成独立音频段，落在音频轨上可单独编辑。

    幂等：已经剥过的镜头（存在 source_shot_id 指向它的音频段）直接跳过，
    不会重复生成——否则同一镜头点两次就会有两条音频段，导出时叠加成双声。

    剥离后该镜头的**原音轨会在导出时自动静音**（依据就是这条音频段的存在，
    见 db.py AudioClip.source_shot_id），所以声音不会响两遍。
    删掉音频段则静音自动解除。
    """
    from datetime import datetime, timezone
    from .db import AudioClip, Shot
    from .media import extract_audio

    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        q = session.query(Shot).filter(Shot.project_id == body.project_id)
        if body.shot_ids:
            q = q.filter(Shot.id.in_(body.shot_ids))
        shots = q.order_by(Shot.order).all()
        # 已剥过的镜头集合，用于幂等跳过
        done_ids = {
            r[0] for r in session.query(AudioClip.source_shot_id)
            .filter(AudioClip.project_id == body.project_id,
                    AudioClip.source_shot_id.isnot(None)).all()
        }
        todo = [(s.id, s.order, s.video_url, s.clip_in_sec, s.clip_dur_sec)
                for s in shots
                if s.video_url and s.id not in done_ids and not s.disabled]

    created, skipped, no_audio = [], len(shots) - len(todo), 0
    for shot_id, order, video_url, cin, cdur in todo:
        got = await extract_audio(video_url, in_sec=cin, dur_sec=cdur)
        if got is None:          # 该镜头本来就没有音轨
            no_audio += 1
            continue
        url, dur = got
        with get_session() as session:
            a = AudioClip(
                id=uuid.uuid4().hex[:12], project_id=body.project_id,
                kind="shot", text=None, url=url, duration=dur,
                # 锚在自己这一镜的镜头首，偏移 0 —— 与视频天然对齐
                start_shot_order=order, start_offset_sec=0.0,
                source_shot_id=shot_id, status="done",
                created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            )
            session.add(a)
            session.commit()
            created.append(_audio_out(a))

    return {"created": created, "created_count": len(created),
            "skipped_existing": skipped, "no_audio": no_audio}


# ---------- TB-02 字幕轨（文本 / 剧情字幕 / 标题）----------
class SubtitleClipIn(BaseModel):
    project_id: str
    text: str
    kind: str = "subtitle"                # normal | subtitle | title
    start_shot_order: int = 1
    start_offset_sec: float = 0.0
    duration: float = 3.0
    style: Optional[dict] = None


class SubtitleClipPatch(BaseModel):
    text: Optional[str] = None
    kind: Optional[str] = None
    start_shot_order: Optional[int] = None
    start_offset_sec: Optional[float] = None
    duration: Optional[float] = None
    style: Optional[dict] = None


_SUB_KINDS = ("normal", "subtitle", "title")


def _sub_out(s) -> dict:
    return {"id": s.id, "text": s.text, "kind": s.kind,
            "start_shot_order": s.start_shot_order,
            "start_offset_sec": s.start_offset_sec,
            "duration": s.duration,
            "style": json.loads(s.style) if s.style else None,
            "created_at": s.created_at}


@router.get("/projects/{project_id}/subtitle-clips")
def list_subtitle_clips(project_id: str) -> dict:
    from .db import SubtitleClip
    with get_session() as session:
        rows = (session.query(SubtitleClip)
                .filter(SubtitleClip.project_id == project_id)
                .order_by(SubtitleClip.start_shot_order,
                          SubtitleClip.start_offset_sec).all())
        return {"clips": [_sub_out(s) for s in rows]}


@router.get("/projects/{project_id}/spoken-lines")
def list_spoken_lines(project_id: str) -> dict:
    """每个镜头**会被念出来**的台词原文，供客户端做本地强制对齐字幕。

    为什么这条要走后端而不在前端自己解析剧本：判定"哪一行是台词"的权威实现
    是 `drama_timing.split_units`（`角色os【情绪】：台词` 那套格式），
    拆镜算时长用的就是它。前端再写一份 TS 版必然与它漂移，而字幕文本一旦
    和"当初让视频模型念的文本"不一致，对齐就没有意义了 —— 单一真源必须留在后端。

    这条**不产生任何费用、不调模型**：纯文本变换。真正的重活（silencedetect
    停顿探测）在用户本机的 ffmpeg sidecar 上跑（见 `probeSilence.ts`）。

    只回 `lines`/`text`，不回时长与 URL：那些前端已经从 project detail 拿到了，
    再发一份就会出现两处不一致的可能。按 order 关联。
    """
    from .drama_timing import spoken_lines
    with get_session() as session:
        rows = (session.query(Shot)
                .filter(Shot.project_id == project_id)
                .order_by(Shot.order).all())
        out = []
        for sh in rows:
            lines = spoken_lines(sh.script_ref or "")
            if not lines:
                continue
            out.append({
                "shot_id": sh.id,
                "order": sh.order,
                "episode": sh.episode,
                "lines": lines,
                # 拼接用换行：下游 `splitIntoCues` 会把空白折叠掉，但换行能保证
                # 两句台词之间一定断开 —— 直接相接会把「…谁碰掉的！我根本没碰过」
                # 粘成一条，而它们是两个人说的。
                "text": "\n".join(lines),
            })
        return {"shots": out}


@router.post("/subtitle-clips")
def create_subtitle_clip(body: SubtitleClipIn) -> dict:
    from datetime import datetime, timezone
    from .db import SubtitleClip
    if not (body.text or "").strip():
        raise HTTPException(status_code=422, detail="text required")
    if body.kind not in _SUB_KINDS:
        raise HTTPException(status_code=400, detail=f"kind 只能是 {'/'.join(_SUB_KINDS)}")
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        s = SubtitleClip(
            id=uuid.uuid4().hex[:12], project_id=body.project_id,
            text=body.text.strip(), kind=body.kind,
            start_shot_order=_clamp_anchor(session, body.project_id,
                                          body.start_shot_order),
            start_offset_sec=max(0.0, body.start_offset_sec),
            duration=max(0.1, body.duration),
            style=json.dumps(body.style, ensure_ascii=False) if body.style else None,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )
        session.add(s)
        session.commit()
        return {"ok": True, **_sub_out(s)}


class SubtitleBulkIn(BaseModel):
    project_id: str
    clips: list[SubtitleClipIn]
    #: 先删掉该 kind 的旧字幕再写入（重新对齐时用）。None = 只追加。
    #: 语义与 run_auto_subtitles 的 replace 一致：只清自动生成的那一类，
    #: 用户手工加的 normal/title 不动。
    replace_kind: Optional[str] = None


@router.post("/subtitle-clips/bulk")
def bulk_create_subtitle_clips(body: SubtitleBulkIn) -> dict:
    """批量写入字幕段（本地对齐产物的落库入口）。

    为什么必须有批量口：一段 205 字的旁白按 15 字拆条就是 ~14 条 cue，
    一个 21 段旁白的项目就是 300 条。逐条 POST 等于 300 次往返 + 300 次
    commit，用户点一下要等半分钟，中途任何一次失败还会留下半套字幕。
    """
    from datetime import datetime, timezone
    from .db import SubtitleClip
    if body.replace_kind is not None and body.replace_kind not in _SUB_KINDS:
        raise HTTPException(status_code=400,
                            detail=f"replace_kind 只能是 {'/'.join(_SUB_KINDS)}")
    bad = [c.kind for c in body.clips if c.kind not in _SUB_KINDS]
    if bad:
        raise HTTPException(status_code=400,
                            detail=f"kind 只能是 {'/'.join(_SUB_KINDS)}，收到 {bad[0]}")

    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        deleted = 0
        if body.replace_kind:
            deleted = (session.query(SubtitleClip)
                       .filter(SubtitleClip.project_id == body.project_id,
                               SubtitleClip.kind == body.replace_kind)
                       .delete(synchronize_session=False))
        made = 0
        for c in body.clips:
            if not (c.text or "").strip():
                continue            # 空文本跳过而不是报错：整批不该被一条空段废掉
            session.add(SubtitleClip(
                id=uuid.uuid4().hex[:12], project_id=body.project_id,
                text=c.text.strip(), kind=c.kind,
                start_shot_order=_clamp_anchor(session, body.project_id,
                                               c.start_shot_order),
                start_offset_sec=max(0.0, c.start_offset_sec),
                duration=max(0.1, c.duration),
                style=json.dumps(c.style, ensure_ascii=False) if c.style else None,
                created_at=now,
            ))
            made += 1
        session.commit()
    return {"ok": True, "created": made, "deleted": deleted,
            "skipped_empty": len(body.clips) - made}


@router.patch("/subtitle-clips/{clip_id}")
def patch_subtitle_clip(clip_id: str, body: SubtitleClipPatch) -> dict:
    from .db import SubtitleClip
    with get_session() as session:
        s = session.get(SubtitleClip, clip_id)
        if not s:
            raise HTTPException(status_code=404, detail="subtitle clip not found")
        if body.text is not None:
            if not body.text.strip():
                raise HTTPException(status_code=422, detail="text 不能为空")
            s.text = body.text.strip()
        if body.kind is not None:
            if body.kind not in _SUB_KINDS:
                raise HTTPException(status_code=400, detail=f"kind 只能是 {'/'.join(_SUB_KINDS)}")
            s.kind = body.kind
        if body.start_shot_order is not None:
            s.start_shot_order = _clamp_anchor(session, s.project_id,
                                               body.start_shot_order)
        if body.start_offset_sec is not None:
            s.start_offset_sec = max(0.0, body.start_offset_sec)
        if body.duration is not None:
            s.duration = max(0.1, body.duration)
        if body.style is not None:
            s.style = json.dumps(body.style, ensure_ascii=False)
        session.commit()
        return {"ok": True, **_sub_out(s)}


@router.delete("/subtitle-clips/{clip_id}")
def delete_subtitle_clip(clip_id: str) -> dict:
    from .db import SubtitleClip
    with get_session() as session:
        s = session.get(SubtitleClip, clip_id)
        if not s:
            raise HTTPException(status_code=404, detail="subtitle clip not found")
        session.delete(s)
        session.commit()
    return {"ok": True}


class SubtitleStyleIn(BaseModel):
    #: 整套样式（字号/颜色/描边/底框/位置/字体/边距）。传 null 或 {} 表示清除。
    style: Optional[dict] = None


@router.get("/projects/{project_id}/subtitle-style")
def get_project_subtitle_style(project_id: str) -> dict:
    """项目级默认字幕样式。

    为什么需要项目级而不只是逐条样式：烧录是把**一个** SRT 用**一套**
    force_style 烧进画面，ffmpeg 的 subtitles 滤镜没有"逐条不同样式"这回事
    （那要生成 ASS 并逐条写 Style，属另一档工程）。所以导出时必须有一个
    确定的"这个项目的字幕长什么样"，而不是随便取某一条的 style 去代表全体。

    逐条 style 仍然保留，它决定的是**编辑器里的预览**与将来 ASS 导出。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        st = profile_of(proj).get("subtitle_style")
        return {"style": st if isinstance(st, dict) else None}


@router.put("/projects/{project_id}/subtitle-style")
def set_project_subtitle_style(project_id: str, body: SubtitleStyleIn) -> dict:
    """写项目级默认字幕样式。

    存进 default_profile 这个既有 JSON 列，**不加新列、不用 migration**。
    只改 subtitle_style 这一个键，其余键（video_model / resolution 等）
    原样读回再写出——直接覆盖整个 profile 会把生成参数抹掉。

    ⚠️ default_profile 在 db.py 里声明成 String(64)，而这里写进去的 JSON
    远超 64 字符。SQLite 不校验 VARCHAR 长度所以没事（既有的 custom_settings
    也早就这么存了），但若将来换成 Postgres/MySQL，这一列必须先改成 Text，
    否则会直接报错或被截断成坏 JSON。
    """
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        prof = profile_of(proj)
        if body.style:
            prof["subtitle_style"] = body.style
        else:
            prof.pop("subtitle_style", None)
        proj.default_profile = json.dumps(prof, ensure_ascii=False) if prof else None
        session.commit()
        return {"ok": True, "style": prof.get("subtitle_style")}


def effective_shot_sec(sh) -> float:
    """镜头在成片里**实际占用**的秒数 —— 与导出口径必须一致。

    三个因素，缺一个就会让下游时间码整体漂移：
      · clip_dur_sec：TB-01 分割后的取片窗口，优先于 duration_sec
      · speed：TB-03 变速（transform_meta.speed），2 倍速时占用时间减半
      · 缺省 5s：与前端 shotDuration / 导出兜底保持一致

    导出侧的权威写法在 media.py：`_sec = clip_dur / _spd`。
    SRT 生成原来只累加 duration_sec，两者不一致 —— 只要项目里有一个被分割
    或变速过的镜头，它之后**所有**字幕的时间码就整体偏掉，越往后偏得越多，
    而用户只会觉得"字幕对不上口型"，无从判断原因（B16）。
    """
    base = sh.clip_dur_sec if getattr(sh, "clip_dur_sec", None) else sh.duration_sec
    sec = float(base or 5.0)
    tm = getattr(sh, "transform_meta", None)
    if tm:
        try:
            import json as _json
            meta = _json.loads(tm) if isinstance(tm, str) else tm
            spd = float((meta or {}).get("speed") or 1.0)
            # 与 media.py 同样的钳制范围，避免除以 0 或荒谬值
            sec /= max(0.25, min(4.0, spd))
        except (ValueError, TypeError):
            pass      # 解析不了就按原速算，不该因此让导出失败
    return sec


@router.get("/projects/{project_id}/subtitles.srt")
def export_subtitles_srt(project_id: str) -> dict:
    """把字幕段导出为 SRT 文本（导出时烧录用）。

    时间轴上字幕锚定的是"第几个镜头 + 镜内偏移"，SRT 要的是绝对时间码，
    所以这里按镜头顺序累加时长换算——与导出拼接的口径必须一致：
    只算未停用镜头，时长走 effective_shot_sec()（含取片窗口与变速）。
    """
    from .db import SubtitleClip

    def _ts(sec: float) -> str:
        ms = int(round(sec * 1000))
        h, ms = divmod(ms, 3600_000)
        m, ms = divmod(ms, 60_000)
        s, ms = divmod(ms, 1000)
        return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"

    with get_session() as session:
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id, Shot.disabled == 0)
                 .order_by(Shot.order).all())
        offsets: dict[int, float] = {}
        acc = 0.0
        for sh in shots:
            offsets[sh.order] = acc
            # 与导出口径一致：取片窗口 + 变速都要算进去
            acc += effective_shot_sec(sh)

        rows = (session.query(SubtitleClip)
                .filter(SubtitleClip.project_id == project_id)
                .order_by(SubtitleClip.start_shot_order,
                          SubtitleClip.start_offset_sec).all())
        lines, n = [], 0
        for c in rows:
            base = offsets.get(c.start_shot_order)
            if base is None:      # 锚定镜头被删/停用 → 该字幕无处安放，跳过
                continue
            start = base + float(c.start_offset_sec or 0.0)
            n += 1
            lines.append(f"{n}\n{_ts(start)} --> {_ts(start + float(c.duration or 3.0))}\n"
                         f"{c.text}\n")
        return {"srt": "\n".join(lines), "count": n, "total_sec": acc}


# ---------- TB-07 音频素材库（BGM / 音效）----------
#: 设计偏离说明：方案原本设想 `GET /audio-library?kind=bgm|sfx` 是一个**平台内置
#: 曲库**。但本项目没有任何版权音乐资产，凭空返回一批曲目要么是假数据、要么是
#: 侵权外链，两者都比"没有"更糟。因此这里把它实现为**项目自有音频素材库**：
#: 复用已有的 media_clips（用户上传的音频），按用途打标签后分组返回。
#: 用户从素材面板传入自己的 BGM/音效，即可在音频面板按类别取用。
_AUDIO_TAG_KEY = "fw_audio_tag:"      # 存进 MediaClip.name 前缀太脏，改用独立表更好，
#: 但为了不再加一张表，标签放在 kind 上：audio(未分类) / audio_bgm / audio_sfx。


@router.get("/projects/{project_id}/audio-library")
def audio_library(project_id: str, kind: Optional[str] = None) -> dict:
    """项目音频素材库，按用途分组（bgm / sfx / 未分类）。

    数据源是用户上传的音频（media_clips），不是内置曲库——本项目没有可分发的
    版权音乐，给假曲目不如如实呈现"你自己传了什么"。
    """
    from .db import MediaClip
    with get_session() as session:
        q = (session.query(MediaClip)
             .filter(MediaClip.project_id == project_id,
                     MediaClip.kind.in_(("audio", "audio_bgm", "audio_sfx"))))
        rows = q.order_by(MediaClip.created_at).all()

    def _tag(c) -> str:
        return {"audio_bgm": "bgm", "audio_sfx": "sfx"}.get(c.kind, "unsorted")

    items = [{"id": c.id, "name": c.name, "url": c.url, "duration": c.duration,
              "size": c.size, "tag": _tag(c)} for c in rows]
    if kind in ("bgm", "sfx", "unsorted"):
        items = [i for i in items if i["tag"] == kind]
    return {
        "items": items,
        "counts": {
            "bgm": sum(1 for i in items if i["tag"] == "bgm"),
            "sfx": sum(1 for i in items if i["tag"] == "sfx"),
            "unsorted": sum(1 for i in items if i["tag"] == "unsorted"),
            "total": len(items),
        },
    }


class AudioTagIn(BaseModel):
    tag: str      # bgm | sfx | unsorted


@router.patch("/clips/{clip_id}/audio-tag")
def set_audio_tag(clip_id: str, body: AudioTagIn) -> dict:
    """给音频素材打用途标签（BGM / 音效 / 未分类）。"""
    from .db import MediaClip
    mapping = {"bgm": "audio_bgm", "sfx": "audio_sfx", "unsorted": "audio"}
    if body.tag not in mapping:
        raise HTTPException(400, "tag 只能是 bgm/sfx/unsorted")
    with get_session() as session:
        c = session.get(MediaClip, clip_id)
        if not c:
            raise HTTPException(404, "clip not found")
        if not (c.kind or "").startswith("audio"):
            raise HTTPException(400, "只有音频素材可以打用途标签")
        c.kind = mapping[body.tag]
        session.commit()
        return {"ok": True, "id": c.id, "tag": body.tag}


# ---------- 音色库（角色音色的"挑选"来源）----------
#: 为什么是 manifest 文件而不是数据库表：音色库是**全局素材**（不属于任何项目），
#: 内容由运维往目录里放，不由用户在软件里增删。加一张表意味着"放文件"之外还要
#: 写一次入库，多一道会忘的手续；manifest 就在音频旁边，放文件时顺手写完。
#:
#: ⚠️ 现在这个库是**空的**——用户已明确"音色库先留空，只做前端设计，后期再补"。
#: 所以本接口的**主要形态就是返回空列表**，绝不能因为文件不存在就 500：
#: 空库是今天的正常状态，不是错误。前端据此显示"建设中，可自行上传"。
#:
#: 目录 DATA_DIR/voice-library/ 已由 main.py 的 `/media` 整体挂载自动对外，
#: 无需新增 StaticFiles mount。后期补内容 = 丢音频 + 写 manifest，不用改代码。
_VOICE_LIB_DIRNAME = "voice-library"


@router.get("/voice-library")
def voice_library() -> dict:
    """全局音色库列表（可能为空）。

    manifest.json 形如：
      [{"id": "male_warm_01", "name": "沉稳男声", "gender": "male",
        "age": "青年", "style": "沉稳", "tags": ["旁白"], "file": "male_01.wav"}]
    只有 `file` 指向的音频**确实存在**时才返回该条——manifest 写了但文件没传，
    前端点了会试听失败，不如当它不存在。
    """
    from .media import DATA_DIR
    root = DATA_DIR / _VOICE_LIB_DIRNAME
    mf = root / "manifest.json"
    try:
        raw = json.loads(mf.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {"voices": [], "count": 0}
    except Exception as e:  # noqa: BLE001 — 坏 manifest 不该让整个面板打不开
        logger.warning("音色库 manifest 解析失败(%s)，按空库处理: %r", mf, e)
        return {"voices": [], "count": 0, "error": "音色库配置有误，已按空库显示"}

    if not isinstance(raw, list):
        logger.warning("音色库 manifest 顶层不是数组，按空库处理: %s", mf)
        return {"voices": [], "count": 0, "error": "音色库配置有误，已按空库显示"}

    voices: list[dict] = []
    for i, it in enumerate(raw):
        if not isinstance(it, dict):
            continue
        fname = str(it.get("file") or "").strip()
        # 只收单层文件名：manifest 是运维手写的，"../../etc/passwd" 这种既可能是
        # 手滑也可能是恶意，一律拒绝，别让它拼进对外 URL。
        if not fname or "/" in fname or "\\" in fname or fname.startswith("."):
            continue
        if not (root / fname).is_file():
            continue
        vid = str(it.get("id") or "").strip() or f"voice_{i}"
        voices.append({
            "id": vid,
            "name": str(it.get("name") or vid),
            "gender": str(it.get("gender") or "") or None,
            "age": str(it.get("age") or "") or None,
            "style": str(it.get("style") or "") or None,
            "tags": [str(t) for t in (it.get("tags") or []) if str(t).strip()],
            "url": f"/fw/media/{_VOICE_LIB_DIRNAME}/{fname}",
        })
    return {"voices": voices, "count": len(voices)}


# ---------- TB-08 自动字幕（语音识别）----------
@router.get("/asr/status")
def asr_status() -> dict:
    """语音识别通道是否可用（前端据此启用/置灰「自动生成字幕」）。"""
    from .providers.asr import ASRProvider
    return {"available": ASRProvider().available}


# ---------- Render V2 转场（挂在两个相邻镜头的接缝上）----------
class TransitionIn(BaseModel):
    project_id: str
    from_shot_id: str
    to_shot_id: str
    type: str = "fade"
    duration: float = 0.5
    params: Optional[dict] = None


class TransitionPatch(BaseModel):
    type: Optional[str] = None
    duration: Optional[float] = None
    params: Optional[dict] = None


def _trans_out(t) -> dict:
    return {"id": t.id, "type": t.type, "duration": t.duration,
            "from_shot_id": t.from_shot_id, "to_shot_id": t.to_shot_id,
            "params": json.loads(t.params) if t.params else None}


def _clamp_transition_duration(session, from_id: str, to_id: str, want: float) -> float:
    """转场时长不能超过任一侧镜头时长的一半。

    xfade 的重叠区是从两侧各吃掉一段。若转场比某侧镜头还长，那个镜头会被
    整个吃掉，产出画面完全不是用户想要的。这里在落库时钳制，前端也做同样
    校验——两边都做是因为接口可能被别处调用。
    """
    lo = 0.1
    hi = 5.0
    for sid in (from_id, to_id):
        sh = session.get(Shot, sid)
        if sh:
            hi = min(hi, max(lo, float(sh.duration_sec or 5.0) / 2))
    return max(lo, min(hi, float(want)))


@router.get("/projects/{project_id}/transitions")
def list_transitions(project_id: str) -> dict:
    from .db import Transition
    with get_session() as session:
        rows = (session.query(Transition)
                .filter(Transition.project_id == project_id).all())
        return {"transitions": [_trans_out(t) for t in rows]}


@router.post("/transitions")
def create_transition(body: TransitionIn) -> dict:
    """在两个镜头的接缝处建转场。同一接缝只允许一个——重复提交视为替换。"""
    from datetime import datetime, timezone
    from .db import Transition
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        a, b = session.get(Shot, body.from_shot_id), session.get(Shot, body.to_shot_id)
        if not a or not b:
            raise HTTPException(status_code=404, detail="shot not found")
        if a.order + 1 != b.order:
            raise HTTPException(
                status_code=422,
                detail=f"转场只能加在相邻镜头之间（#{a.order} 与 #{b.order} 不相邻）")

        dur = _clamp_transition_duration(session, body.from_shot_id, body.to_shot_id,
                                         body.duration)
        # 同一接缝已有转场 → 覆盖，而不是叠加出两个
        exist = (session.query(Transition)
                 .filter(Transition.from_shot_id == body.from_shot_id,
                         Transition.to_shot_id == body.to_shot_id).first())
        if exist:
            exist.type = body.type
            exist.duration = dur
            exist.params = json.dumps(body.params, ensure_ascii=False) if body.params else None
            session.commit()
            return {"ok": True, "replaced": True, **_trans_out(exist)}

        t = Transition(
            id=uuid.uuid4().hex[:12], project_id=body.project_id,
            type=body.type, duration=dur,
            from_shot_id=body.from_shot_id, to_shot_id=body.to_shot_id,
            params=json.dumps(body.params, ensure_ascii=False) if body.params else None,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        )
        session.add(t)
        session.commit()
        return {"ok": True, "replaced": False, **_trans_out(t)}


@router.patch("/transitions/{trans_id}")
def patch_transition(trans_id: str, body: TransitionPatch) -> dict:
    from .db import Transition
    with get_session() as session:
        t = session.get(Transition, trans_id)
        if not t:
            raise HTTPException(status_code=404, detail="transition not found")
        if body.type is not None:
            t.type = body.type
        if body.duration is not None:
            t.duration = _clamp_transition_duration(
                session, t.from_shot_id, t.to_shot_id, body.duration)
        if body.params is not None:
            t.params = json.dumps(body.params, ensure_ascii=False)
        session.commit()
        return {"ok": True, **_trans_out(t)}


@router.delete("/transitions/{trans_id}")
def delete_transition(trans_id: str) -> dict:
    from .db import Transition
    with get_session() as session:
        t = session.get(Transition, trans_id)
        if not t:
            raise HTTPException(status_code=404, detail="transition not found")
        session.delete(t)
        session.commit()
    return {"ok": True}


# ---------- P1-1 存量缩略图回填 ----------
@router.post("/projects/{project_id}/backfill-thumbs")
async def backfill_thumbs(project_id: str) -> dict:
    """为已有视频但没缩略图的镜头补抽首帧（缩略图上线前生成的存量数据用）。

    串行抽帧：ffmpeg 关键帧定位单张只需几十毫秒，几百镜也在可接受范围内，
    且串行不会和正在跑的生成任务抢 CPU。同时回写 Shot 与其采用版本。
    """
    from .media import make_thumb
    with get_session() as session:
        if not session.get(Project, project_id):
            raise HTTPException(status_code=404, detail="project not found")
        targets = [
            (s.id, s.video_url, s.adopted_version)
            for s in session.query(Shot).filter(Shot.project_id == project_id).all()
            if s.video_url and not s.thumb_url
        ]
    filled, failed = 0, 0
    for sid, video_url, adopted in targets:
        thumb = await make_thumb(video_url)
        if not thumb:
            failed += 1
            continue
        with get_session() as session:
            shot = session.get(Shot, sid)
            if shot:
                shot.thumb_url = thumb
            if adopted is not None:
                ver = (session.query(ShotVersion)
                       .filter(ShotVersion.shot_id == sid,
                               ShotVersion.version_no == adopted).first())
                if ver and not ver.thumb_url:
                    ver.thumb_url = thumb
            session.commit()
        filled += 1
    return {"ok": True, "scanned": len(targets), "filled": filled, "failed": failed}


# ---------- 阶段①：剧本优化 ----------
class ScriptOptimizeIn(BaseModel):
    raw: str
    model_id: Optional[str] = None  # 缺省用 settings.llm_model
    instruction: Optional[str] = None
    project_id: Optional[str] = None  # 传入则原文/优化结果落库


class ScriptOptimizeOut(BaseModel):
    optimized: str
    model_id: str


_OPTIMIZE_SYSTEM = (
    "你是资深短剧编剧。将用户提供的原始剧本/文本优化为适合分镜成片的剧本："
    "保留核心剧情与人物，强化画面感与镜头感，删除冗余，使每个段落都能对应可拍摄的镜头。"
    "只输出优化后的剧本正文，不要解释。"
)


@router.post("/script/optimize", response_model=ScriptOptimizeOut)
async def script_optimize(body: ScriptOptimizeIn) -> ScriptOptimizeOut:
    llm = LLMProvider(model_id=body.model_id)
    user = body.raw if not body.instruction else f"额外要求：{body.instruction}\n\n原文：\n{body.raw}"
    try:
        optimized = await llm.complete(_OPTIMIZE_SYSTEM, user)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"LLM 调用失败: {e!r}")
    # 落库：切页/重启不丢
    if body.project_id:
        with get_session() as session:
            proj = session.get(Project, body.project_id)
            if proj:
                proj.raw_script = body.raw
                proj.optimized_script = optimized.strip()
                session.commit()
    return ScriptOptimizeOut(optimized=optimized.strip(), model_id=llm.model_id)


# ---------- 阶段②：镜头拆解 + 资产盘点 ----------
class ScriptBreakdownIn(BaseModel):
    script: str
    model_id: Optional[str] = None  # 缺省用 settings.llm_model
    project_id: Optional[str] = None  # 传入则拆解结果自动落库
    episode: Optional[int] = None  # 按集拆解：只覆盖该集镜头；缺省=整项目重拆(episode=1)


class ShotDraft(BaseModel):
    order: int
    script_ref: str
    link_to_prev: str = "continuous"  # continuous | transition
    characters: list[str] = []
    location: Optional[str] = None
    duration_sec: Optional[float] = None  # AI 拆镜判定时长（钳制后 [7, 模型上限]）


#: 片段时长的「甜点区间」。实测口径（项目「就可能会」85 镜，用户逐条审片）：
#: **7 秒以内的片段整体连贯性与表现力明显不足**——一个动作还没做完就切了，
#: 模型只能靠慢动作或静止硬撑；而视频模型单次最长 15 秒。
#: 于是：硬下限 7s（低于此不允许存在），目标区间 8-12s（拆解时按它设计节拍），
#: 硬上限 15s（模型能力上限）。
#: ⚠️ 光把生成参数钳到 7s 是**错的**：内容只有 3 秒、时长填 7 秒 = 注水慢镜。
#: 所以真正的修复在拆解阶段——见 _BREAKDOWN_SYSTEM 规则 5/6 与 _merge_short_shots：
#: 拆的时候就按 8-12s 的容量去组织节拍，一镜可含 2-3 个连续动作。
_DUR_FLOOR = 7.0
_DUR_SWEET_LO = 8.0
_DUR_SWEET_HI = 12.0
_DUR_CEIL = 15.0


class _DurWindow(NamedTuple):
    """一次拆解的镜头**合并**参数。由项目选定的视频模型决定。

    ⚠️ 它只管「几个节拍能并成一镜」，**不管「一个节拍值多少秒」**。
    秒数永远由内容决定（LLM 按 4 字/秒等规则估、`_raw_duration` 兜底），
    与用哪个模型无关：同一集剧本换个模型不会突然多出 30 秒剧情。

    这个边界是踩坑踩出来的。最初的写法是把 [25,30] 当"目标区间"写进提示词，
    结果 LLM 直接照着区间填数字：1870 字的一集，8-12 秒窗口下报 90 秒、
    25-30 秒窗口下报 120 秒，而两次的 script_ref 文字量几乎相同——
    多出来的 30 秒是注水的慢镜。**给 LLM 什么区间它就填什么区间**，
    那是锚定不是估计，所以现在提示词对所有模型完全一致。

    - `floor`  合并判定阈值：短于它的镜头就尝试并进邻镜
    - `ceil`   模型单镜硬上限：合并后不得越过它，最终时长也钳在它以内
    """
    floor: float
    ceil: float


#: 15 秒级模型（seedance-2.0 / veo / H3）的参数 = 历史行为：
#: 只把不足 7 秒的碎片并掉，不做额外打包。
_DUR_WINDOW_DEFAULT = _DurWindow(_DUR_FLOOR, _DUR_CEIL)


def _dur_window(cap_sec: float | None) -> _DurWindow:
    """模型单镜上限 → 合并参数。

    `cap_sec` 是**模型宣称一镜能出多长**（不扣 TTS 余量：真人剧没有旁白，
    时长直接下发给视频模型，贴着厂商硬钳走是安全的）。

    ≤16s 退回历史参数，保证 seedance-2.0 / veo / H3 的拆解结果与改动前一致。

    更长的模型（seedance-2.5 = 30s）令 `floor = ceil`：**只要相邻两镜加起来
    装得下就并**，一路打包到 30 秒。这才是长镜模型的正确用法——
    把本来要切成 3 刀的一场戏用 1 个镜头拍完，AI 只需想象一次那扇门，
    总时长一秒不变（合并只是把秒数相加），变的只有刀数。
    """
    if not cap_sec or cap_sec <= 16.0:
        return _DUR_WINDOW_DEFAULT
    ceil = float(int(cap_sec))
    return _DurWindow(ceil, ceil)


def _raw_duration(ref: str, ai_sec: float | None) -> float:
    """内容本身值多少秒（**不钳到甜点区间**）：合并判定用它。

    合并判定必须看"真实内容量"，不能看钳制后的值——钳完人人都 ≥7s，
    就再也看不出哪一镜其实是碎片、该并进邻镜了。

    2026-09-01 重写：改由 `drama_timing` 按**剧本格式**逐行估算
    （同期台词 + max(动作节拍, 画外音)），并用 `reconcile` 把 LLM 报的秒数
    收进内容允许的区间。老实现只认引号内对白，而本系统剧本写作
    `角色【情绪】：台词`，一个引号都没有 —— 对白下限恒为 0，
    LLM 报多少就是多少。项目「9125」镜 6 因此 182 字塞进 23 秒
    （7.9 字/秒，语速失真），镜 7 则 33 字注水到 10 秒。
    """
    return drama_timing.reconcile(drama_timing.estimate_seconds(ref), ai_sec)


def _clamp_duration(ref: str, ai_sec: float | None,
                    win: _DurWindow = _DUR_WINDOW_DEFAULT) -> float:
    """时长三层控制的第 2 层：确定性钳制到 [7, win.ceil]。

    - 对白物理下限：引号内字数 / 4字每秒 + 1s 动作缓冲（保台词说得完）
    - AI 缺失/离谱值时按内容兜底估算
    - 上限取 `win.ceil`（模型单次上限：2.0 是 15s，2.5 是 30s）——超了会被
      厂商静默钳掉，画面早停而后面的镜头时间轴还按下发值排，必然错位。
    - 下限**恒为 7s，不跟着窗口抬高**：合并兜底之后仍不足 7s 的（整集最后一个
      孤立节拍、无法与邻镜合并的转场）按 7s 下发。长窗口下若把下限抬到 25s，
      一个真只有 8 秒内容的收尾镜会被注水成 25 秒的慢镜——那比碎片更难看。
    """
    return round(max(_DUR_FLOOR, min(win.ceil, _raw_duration(ref, ai_sec))), 1)


def _narration_duration(ref: str, cap_sec: float) -> float:
    """解说剧的镜头时长初值：**按旁白朗读时长**，而不是甜点区间 [7,15]。

    解说剧的画面是给旁白配的，镜头该多长完全由"这段文字读多久"决定
    （见 jobs._retime_shot：TTS 出来后还会用真实时长再覆盖一次）。
    用 [7,15] 钳会有两种错法：480p 能出 45s 长镜却被砍成 15s（旁白大段盖到
    下一镜），1080p 只能出 7.5s 却下发 15s（模型静默截断，画面早停声音还在响）。

    这里只负责"首次出片时的目标时长合理"，最终仍以 TTS 实测时长为准。
    """
    from .script_import import estimate_tts_seconds
    sec = estimate_tts_seconds(ref) + 0.4      # 与 _retime_shot 同样留 0.4s 尾巴
    return round(max(2.0, min(cap_sec, sec)), 1)


def _split_overlong_shots(shots: list[dict], max_chars: int | None) -> list[dict]:
    """确定性兜底：把"文字读不完"的镜头按句界拆开（解说剧专用）。

    拆镜提示词是按「7-15 秒**视频**」设计的，但解说剧的镜头时长由旁白朗读时长
    决定，上限来自视频模型的显存包线（720p 海螺 H3 只有 19.1s ≈ 85 字）。
    实测项目 930 拆出的镜头平均 116 字、要读 26 秒——**一镜的文字根本读不完**，
    多出来的部分要么被截断、要么盖到下一镜上，两种都是声画错位。

    提示词里已经写了字数上限，但 LLM 不保证遵守，所以这里再确定性地补一刀。
    切分复用 `script_import.plan_narration_by_shot`（与旁白切分**同一个函数**）：
    两处用不同算法切同一段文字，正是本次事故的成因，不能再犯第二次。
    """
    if not max_chars or max_chars <= 0:
        return shots
    from .script_import import plan_narration_by_shot, _CHARS_PER_SEC_SLOW
    max_sec = max_chars / _CHARS_PER_SEC_SLOW
    plans = plan_narration_by_shot([s.get("script_ref") or "" for s in shots], max_sec)
    out: list[dict] = []
    for s, segs in zip(shots, plans):
        if len(segs) <= 1:
            out.append(s)
            continue
        # 克隆画面字段、只换 script_ref：解说剧的画面本就是旁白的视觉陪衬，
        # 同一场景连着几个镜头是常态，不必为每段现编一个新画面描述。
        for k, seg in enumerate(segs):
            child = dict(s)
            child["script_ref"] = seg
            child["duration_sec"] = None      # 由下游按朗读时长/TTS 实测回写
            if k > 0:
                child["link_to_prev"] = "continuous"
            out.append(child)
    for i, s in enumerate(out):
        s["order"] = i + 1
    return out


def _split_overlong_drama_shots(shots: list[dict],
                                win: _DurWindow) -> list[dict]:
    """确定性兜底：真人剧里"台词念不完"的镜头按内容单元拆开。

    与 `_split_overlong_shots`（解说剧、按字数）对称的真人剧版本，按**秒**判。
    在此之前真人剧根本没有拆分兜底：超过模型上限的镜头只会被 `_clamp_duration`
    静默钳到 ceil，于是内容 36.7 秒的镜头下发 30 秒，多出的台词要么被模型
    加速念完（语速失真，正是项目「9125」镜 6 的现象），要么直接截断。
    钳制改变的只是下发的数字，改变不了要念的字数——必须真的切一刀。

    ⚠️ 拆分只在**内容确实超过模型单镜上限**时发生，不会凭空增加刀数：
    合并阶段（`_merge_short_shots`）已经把能并的都并到 ceil 以内了，
    能走到这里的都是单镜内容本身就超容量的。拆开不增加总时长。
    """
    out: list[dict] = []
    for s in shots:
        ref = s.get("script_ref") or ""
        est = drama_timing.estimate_seconds(ref)
        if est <= win.ceil:
            out.append(s)
            continue
        parts = drama_timing.split_ref_by_cap(ref, win.ceil)
        if len(parts) <= 1:
            out.append(s)
            continue
        for k, (seg, sec) in enumerate(parts):
            child = dict(s)
            child["script_ref"] = seg
            child["duration_sec"] = round(sec, 1)
            if k > 0:
                # 拆出来的后续段与前段是同一场戏的连续时刻
                child["link_to_prev"] = "continuous"
            out.append(child)
    for i, s in enumerate(out):
        s["order"] = i + 1
    return out


class BreakdownOut(BaseModel):
    shots: list[ShotDraft]
    characters: list[str]
    locations: list[str]
    model_id: str


#: 拆解 system 提示词。**对所有视频模型完全一致**，不随模型能力变。
#:
#: 曾经把它改成随模型窗口生成的函数（seedance-2.5 时写「目标 25-30 秒」），
#: 实测证明那是错的：LLM 会照着给定区间填数字，而不是估算内容——
#: 同一集 1870 字的剧本，8-12 秒窗口下报 90 秒，25-30 秒窗口下报 120 秒，
#: 每个字分到的银幕时间凭空多了 30%，而 script_ref 的文字量几乎没变。
#: 那 30% 是注水的慢镜，不是多出来的内容。
#:
#: 所以「模型能出多长」只允许影响**分组**（几个节拍并成一镜，见
#: `_merge_short_shots`），绝不允许影响**秒数**。秒数永远是对内容的诚实估计。
_BREAKDOWN_SYSTEM = (
    "你是分镜师。把剧本拆成镜头序列，并盘点资产。\n"
    "每个镜头会被 AI 视频模型生成为**一个 7-15 秒的连续片段**，因此镜头的"
    "颗粒度必须按这个容量来设计：一镜可以包含 2-3 个前后相继的动作节拍"
    "（如「走到门前→发现门虚掩→推门而入」），片段内部由镜头运动与剪接来承载，"
    "不要把它们拆成三个各三四秒的镜头。\n"
    "拆分规则（严格遵守）：\n"
    "1) 一个镜头 = 一段可一镜到底拍完的连续叙事，必须包含具体剧情事件："
    "人物动作、对白、情绪反应或关键剧情信息。\n"
    "2) 纯环境/氛围/景物描写（如\"阳光穿过百叶窗照在衣柜上\"）**不得独立成镜**，"
    "必须并入它所引出的下一个有人物/事件的镜头，作为该镜的画面开场氛围写进 script_ref。\n"
    "3) 场景标题行（如\"日 内 某某房间\"\"夜 外 街道\"）是元数据：写入 location 字段，"
    "不要出现在 script_ref、更不得独立成镜。\n"
    "4) script_ref 完整保留原文文字（合并时按顺序拼接），不要改写、缩写。\n"
    "5) 为每镜估算时长 duration_sec：**必须落在 7-15 秒之间，目标 8-12 秒**。"
    "有对白按中文语速约 4 字/秒加 1 秒动作缓冲计算；估下来不足 7 秒的节拍"
    "**一律与相邻节拍合并**，直到落进 8-12 秒；单镜内容超过 15 秒才允许拆开，"
    "并按说话轮次或动作段落在最自然处断开，两段都要各自 ≥7 秒。\n"
    "6) **同一个连续动作、同一件道具的一段过程，必须放在同一个镜头里**："
    "开门/关门、上下车、接打同一通电话、递交并接过同一件物品、"
    "同一段追逐或撕扯——不得拆成两个镜头。原因：道具与场景的外观由 AI 逐镜生成，"
    "拆成两镜就会出现前一镜是木门、后一镜变成玻璃门这类穿帮。"
    "涉及门/车/电梯/信件等具体道具时尤其注意把「接近-接触-完成」写进同一镜。\n"
    "7) 只有真正的场景切换、时间跳跃或叙事视角转移才断镜（link_to_prev 写 transition）；"
    "同一场戏内部的连续动作一律 continuous。\n"
    "8) **characters 要列出该镜画面中「在场」的全部角色，不是只列有台词或有动作的人。**"
    "坐在旁边不说话、站在一边旁观、被搀扶着、正在听别人讲话的人，只要画面里有他，"
    "就必须列进去。判据是**离场描写**：某角色出现之后，只有当剧本明确写了他离开"
    "（走出画面/离开/起身离去/摔门而去/挂断电话下线/下车/被带走等）才可以从后续镜头里去掉；"
    "**没有写离场就默认他还在原地**。\n"
    "   这条极其重要：漏掉一个在场角色，成片里这个人就会凭空消失，"
    "下一镜又突然出现，观众会以为剪辑出错。宁可多列一个，也不要漏。\n"
    "9) 另外用 enters / exits 两个数组标明本镜**新进画**和**离开画面**的角色"
    "（没有就给空数组）。这两个字段用来校验第 8 条，不要漏。\n"
    '严格输出 JSON，格式为：'
    '{"shots":[{"order":1,"script_ref":"该镜对应的剧本片段","duration_sec":9.0,'
    '"link_to_prev":"continuous 或 transition","characters":["本镜在场的全部角色名"],'
    '"enters":[],"exits":[],"location":"场景名"}],'
    '"characters":["全部角色去重"],"locations":["全部场景去重"]}。'
    "只输出 JSON，不要 markdown 代码块、不要解释。"
)


# 对白特征（兜底合并的豁免判断：有对白的短镜头是合法的）。
# 只认引号——"特写：""近景："这类镜头术语也带冒号，不能凭冒号判定对白。
_DIALOG_MARKS = ("“", "”", "「", "」", "『", "』", '"')


def _merge_fragment_shots(shots: list[dict]) -> list[dict]:
    """确定性兜底：LLM 未遵守规则时，把"碎片镜头"并入相邻镜头。

    碎片镜头 = 无人物 且 无对白特征 且 原文 < 40 字（典型：纯环境描写、
    场景标题残留）。并入下一镜的 script_ref 开头（作画面开场氛围）；
    若是最后一镜则并入上一镜结尾。location 缺失时向后传递。
    """
    if len(shots) <= 1:
        return shots
    merged: list[dict] = []
    pending_prefix = ""   # 待并入下一镜的环境描写
    pending_loc: str | None = None
    for s in shots:
        ref = (s.get("script_ref") or "").strip()
        has_char = bool(s.get("characters"))
        has_dialog = any(m in ref for m in _DIALOG_MARKS)
        if not has_char and not has_dialog and len(ref) < 40:
            pending_prefix = f"{pending_prefix}{ref}" if pending_prefix else ref
            pending_loc = pending_loc or s.get("location")
            continue
        if pending_prefix:
            s["script_ref"] = f"{pending_prefix} {ref}"
            s["location"] = s.get("location") or pending_loc
            pending_prefix = ""
            pending_loc = None
        merged.append(s)
    if pending_prefix:
        if merged:
            merged[-1]["script_ref"] = f"{merged[-1]['script_ref']} {pending_prefix}"
        else:  # 整块全是环境描写：保底成一镜
            merged.append({"script_ref": pending_prefix, "link_to_prev": "transition",
                           "characters": [], "location": pending_loc})
    for i, s in enumerate(merged):
        s["order"] = i + 1
    return merged


#: 场景名里的**时间标记**（按空格/标点切出来的整词才算）。
#: 它不是空间，但它决定能不能并：白天的镜头和夜里的镜头并进同一条连续镜头
#: 就是穿帮。只按整词匹配，避免把「夜市」「日光浴室」这类地名误当时间。
_LOC_TIME_DAY = ("日", "白天", "晨", "清晨", "早", "早晨", "上午", "中午",
                 "下午", "午后", "日间")
_LOC_TIME_NIGHT = ("夜", "夜晚", "深夜", "凌晨", "晚", "晚上", "傍晚", "黄昏")
#: 内外景 / 时间标记之外的纯修饰词，比较物理空间时剥掉。
_LOC_DROP = _LOC_TIME_DAY + _LOC_TIME_NIGHT + ("内", "外", "内景", "外景")
#: 时空跳跃标记：只有一侧带 = 一侧是回忆、另一侧是当下，绝不合并。
#: （按子串匹配：真实数据里它常粘在括号里，如「顾家老宅（十二年前）」。）
_LOC_FLASHBACK = ("回忆", "闪回", "年前", "年后", "往事", "多年")
#: 场景名的切词分隔符（真实数据形如「夜 内 顾家客厅」「顾家大宅 客厅」
#: 「夜 路上/医院」「顾家老宅（十二年前）」）。
_LOC_SEPS = " \t　/／、,，;；·|｜()（）[]【】<>《》-—~～"
def _loc_tokens(s: str) -> list[str]:
    """按分隔符把场景名切成词。"""
    out, cur = [], ""
    for ch in s:
        if ch in _LOC_SEPS:
            if cur:
                out.append(cur)
            cur = ""
        else:
            cur += ch
    if cur:
        out.append(cur)
    return out


def _loc_time_class(tokens: list[str]) -> str | None:
    """场景名里的昼夜标记：'day' / 'night' / None（没标）。"""
    for t in tokens:
        if t in _LOC_TIME_DAY:
            return "day"
        if t in _LOC_TIME_NIGHT:
            return "night"
    return None


def _loc_place_part(tokens: list[str]) -> str:
    """剥掉时间/内外景修饰后的**纯空间名**（拼在一起，便于做子串比较）。"""
    return "".join(t for t in tokens if t not in _LOC_DROP)


def _loc_related(a: str | None, b: str | None) -> bool:
    """两个场景名是否属于同一处物理空间**且同一时间**（合并的安全闸门）。

    一个镜头是一条**连续镜头**，所以只有真正同一处、同一时刻的两段才能并。
    判定分三步，任一步否决就不并（宁可漏合不可错合）：

    1) 时空跳跃：只有一侧标了「回忆 / 十二年前」→ 一侧是过去一侧是当下，不并。
    2) 昼夜冲突：一侧标「日」另一侧标「夜」→ 不并（并了就是一条镜头里天亮又天黑）。
    3) 空间相关：剥掉时间/内外景修饰后，相等 / 一方缺失 / 一方包含另一方 /
       共同前缀 ≥3 字。「豪华套房走廊及门口」与「豪华套房客厅」共享前缀
       「豪华套房」——正是"推门而入"那种一镜到底的走位，可以并。

    ⚠️ **共享通名不算相关**，试过、撤了。曾放宽成"共享一段含地点语素的子串
    就算同一处"，拿全库 896 组真实相邻场景对一验：`医院病房 ⇄ 医院走廊`
    （共享「医院」）、`顾氏集团 白薇办公室 ⇄ 顾耀东办公室`（共享「办公室」）、
    `工作室办公室 ⇄ 幼儿园教师办公室` 全部变成可并——「医院」「办公室」是通名
    不是同一处，并进一条连续镜头就是串戏。多留一刀远好过串戏。

    ⚠️ 剥时间修饰这一步同样是拿真实数据揪出来的：老实现直接在原串上比前缀，
    于是「夜 内 顾耀东书房」与「夜 内 沈修杰律所办公室」被判成相关——
    光「夜 内 」就凑满了 3 字前缀。全库有 167 处这种漏判；本来还被"其中一镜
    必须 <7s"挡住大半，一旦按 30s 打包（floor=ceil=30）就会大面积串戏。
    """
    x = (a or "").strip()
    y = (b or "").strip()
    if not x or not y or x == y:
        return True
    if any(t in x for t in _LOC_FLASHBACK) != any(t in y for t in _LOC_FLASHBACK):
        return False
    tx, ty = _loc_tokens(x), _loc_tokens(y)
    cx, cy = _loc_time_class(tx), _loc_time_class(ty)
    if cx and cy and cx != cy:
        return False
    px, py = _loc_place_part(tx), _loc_place_part(ty)
    if not px or not py or px == py:
        return True
    if px in py or py in px:
        return True
    n = 0
    for ca, cb in zip(px, py):
        if ca != cb:
            break
        n += 1
    return n >= 3


def _merge_short_shots(shots: list[dict],
                       win: _DurWindow = _DUR_WINDOW_DEFAULT) -> list[dict]:
    """确定性兜底：把短镜头并进相邻镜头。**合并只把秒数相加，不制造时长。**

    两种用法，由 `win` 区分：
    - 15s 级模型（默认参数）：`floor=7` —— 只并不足 7 秒的碎片。这是 B1
      （<7s 片段连贯性差）与 B2（一个开门情节被拆成两镜、门的外观前后不一致）
      的同一个解：LLM 没按甜点区间设计时由这里确定性补上。
    - 长镜模型（seedance-2.5，`floor=ceil=30`）：**只要装得下就并**，一路打包
      到 30 秒。这是长镜能力的正确用法——一场戏从 3 刀变 1 刀，AI 只想象一次
      那扇门；总时长一秒不变，因为合并就是把两段的秒数相加。

    合并条件（全部满足才并，宁可漏合不可错合）：
    - 其中一镜的**真实内容量** < win.floor（_raw_duration，不是钳制后的值）
    - 合并后 ≤ win.ceil（模型单次上限；15s 级下这里放到上限而不是目标上限，
      是因为 "5.5s 的到门口 + 7s 的推门而入" 合起来 12.5s——超了目标上限 12s
      却正是必须合并的那一对，拆开就是用户实测到的"门的外观前后不一致"）
    - **没换场**，两套判据分工明确：
      · 后一镜 `link_to_prev == "continuous"` → LLM 已明确宣称没换场，采信它，
        只再查人物相容。全库实测：4946 处 continuous 对场景名相同、104 处不同，
        而那 104 处绝大多数是同一处的更细名字（「酒店宴会厅 讲台前」→「讲台」、
        「民政局门口」→「民政局外台阶」），真标错的约 6 处 ≈ 全部的 0.12%。
        **不再拿场景名去二次否决 continuous**——同一场戏里 LLM 常给每镜写更细的
        子场景名（「医院大礼堂」→「大礼堂观众席」），按名字判就白留一刀，
        而每多一刀就多一个前后衔接不上的风险点。
      · 标了 `transition` → LLM 说这里断了，只有**场景相关且人物有交集**才推翻它。
        "走廊→推门进客厅" 常被误标 transition，实际是同一处空间的一镜到底走位。
    - 人物相容：两边角色有交集，或其中一边没有角色（纯动作/道具特写）
    合并后取**后一镜**的场景名：走廊→客厅这种推入，落点场景才是资产该锚的那个。
    """
    if len(shots) <= 1:
        return shots
    out: list[dict] = []
    for s in shots:
        ref = (s.get("script_ref") or "").strip()
        dur = _raw_duration(ref, s.get("duration_sec"))
        if out:
            prev = out[-1]
            pchars = list(prev.get("characters") or [])
            schars = list(s.get("characters") or [])
            overlap = bool(set(pchars) & set(schars))
            chars_ok = (not pchars or not schars or overlap)
            continuous = s.get("link_to_prev", "continuous") == "continuous"
            # continuous = LLM 明确宣称"这里没换场"（提示词规则 7：只有真正的
            # 场景切换/时间跳跃/视角转移才写 transition），直接采信，不再拿
            # 场景名去二次否决——同一场戏里 LLM 常给每镜写更细的子场景名
            # （「大礼堂」→「大礼堂观众席」），按名字判就白留一刀。
            # transition 时才用 _loc_related 兜底救误标（走廊→推门进客厅）。
            same_scene = chars_ok if continuous else (
                overlap and _loc_related(prev.get("location"), s.get("location")))
            if (min(prev["_dur"], dur) < win.floor
                    and prev["_dur"] + dur <= win.ceil
                    and same_scene):
                prev["script_ref"] = f"{prev['script_ref']} {ref}".strip()
                prev["characters"] = pchars + [c for c in schars if c not in pchars]
                prev["location"] = s.get("location") or prev.get("location")
                prev["_dur"] = min(win.ceil, prev["_dur"] + dur)
                prev["duration_sec"] = round(prev["_dur"], 1)
                continue
        s = dict(s)
        s["script_ref"] = ref
        s["_dur"] = dur
        s["duration_sec"] = round(dur, 1)
        out.append(s)
    for i, s in enumerate(out):
        s.pop("_dur", None)
        s["order"] = i + 1
    return out


def _parse_breakdown_json(raw: str) -> dict:
    """解析拆解 JSON，带截断抢救。

    LLM 输出超长被截断时（尾部残缺如 `"ch`），完整 json.loads 必失败。
    抢救策略：定位 "shots" 数组，用 raw_decode 逐个提取**完整的**镜头对象，
    残缺的最后一个自然丢弃；characters/locations 缺失时从镜头聚合。
    """
    text = raw.strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.startswith("json"):
            text = text[4:]
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # ---- 抢救：逐对象解析 shots 数组 ----
    dec = json.JSONDecoder()
    start = text.find('"shots"')
    if start == -1:
        raise RuntimeError(f"模型未返回合法 JSON: {raw[:300]}")
    pos = text.find("[", start)
    if pos == -1:
        raise RuntimeError(f"模型未返回合法 JSON: {raw[:300]}")
    pos += 1
    shots: list[dict] = []
    while pos < len(text):
        while pos < len(text) and text[pos] in " \n\r\t,":
            pos += 1
        if pos >= len(text) or text[pos] == "]":
            break
        try:
            obj, pos = dec.raw_decode(text, pos)
            if isinstance(obj, dict) and obj.get("script_ref"):
                shots.append(obj)
        except json.JSONDecodeError:
            break  # 残缺尾部，丢弃
    if not shots:
        raise RuntimeError(f"模型未返回合法 JSON 且无法抢救: {raw[:300]}")
    # characters/locations 从镜头聚合（截断时顶层字段通常已丢失）
    chars: list[str] = []
    locs: list[str] = []
    for s in shots:
        for c in s.get("characters") or []:
            if c not in chars:
                chars.append(c)
        loc = s.get("location")
        if loc and loc not in locs:
            locs.append(loc)
    return {"shots": shots, "characters": chars, "locations": locs, "_salvaged": True}


#: 拆解落库互斥锁：多集并发拆解时，order 编号（base_order 递增）与资产增量合并
#: 必须串行提交，否则并发读到相同 base_order → 镜头 order 重复 / 资产重复行。
#: LLM 调用（耗时主体）在锁外并发，只有落库段持锁（毫秒级），不牺牲并发收益。
_BREAKDOWN_DB_LOCK = asyncio.Lock()


async def do_breakdown(script: str, model_id: Optional[str],
                       project_id: Optional[str],
                       episode: Optional[int] = None,
                       max_chars: Optional[int] = None,
                       shot_cap_sec: Optional[float] = None) -> BreakdownOut:
    """拆解核心（供路由与一键成片 Saga 复用）。失败抛 RuntimeError。

    长文防丢：超过 2800 字按句界分块（不切断剧情），逐块拆解合并——
    避免整集直喂导致输出截断与中段剧情被略过。
    episode 传入时为"按集拆解"：只替换该集镜头（order 全项目连续递增），
    资产做增量合并；不传则整项目重拆（历史行为，episode 记 1）。
    多集并发安全：落库段持 _BREAKDOWN_DB_LOCK（见锁注释）。

    `max_chars`：单镜 script_ref 的字数上限（解说剧专用）。解说剧的镜头时长是
    **旁白朗读时长**，上限来自视频模型的显存包线；一镜的文字读不完就必然声画
    错位。传了它就在提示词里写死字数上限，并在落库前跑
    `_split_overlong_shots` 确定性兜底（LLM 不遵守时照样成立）。
    不传 = 真人剧的老行为（按视频模型的单镜容量区间设计）。

    `shot_cap_sec`：视频模型宣称的单镜时长上限（**真人剧专用**）。
    它**不进提示词**、不改变任何一镜的秒数，只放宽 `_merge_short_shots` 的
    打包上限：15s 级模型只并碎片，seedance-2.5 的 30s 则把相邻节拍一路并到
    30 秒。所以同一集剧本换模型后**总时长不变、镜头数变少**——
    变的是刀数，不是内容。
    解说剧（max_chars 有值）不受它影响——那边的镜头长度由旁白朗读时长决定，
    用长窗口去合并会把按句切好的旁白又粘回去。
    """
    from .script_import import MIN_BREAKDOWN_CHARS, split_for_ai
    from .script_import import _CHARS_PER_SEC_SLOW as _CPS_SLOW

    # 解说剧的镜头长度由旁白朗读时长决定，一律用历史合并参数；
    # 真人剧才按模型的单镜能力放宽打包上限（只影响合并，不影响秒数）。
    win = (_DUR_WINDOW_DEFAULT if (max_chars and max_chars > 0)
           else _dur_window(shot_cap_sec))

    # 兜底守卫（C1）：正文过短一律不调 LLM，直接返回空结果。
    # run_breakdown_all 已在上游过滤过，但本函数也被 /breakdown 路由直接调用，
    # 而"给模型极少的字却要求它产出镜头"必然换来虚构内容 —— 这类假数据会一路
    # 流进资产/首帧/成片，事后极难分辨。宁可产出 0 镜。
    if len((script or "").strip()) < MIN_BREAKDOWN_CHARS:
        logger.warning("[breakdown] 正文仅 %d 字，低于 %d 字门槛，跳过拆解（不调 LLM）",
                       len((script or "").strip()), MIN_BREAKDOWN_CHARS)
        return BreakdownOut(shots=[], characters=[], locations=[],
                            model_id=model_id or "")

    llm = LLMProvider(model_id=model_id)
    system = _BREAKDOWN_SYSTEM
    if max_chars and max_chars > 0:
        # 解说剧：镜头颗粒度由"这段文字读多久"决定，不是由 7-15 秒视频决定。
        # 规则 5 说的 7-15 秒在这里会误导模型，所以显式覆盖掉。
        system += (
            f"\n【本片为解说剧，覆盖上述第 5 条】每个镜头的 script_ref "
            f"**不得超过 {max_chars} 个字**（含标点）。这是旁白朗读时长的硬上限，"
            f"超了旁白就读不完，声音会盖到下一个镜头上。"
            f"超过就在最近的句末标点处断开成两个镜头，两镜的 script_ref 拼起来"
            f"必须仍等于原文，不许删改任何文字。duration_sec 按中文语速 5 字/秒估算，"
            f"不必落在 7-15 秒区间。"
        )

    all_shots: list[dict] = []
    characters: list[str] = []
    locations: list[str] = []
    for chunk in split_for_ai(script):
        # allow_truncated: 极端情况下仍截断时，交给 _parse_breakdown_json 抢救
        # 完整镜头（丢弃残缺尾部），比整块报废更好
        raw = await llm.complete(system, chunk, temperature=0.3,
                                 allow_truncated=True)
        data = _parse_breakdown_json(raw)
        for s in data.get("shots", []):
            s["order"] = len(all_shots) + 1  # 跨块连续编号
            all_shots.append(s)
        for c in data.get("characters", []):
            if c not in characters:
                characters.append(c)
        for l in data.get("locations", []):
            if l not in locations:
                locations.append(l)

    # 确定性兜底：纯环境描写/场景标题残留不得独立成镜（跨块统一处理，
    # 保证块边界处的环境描写也能并入下一块的首个剧情镜头）
    all_shots = _merge_fragment_shots(all_shots)
    # 合并兜底：把短镜并进相邻镜头（同时消灭"一个开门拆两镜"）。长镜模型在这里
    # 把节拍一路打包到 30s——总时长不变，镜头数变少，这才是 2.5 的正确用法。
    # 必须在跨块合并之后做，块边界处的碎镜才有机会与邻块首镜合并。
    all_shots = _merge_short_shots(all_shots, win)
    # 解说剧兜底：读不完的镜头按句界拆开。**必须在合并之后**——
    # 先拆后合会把刚拆开的两段又并回去。
    all_shots = _split_overlong_shots(all_shots, max_chars)
    # 真人剧兜底：台词念不完的镜头按内容单元拆开（同样必须在合并之后）。
    # 与上面互斥：max_chars 为真即解说剧，已由上一步处理。
    if not max_chars:
        all_shots = _split_overlong_drama_shots(all_shots, win)

    shots = [ShotDraft(**s) for s in all_shots]

    # 落库：传了 project_id 就持久化镜头与资产草稿（持锁防多集并发竞态）
    if project_id:
        # ⚠️ 不能写 `episode or 1`：前言的 episode 是 **0**，`or` 会把它静默
        # 变成 1，于是前言镜头和真正的第 1 集混在一起。上游 breakdown_by_episode
        # 已经过滤掉前言，但 /breakdown 路由也直接调本函数，这里必须自己站住。
        ep = episode if episode is not None else 1
        async with _BREAKDOWN_DB_LOCK:
            with get_session() as session:
                if episode is not None:
                    # 按集：只删该集旧镜头，order 接在其他集之后连续编号
                    session.query(Shot).filter(
                        Shot.project_id == project_id, Shot.episode == ep).delete()
                    max_order = (session.query(Shot)
                                 .filter(Shot.project_id == project_id)
                                 .order_by(Shot.order.desc()).first())
                    base_order = max_order.order if max_order else 0
                else:
                    # 整项目重拆（历史行为）
                    session.query(Shot).filter(Shot.project_id == project_id).delete()
                    session.query(Asset).filter(Asset.project_id == project_id).delete()
                    base_order = 0
                for i, s in enumerate(shots):
                    session.add(Shot(
                        id=uuid.uuid4().hex[:12], project_id=project_id,
                        order=base_order + i + 1, script_ref=s.script_ref,
                        link_to_prev=s.link_to_prev,
                        characters=json.dumps(s.characters, ensure_ascii=False),
                        location=s.location,
                        episode=ep, status="pending",
                        # 解说剧按朗读时长（TTS 出来后 _retime_shot 还会再覆盖一次）；
                        # 真人剧钳到 [7, win.ceil]（合并后可达 30s）。用同一个 [7,15] 套解说剧，
                        # 480p 的 45s 长镜会被砍成 15s、1080p 的 7.5s 上限会被顶穿。
                        duration_sec=(
                            _narration_duration(s.script_ref,
                                                max_chars / _CPS_SLOW)
                            if max_chars and max_chars > 0
                            else _clamp_duration(s.script_ref, s.duration_sec, win)),
                    ))
                # 资产增量合并（按集拆解时不清空其他集的角色/场景）
                from .scenes import canonical_of
                existing = {(a.kind, a.name) for a in
                            session.query(Asset).filter(Asset.project_id == project_id).all()}
                for c in characters:
                    if ("character", c) not in existing:
                        session.add(Asset(id=uuid.uuid4().hex[:12], project_id=project_id,
                                          kind="character", name=c))
                for l in locations:
                    # 场景资产一律按**归一名**建行。拆解给的是原名（带「夜 内」
                    # 这类前缀），照原样建会让同一个房间分裂成多行资产、各出一
                    # 张不同的图。此刻 AI 归一多半还没跑，但 canonical_of 会退回
                    # 确定性清洗——正好就是剥掉时间/内外前缀的那一步。
                    cn = canonical_of(session, project_id, l) or l
                    if ("location", cn) not in existing:
                        existing.add(("location", cn))
                        session.add(Asset(id=uuid.uuid4().hex[:12], project_id=project_id,
                                          kind="location", name=cn))
                if episode is None:
                    proj = session.get(Project, project_id)
                    if proj:
                        proj.optimized_script = script
                # 3.9 在场推导（L1.5）：拆解 LLM 即使被规则 8 提醒过也仍会漏人，
                # 这里做一次确定性兜底 —— 同场连续戏内把先出现过、且没有离场
                # 描写的角色向后传播。必须在 commit **之前**跑：它读的就是刚
                # 落库的这批镜头，且要与它们同一个事务提交。
                session.flush()
                try:
                    refresh_present_characters(session, project_id)
                except Exception:  # noqa: BLE001
                    # 推导失败不能把整次拆解带走：没有 L1.5 只是退回旧行为，
                    # 而拆解结果本身是用户等了几十秒换来的
                    logger.exception("在场推导失败（拆解结果照常保存）")
                session.commit()

    return BreakdownOut(
        shots=shots,
        characters=characters,
        locations=locations,
        model_id=llm.model_id,
    )


@router.post("/script/breakdown", response_model=BreakdownOut)
async def script_breakdown(body: ScriptBreakdownIn) -> BreakdownOut:
    # 单集重拆也要按项目选定的视频模型定时长窗口，否则同一个 2.5 项目里
    # 「整本拆」出来的是 25-30s 长镜、「单集重拆」出来的却是 8-12s 碎镜。
    cap: float | None = None
    if body.project_id:
        with get_session() as session:
            proj = session.get(Project, body.project_id)
            if proj:
                cap = breakdown_shot_cap(proj)
    try:
        return await do_breakdown(body.script, body.model_id, body.project_id,
                                  episode=body.episode, shot_cap_sec=cap)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"拆解失败: {e!r}")


@router.get("/projects/{project_id}/detail")
def project_detail(project_id: str) -> dict:
    """项目详情：剧本 + 分集 + 镜头(含状态/版本) + 资产，桌面端打开项目时一次拉全。"""
    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise HTTPException(status_code=404, detail="project not found")
        shots = session.query(Shot).filter(Shot.project_id == project_id).order_by(Shot.order).all()
        assets = session.query(Asset).filter(Asset.project_id == project_id).all()
        # 一次取全场景归一表：下面每镜要报 location_canonical，逐镜查库
        # 就是 N 次查询（1424 镜的项目见 B29）。
        from .scenes import canonical_map
        loc_canon = canonical_map(session, project_id, shots=shots)
        return {
            "id": proj.id, "title": proj.title,
            "base_aspect": proj.base_aspect,
            "production_mode": proj.production_mode,
            #: 画风：`art_style` 是用户选的（可能是尚未启用的档），
            #: `effective_style` 是**实际生成时用的**。两者不同 = 那档还没放开，
            #: 本项目正按都市档出图，前端要把这句话摊开告诉用户。
            "art_style": proj.art_style,
            "effective_style": _sp.resolve(proj.production_mode, proj.art_style).key,
            #: 单镜时长上限（秒）：时间轴拖拽/时长输入框据此钳制。
            #: 必须由服务端下发——前端自己维护一张"模型→上限"表必然与
            #: providers 漂移，seedance-2.5 的 30s 就会被前端按 15 砍掉。
            "shot_duration_max": shot_duration_ceiling(proj),
            "narration_voice_url": proj.narration_voice_url,
            "episodes": json.loads(proj.episodes) if proj.episodes else [],
            "raw_script": proj.raw_script, "optimized_script": proj.optimized_script,
            "shots": [
                {"id": s.id, "order": s.order, "episode": s.episode,
                 "script_ref": s.script_ref, "link_to_prev": s.link_to_prev,
                 "characters": json.loads(s.characters), "location": s.location,
                 #: 本镜场景的**归一名**（`scenes.canonical_of`）。
                 #: `location` 是拆解写下的原名，同一个房间各集写法不同
                 #: （「夜 内 楚家公馆-客厅」/「楚家公馆-客厅」）；而场景资产、
                 #: 场景轨、造型的 scene 绑定一律用归一名。前端拿原名去比资产名
                 #: 会全部落空（资产弹窗的"出场集数"就会显示为空），所以这里
                 #: 直接把归一名一起给出去——单一真源在后端，前端不要自己清洗。
                 "location_canonical": loc_canon.get((s.location or "").strip(), ""),
                 "video_url": s.video_url, "thumb_url": s.thumb_url,
                 "status": s.status,
                 #: 失败原因与分类：UI 据此区分「重试有用」（channel）与
                 #: 「重试必然再失败」（moderation，要改提示词/换模型）
                 "fail_reason": s.fail_reason, "fail_kind": s.fail_kind,
                 "adopted_version": s.adopted_version, "is_special": bool(s.is_special),
                 "gen_prompt": s.gen_prompt, "stale": bool(s.stale),
                 #: 过期原因，决定 UI 该引导用户做什么（重拆本集 / 重出提示词 /
                 #: 只需重出片）。NULL = 老数据，前端回落到最保守的兜底文案。
                 "stale_reason": s.stale_reason,
                 "stale_hint": stale_mod.label(s.stale_reason) if s.stale else None,
                 #: 提示词来源：draft 拆解初稿 / aligned 已按资产对齐 /
                 #: sent 出片实际下发稿 / manual 手填。老库为空视同 draft。
                 "prompt_state": s.prompt_state or ("draft" if s.gen_prompt else None),
                 "duration_sec": s.duration_sec,
                 "disabled": bool(s.disabled),
                 "special_name": s.special_name,
                 "ref_overrides": json.loads(s.ref_overrides) if s.ref_overrides else None,
                 "refs_stale": bool(s.refs_stale),
                 "first_frame_url": s.first_frame_url,
                 #: 2026-09-11 起不再下发 tail_frame_url / prev_tail_ref：
                 #: 尾帧接力已停用（见 docs/DECISION-2026-09-11-尾帧接力停用.md），
                 #: 存量 277 条历史尾帧不再有任何展示或注入用途，继续下发只会让
                 #: 界面显示一条实际不会被注入的"参考图"。
                 "profile_override": json.loads(s.profile_override) if s.profile_override else None,
                 # TB-01 取片窗口 / TB-03+TB-10 变换与变速
                 "clip_in_sec": s.clip_in_sec, "clip_dur_sec": s.clip_dur_sec,
                 "transform_meta": json.loads(s.transform_meta) if s.transform_meta else None,
                 #: 2.3 乐观锁的版本号：客户端写回时原样带上（base_transform_rev），
                 #: 服务端发现已被别处改过就回 409，而不是静默覆盖。
                 "transform_rev": transform_rev(s.transform_meta),
                 # Render V2 多轨：0=主轨，1+=Overlay 层
                 "track_index": s.track_index or 0,
                 "overlay_start_sec": s.overlay_start_sec}
                for _i, s in enumerate(shots)
            ],
            #: 资产。**带上墓碑**（`deleted_at` 非空 = 用户删掉的）而不是在后端
            #: 过滤掉：前端默认不显示它们，但需要一个「已删除 (n)」的入口来恢复。
            #: 生成链路那边是真的看不见它们（见 asset_gate 模块头列的四处闸门）。
            "assets": [
                {"id": a.id, "kind": a.kind, "name": a.name,
                 "image_url": a.image_url, "voice_url": a.voice_url,
                 "prompt": a.prompt, "deleted_at": a.deleted_at}
                for a in assets
            ],
        }


# ---------- 阶段③：资产生图 ----------
class AssetGenerateIn(BaseModel):
    prompt: str
    model_id: Optional[str] = None  # 缺省用 settings.image_model（gpt-image-2）
    size: str = "1024x1024"
    #: 出几张候选。上限 4：这是同步接口，再多前端要等到超时，且每张都花钱
    n: int = Field(1, ge=1, le=4)
    #: 显式参考图（图生图）。传了就用它，不再自动找
    ref_urls: Optional[list[str]] = None
    # ---- 自动参考：同角色跨造型保脸（不传 ref_urls 时生效）----
    #: 项目 id；与 character_name 一起传才会去找该角色已有的定妆图当参考
    project_id: Optional[str] = None
    character_name: Optional[str] = None
    #: 正在重生成的那一张（阶段 id / 当前图 URL），会被排除出参考候选——
    #: 拿它自己当参考等于原地复制，而点重新生成就是想换一版
    exclude_stage_id: Optional[str] = None
    exclude_url: Optional[str] = None
    #: 关掉自动参考（用户想彻底重画一张脸时）
    use_char_ref: bool = True


class AssetGenerateOut(BaseModel):
    urls: list[str]
    model_id: str
    #: 实际用作参考的已有定妆图（None = 纯文生图）。前端据此如实标注，
    #: 不能让用户以为"保脸了"而其实没有
    ref_used: Optional[str] = None


@router.post("/assets/generate", response_model=AssetGenerateOut)
async def assets_generate(body: AssetGenerateIn) -> AssetGenerateOut:
    from .providers.image import ContentRejected

    # 参考图：显式传的优先；否则按角色自动找已有定妆图（同一张脸）。
    # 与批量生图 run_asset_batch 共用 character_base_ref，两条路挑的基准一致。
    refs = list(body.ref_urls or [])
    if not refs and body.use_char_ref and body.project_id and body.character_name:
        from .asset_ref import character_base_ref
        with get_session() as session:
            base = character_base_ref(
                session, body.project_id, body.character_name,
                exclude_stage_ids={body.exclude_stage_id} if body.exclude_stage_id else None,
                exclude_url=body.exclude_url)
        if base:
            refs = [base]

    provider = ImageProvider(model_id=body.model_id)
    try:
        urls = await provider.generate(body.prompt, size=body.size, n=body.n,
                                       ref_urls=refs or None)
    except ContentRejected as e:
        # 与首帧同口径：审核拒绝要能被前端识别，给"换模型/改提示词"而非"重试"
        cats = "、".join(e.categories) if e.categories else ""
        raise HTTPException(status_code=422, detail={
            "reason": "moderation",
            "categories": e.categories,
            "message": (f"提示词被内容审核判定违规{('（' + cats + '）') if cats else ''}。"
                        "重试无效——同一提示词判定一致。请弱化提示词中的敏感描写，"
                        "或换用其他生图模型（各厂商审核尺度不同）。"),
        }) from e
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail={
            "reason": "channel", "message": f"生图失败: {str(e)[:300]}"}) from e
    return AssetGenerateOut(urls=urls, model_id=provider.model_id,
                            ref_used=refs[0] if refs else None)


@router.get("/assets/candidates")
def latest_asset_candidates(project_id: str, kind: str, name: str,
                            stage_id: Optional[str] = None) -> dict:
    """该资产最近一次候选图生成 job 的快照（没有则 job_id=null）。

    弹窗打开时拉一次：在跑 → 显示"生成中"并轮询；已完成 → 直接把上次那几张
    候选摆出来接着挑。候选图**不落资产表**（只有点选那张才落），所以这里是
    关窗之后唯一能把它们找回来的入口——否则图已落盘、钱已花掉，UI 却看不见。

    按 rowid 倒序取最新（Job 表没有时间列；SQLite rowid 即插入顺序）。
    """
    from sqlalchemy import text as _sql_text

    from .db import Job
    with get_session() as session:
        rows = (session.query(Job)
                .filter(Job.kind == "asset_candidates")
                .order_by(_sql_text("rowid DESC")).limit(200).all())
        for j in rows:
            try:
                p = json.loads(j.payload or "{}")
            except json.JSONDecodeError:
                continue
            if (p.get("project_id") != project_id or p.get("kind") != kind
                    or p.get("name") != name or (p.get("stage_id") or None) != (stage_id or None)):
                continue
            res = json.loads(j.result) if j.result else {}
            err = j.error
            if err:
                try:
                    err = json.loads(err).get("message") or err
                except json.JSONDecodeError:
                    pass
            return {"job_id": j.id, "status": j.status, "progress": j.progress,
                    "urls": res.get("urls") or [], "ref_used": res.get("ref_used"),
                    "prompt": res.get("prompt"), "error": err}
    return {"job_id": None, "status": None, "urls": []}


# ---------- 资产 CRUD（自定义资产 + 拖拽重分类/换图）----------
_ASSET_KINDS = ("character", "location", "custom")


class AssetCreateIn(BaseModel):
    project_id: str
    kind: str = "custom"          # character | location | custom
    name: str
    image_url: Optional[str] = None
    prompt: Optional[str] = None


@router.post("/assets")
async def create_asset(body: AssetCreateIn) -> dict:
    """新建资产（资产页「自定义」分组：上传图 / AI 生图后落库）。"""
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="资产名不能为空")
    if body.kind not in _ASSET_KINDS:
        raise HTTPException(status_code=400, detail=f"kind 只能是 {'/'.join(_ASSET_KINDS)}")

    # 上传图无描述 → **保持为空**，不再同步反推（那是 ~8s 的多模态调用，
    # 会把"新建一个自定义资产"拖成十几秒）。描述为空是安全的：出片时走
    # jobs.py 的 blind 兜底，提示词禁止书写该图的服装/陈设，外观由图钳制。
    # 想要文字描述的用户在资产弹窗里点「AI 看图补写」即可。
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        dup = (session.query(Asset)
               .filter(Asset.project_id == body.project_id,
                       Asset.kind == body.kind, Asset.name == name).first())
        if dup and dup.deleted_at:
            # 撞上墓碑行：用户手工新建同名资产 = 显式说"我又要它了"，
            # 按恢复处理并写入本次的图/描述。报 409 是最差的选择——
            # 那一行在资产页上不可见，用户会以为是幽灵冲突。
            dup.deleted_at = None
            if body.image_url:
                dup.image_url = body.image_url
            if body.prompt:
                dup.prompt = body.prompt
            session.commit()
            return {"id": dup.id, "kind": dup.kind, "name": dup.name,
                    "image_url": dup.image_url, "restored": True}
        if dup:
            raise HTTPException(status_code=409, detail=f"已有同名{body.kind}资产「{name}」")
        aid = uuid.uuid4().hex[:12]
        session.add(Asset(id=aid, project_id=body.project_id, kind=body.kind,
                          name=name, image_url=body.image_url,
                          prompt=body.prompt or None))
        session.commit()
        return {"id": aid, "kind": body.kind, "name": name,
                "image_url": body.image_url}


class AssetPatchIn(BaseModel):
    #: 改 kind = 拖拽重分类（custom 拖上人物轨→character / 场景轨→location）
    kind: Optional[str] = None
    name: Optional[str] = None
    image_url: Optional[str] = None
    #: 角色参考音色（上传音频/视频 URL；空串=清除）
    voice_url: Optional[str] = None
    #: 造型/场景文字描述。出片时会作为参考图的文字锚点喂给提示词优化器，
    #: 用户在资产弹窗里改了必须存得下来（空串=清除）。
    prompt: Optional[str] = None
    #: 连同换图一起把旧描述清空（用户上传了自己的图时传 true）。见 _CLEAR_DESC_WHY。
    clear_prompt: Optional[bool] = None


@router.patch("/assets/{asset_id}")
async def patch_asset(asset_id: str, body: AssetPatchIn) -> dict:
    # 换图不再同步反推描述（见 patch_stage 顶部注释）：反推改为手动按钮。
    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="asset not found")
        if body.kind is not None:
            if body.kind not in _ASSET_KINDS:
                raise HTTPException(status_code=400,
                                    detail=f"kind 只能是 {'/'.join(_ASSET_KINDS)}")
            a.kind = body.kind
        # 改名走**连带迁移**（R1）。Asset.name 是连接键（全库 12 处
        # `Asset.name == ...`），只改这一行会让引用它的镜头静默失联：
        # 把「陆明」改成「陆医生」→ 208 个镜头的 characters 仍是「陆明」
        # → 定妆图全部注入不到，且没有任何报错。
        # 所以在同一事务里把 Shot/AssetStage/别名表的引用一起改掉。
        renamed: dict[str, int] = {}
        if body.name is not None and body.name.strip():
            new_name = body.name.strip()
            if new_name != a.name:
                from .asset_rename import rename_asset_everywhere
                renamed = rename_asset_everywhere(
                    session, a.project_id, a.kind, a.name, new_name)
                session.expire(a)      # 上面用的是 bulk update，实例缓存已过期
        if body.image_url is not None:
            a.image_url = body.image_url
        if body.voice_url is not None:
            a.voice_url = body.voice_url or None   # 空串=清除
        if body.prompt is not None:
            a.prompt = body.prompt or None
        elif body.clear_prompt:
            a.prompt = None       # 用户换成了自己的图（见 _CLEAR_DESC_WHY）
        session.commit()
        out = {"id": a.id, "kind": a.kind, "name": a.name,
               "image_url": a.image_url, "voice_url": a.voice_url,
               "prompt": a.prompt}
        if renamed:
            # 改名连带改了哪些表、各几行——让用户当场看到影响面
            # （"这次改名动了 208 个镜头 + 43 个造型阶段"），而不是改完毫无反馈
            out["renamed"] = renamed
        return out


@router.delete("/assets/{asset_id}")
def delete_asset(asset_id: str) -> dict:
    """删除资产（用户 2026-09-09 需求 4）。**写墓碑，不真删行。**

    用户的原话是「删掉的资产不该再在后面的生成过程中可见、被调用」。
    此前这里是 `session.delete(a)`，达不到这个要求——有**三处**自动流程会
    按名字把它原地建回来（拆解后的资产增量合并 / `ensure_location_asset` /
    资产 upsert），还有第四处更隐蔽：`readiness.locations_no_image` 是从
    `Shot.location` 算的、根本不看资产表，所以真删之后依然报"缺图"，
    用户点一次"补齐"就又花钱把它画回来了。

    墓碑（`Asset.deleted_at`）让这四处都能认出"这是用户故意删的"从而跳过。

    语义边界（用户决策「只断资产链，不动剧本」）：
      · 断掉：不再注入参考图、不计入缺图缺口、不被自动流程重建、资产页不显示
      · 不动：镜头里该角色/场景照旧存在，剧本一个字不改
      · 保留：已生成的图与磁盘文件全在，`POST /assets/{id}/restore` 可恢复
    """
    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="asset not found")
        if a.deleted_at:
            # 幂等：重复删不报错（前端重试/双击都可能打两次）
            return {"ok": True, "already_deleted": True, "name": a.name,
                    "kind": a.kind, "deleted_at": a.deleted_at}
        a.deleted_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        name, kind, pid = a.name, a.kind, a.project_id
        deleted_at = a.deleted_at
        session.commit()
        # 影响面：让用户当场看到"这个场景还挂在 37 个镜头上，那些镜头不会被删，
        # 只是不再有它的参考图了"——比删完毫无反馈强得多。
        if kind == "location":
            from .scenes import canonical_map
            shots = session.query(Shot).filter(Shot.project_id == pid).all()
            cmap = canonical_map(session, pid, shots=shots)
            affected = sum(
                1 for s in shots
                if (cmap.get((s.location or "").strip(), "")
                    or (s.location or "").strip()) == name)
        else:
            affected = sum(
                1 for (chars,) in session.query(Shot.characters)
                .filter(Shot.project_id == pid).all()
                if name in (json.loads(chars or "[]") or []))
    return {"ok": True, "name": name, "kind": kind, "deleted_at": deleted_at,
            #: 仍然挂着这个角色/场景的镜头数（**不会**被改动，只是不再注入它）
            "affected_shots": affected}


@router.post("/assets/{asset_id}/restore")
def restore_asset(asset_id: str) -> dict:
    """撤销删除：清掉墓碑，资产及其图原样回来。

    删除是软的，所以恢复是完整的——图、档案、场景多视角行全都还在，
    不需要重新生成任何东西。
    """
    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="asset not found")
        a.deleted_at = None
        session.commit()
        return {"ok": True, "name": a.name, "kind": a.kind}


# ---------------------------------------------------------------- 形象档案

@router.get("/assets/{asset_id}/profile")
def get_asset_profile(asset_id: str) -> dict:
    """角色形象档案 + 词表（前端据此渲染下拉）。

    词表随档案一起返回，前端不硬编码——词表是后端的事实来源
    （`character_profile.AXES`），两处各写一份必然漂移。
    """
    from . import character_profile as cp

    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="asset not found")
        if a.kind != "character":
            raise HTTPException(status_code=400, detail="只有角色资产有形象档案")
        prof = cp.decode(a.profile_json)
        name = a.name

    # 老档案可能存着 period/generic；一律夹到已上线的风格预设，
    # 免得下发给前端的下拉里出现关掉的古装词。
    genre = cp.active_genre((prof or {}).get("genre"))
    return {
        "name": name,
        "profile": prof,          # None = 还没生成过
        "genre": genre,
        "axes": [{"key": ax.key, "label": ax.label,
                  "values": ax.values or [], "optional": ax.optional}
                 for ax in cp.axes_for_genre(genre)],
        "extra_max": cp.EXTRA_MAX_LEN,
    }


class AssetProfileIn(BaseModel):
    #: {轴 key: 取值}。词表外的自定义值也接受（见 character_profile 模块开头）
    axes: dict[str, str] = {}
    #: 词表覆盖不到的独有特征（疤痕/义眼/胎记）
    extra: str = ""
    genre: Optional[str] = None


@router.put("/assets/{asset_id}/profile")
def put_asset_profile(asset_id: str, body: AssetProfileIn) -> dict:
    """手改形象档案。

    ⚠️ 改档案 = 改这个角色的脸。**已生成的定妆图不会自动重画**——
    要让新档案生效，得删掉该角色的定妆图再补齐资产（前端会给这句提示）。
    手改的档案标 `confirmed`，此后自动流程不再覆盖。
    """
    from . import character_profile as cp

    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="asset not found")
        if a.kind != "character":
            raise HTTPException(status_code=400, detail="只有角色资产有形象档案")
        project_id, name = a.project_id, a.name

    ok = cp.save_profile(project_id, name, {
        "axes": body.axes, "extra": body.extra,
        "genre": cp.active_genre(body.genre)})
    if not ok:
        raise HTTPException(status_code=404, detail="asset not found")
    return {"ok": True, "profile": cp.load_profiles(project_id).get(name)}


@router.post("/assets/{asset_id}/profile/regenerate")
async def regenerate_asset_profile(asset_id: str) -> dict:
    """按剧本重新识别该角色的形象档案（清空旧档案后重跑）。

    重新识别几乎必然给出不同的五官——档案是审美判断，不是事实提取。
    所以这**只能**由用户显式触发，自动流程永不重生成（见 `ensure_profiles`）。
    """
    from . import character_profile as cp

    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="asset not found")
        if a.kind != "character":
            raise HTTPException(status_code=400, detail="只有角色资产有形象档案")
        project_id, name = a.project_id, a.name
        a.profile_json = None      # 清空才会被 ensure_profiles 当作"缺档案"
        session.commit()

    got = await cp.ensure_profiles(project_id, [name])
    prof = got.get(name)
    if not prof:
        raise HTTPException(status_code=502, detail="形象档案识别失败，请重试")
    return {"ok": True, "profile": prof}


class AssetImageUpsertIn(BaseModel):
    project_id: str
    kind: str
    name: str
    image_url: Optional[str] = None
    #: 角色参考音色（上传音频/视频 URL；与 image_url 至少传一个）
    voice_url: Optional[str] = None
    #: 用户手写的造型/场景描述（资产弹窗里改提示词时传）。空串 = 清空。
    prompt: Optional[str] = None
    #: 连同换图一起把旧描述清空（用户上传了自己的图时传 true）。见 _CLEAR_DESC_WHY。
    clear_prompt: Optional[bool] = None


@router.post("/assets/upsert-image")
async def upsert_asset_image(body: AssetImageUpsertIn) -> dict:
    """按 (kind, name) 换图/换音色（拖资产卡到场景轨段=替换参考图；
    资产详情弹窗上传音色）。无 Asset 行则建（upsert 兜底）。
    """
    if body.kind not in _ASSET_KINDS:
        raise HTTPException(status_code=400, detail=f"kind 只能是 {'/'.join(_ASSET_KINDS)}")
    if body.image_url is None and body.voice_url is None and body.prompt is None:
        raise HTTPException(status_code=422, detail="image_url/voice_url/prompt 至少传一个")

    # 换图不再同步反推描述（见 patch_stage 顶部注释）：反推改为手动按钮。
    with get_session() as session:
        if not session.get(Project, body.project_id):
            raise HTTPException(status_code=404, detail="project not found")
        a = (session.query(Asset)
             .filter(Asset.project_id == body.project_id,
                     Asset.kind == body.kind, Asset.name == body.name).first())
        if a is None:
            a = Asset(id=uuid.uuid4().hex[:12], project_id=body.project_id,
                      kind=body.kind, name=body.name)
            session.add(a)
        elif a.deleted_at:
            # 本路由只有前端用户操作会调（拖资产卡换图 / 上传音色），
            # 往墓碑行上静默写图 = 用户看不到任何变化。按恢复处理。
            a.deleted_at = None
        if body.image_url is not None:
            a.image_url = body.image_url
        if body.voice_url is not None:
            a.voice_url = body.voice_url or None
        if body.prompt is not None:
            a.prompt = body.prompt or None
        elif body.clear_prompt:
            a.prompt = None       # 用户换成了自己的图（见 _CLEAR_DESC_WHY）
        session.commit()
        return {"id": a.id, "kind": a.kind, "name": a.name,
                "image_url": a.image_url, "voice_url": a.voice_url,
                "prompt": a.prompt}


class DescribeImageIn(BaseModel):
    image_url: str
    #: character | location（决定用造型记录员还是置景记录员的题面）
    kind: str = "character"


@router.post("/assets/describe-image")
async def describe_image(body: DescribeImageIn) -> dict:
    """看图写一段造型/场景描述（资产弹窗「🔍 AI 看图补写」按钮）。

    **不落库**：结果回给前端填进输入框，由用户过目/修改后失焦才存。
    这是 2026-09-10 起视觉反推的唯一入口——它以前挂在换图链路上自动跑，
    把上传拖成几十秒且期间整页锁死，见 `patch_stage` 顶部注释。

    正因为经用户过目，写回去的就是用户的字，**不再加** `AUTO_PREFIX`。
    该前缀只保留读路径（`strip_auto`）以兼容历史数据。
    """
    from . import vision_desc

    url = (body.image_url or "").strip()
    if not url:
        raise HTTPException(status_code=422, detail="image_url 不能为空")
    kind = "location" if body.kind == "location" else "character"
    text = await vision_desc.derive(url, kind=kind)
    if not text:
        # derive 内部把所有异常都吞成 None（反推是锦上添花，不该让用户传不上图）。
        # 但**手动点按钮**是显式请求，静默返回空等于按钮坏了，这里必须报出来。
        raise HTTPException(status_code=502, detail="看图失败，请稍后重试或自己写一句")
    return {"description": vision_desc.strip_auto(text)}


# ---------- 阶段④：镜头视频生成（同步单镜；批量走 /jobs kind=shot_videos）----------
class ShotGenerateIn(BaseModel):
    prompt: str
    model_id: Optional[str] = None       # 缺省用 settings.video_model（veo-3-1-fast）
    #: 生成模式 t2va/i2va/fl2va/l2va/full_reference；None=按素材自动推断
    generation_mode: Optional[str] = None
    first_frame_url: Optional[str] = None   # i2va / fl2va
    last_frame_url: Optional[str] = None    # fl2va / l2va
    project_id: Optional[str] = None     # 与 order 一起传则把结果写回该镜头
    order: Optional[int] = None
    # ---- 参考路线参数（minimax-h3-ref2v 等 reference 模型使用；veo 通道忽略）----
    reference_image_urls: list[str] = []
    reference_audio_url: Optional[str] = None
    reference_video_url: Optional[str] = None
    duration_ms: Optional[int] = None
    aspect_ratio: Optional[str] = None
    megapixels: Optional[float] = None   # 缺省按时长自动选安全值（防显存 OOM）
    seed: Optional[int] = None           # 缺省随机化（不传则每次结果不同）


class ShotGenerateOut(BaseModel):
    video_url: str
    model_id: str
    #: 实际生效参数（seed/分辨率/帧数等），便于复现与排查
    meta: Optional[dict] = None


@router.post("/shots/generate", response_model=ShotGenerateOut)
async def shots_generate(body: ShotGenerateIn) -> ShotGenerateOut:
    """单镜生成（同步等待出片）。

    veo fast 约 1-3 分钟；minimax-h3-ref2v 走 RunningHub 异步工作流，
    1MP/8s 实测约 10 分钟，批量请用 jobs 通道。
    """
    from .config import get_settings
    from .providers.base import VideoRequest

    model_id = body.model_id or get_settings().video_model
    provider = registry.get_video(model_id)
    if provider is None:
        raise HTTPException(status_code=400, detail=f"未注册的视频模型: {model_id}")
    try:
        res = await provider.submit(VideoRequest(
            prompt=body.prompt,
            generation_mode=body.generation_mode,
            first_frame_url=body.first_frame_url,
            last_frame_url=body.last_frame_url,
            reference_image_urls=body.reference_image_urls,
            reference_audio_url=body.reference_audio_url,
            reference_video_url=body.reference_video_url,
            duration_ms=body.duration_ms,
            aspect_ratio=body.aspect_ratio,
            megapixels=body.megapixels,
            seed=body.seed,
        ))
    except RuntimeError as e:
        # Provider 用 RuntimeError 表达入参不合法（时长/精细度/参考素材数量、
        # 以及 #158 关闭后误传 reference_video_url）——归为 400 而非 500。
        raise HTTPException(status_code=400, detail=str(e))
    if res.status != "done" or not res.video_url:
        raise HTTPException(status_code=502, detail=f"视频生成失败: {res.error}")

    # 可选写回镜头
    if body.project_id and body.order is not None:
        with get_session() as session:
            shot = (session.query(Shot)
                    .filter(Shot.project_id == body.project_id, Shot.order == body.order)
                    .first())
            if shot:
                shot.video_url = res.video_url
                # 3.1：同 jobs.py —— 换素材必须清取片窗口，见 db.py
                reset_clip_window(shot)
                session.commit()
    return ShotGenerateOut(video_url=res.video_url, model_id=model_id, meta=res.raw)


# ---------- 异步任务（长任务：批量生图，后续视频生成同走此通道）----------
from fastapi import BackgroundTasks  # noqa: E402

from .jobs import RUNNERS, create_job, find_active_job, get_job, get_job_phase  # noqa: E402


class JobSubmitIn(BaseModel):
    kind: str  # asset_batch
    payload: dict


class JobOut(BaseModel):
    id: str
    kind: str
    status: str
    progress: int
    result: Optional[str] = None
    error: Optional[str] = None
    #: 本次提交命中了去重、返回的是已在跑的那个 job（前端据此提示"已在生成中"
    #: 而不是当成新任务再弹一次"已提交"）
    deduped: bool = False
    #: 当前阶段（进程内态，见 jobs._JOB_PHASE）。i2va 批量出片会先把整批首帧
    #: 生完才提交视频，没有这个字段前几分钟只有"已出片 0/170"，看着像卡死。
    phase: Optional[dict] = None


#: 提交去重的临界区锁（见 submit_job 里的说明）。
#: Python 3.10+ 的 asyncio.Lock 不在构造时绑定事件循环（首次 await 才取
#: running loop），所以放在模块级是安全的，不需要像 _video_pool 那样懒初始化。
_SUBMIT_LOCK = asyncio.Lock()


@router.post("/jobs", response_model=JobOut)
async def submit_job(body: JobSubmitIn, background: BackgroundTasks) -> JobOut:
    runner = RUNNERS.get(body.kind)
    if not runner:
        raise HTTPException(status_code=400, detail=f"未知任务类型: {body.kind}")

    # 提交去重：同项目同类型批量任务已在跑就直接返回它，不再开第二批。
    # 这类 job 缺省覆盖全项目镜头，重复提交 = 同一批镜头生成两遍，纯烧钱
    # （实测一次双击让 113/170 个镜头各生成了两份视频）。
    # TB-04：定向提交（payload 带明确 shot_ids）不受此约束——用户点名了要哪几镜，
    # 即使批量任务在跑也应当立即重试，否则「重试这一镜」点了没反应。
    #
    # ⚠️ 「查重 → 建 job」这两步必须**原子**（B34）。它们之间只要出现一次 await，
    # 事件循环就会切走，两个并发提交都能查到"没有在跑的"，各建一条 job ——
    # 后果正是上面那条实测：同一批镜头被生成两遍。
    # 现状（2026-08 实测）：两步之间无 await、服务单 worker，20 次并发提交只落
    # 1 条 job，窗口尚不存在。但这是**易碎的隐性前提**：谁在这中间加一行 await
    # （比如加个鉴权/配额查询），或哪天上 `--workers 2`，去重立刻失效且无人察觉。
    # 因此在此显式加锁把不变式钉住：
    #   · 进程内锁挡住"未来有人加 await"以及同进程并发；
    #   · 多 worker 场景本锁无效 —— 那需要 DB 唯一约束（如
    #     (kind, project_id, status) 部分唯一索引）或 Redis 锁。届时若真要多
    #     worker，必须先补 DB 层约束，不能只依赖这把锁。
    async with _SUBMIT_LOCK:
        dup = find_active_job(body.kind, (body.payload or {}).get("project_id"),
                              body.payload)
        if dup:
            job = get_job(dup)
            if job:
                return JobOut(id=job.id, kind=job.kind, status=job.status,
                              progress=job.progress, deduped=True,
                              phase=get_job_phase(job.id))

        jid = create_job(body.kind, body.payload)
    background.add_task(_run_job_guarded, runner, jid, body.kind)
    return JobOut(id=jid, kind=body.kind, status="pending", progress=0)


async def _run_job_guarded(runner, jid: str, kind: str) -> None:
    """跑 runner，并**保证**任务最终落到终态。

    为什么必须有这层：runner 里的 `asyncio.gather(...)` 没有 try/except
    （jobs.py:1094），任一镜头抛异常就会跳过后面的 `_update(status=...)`，
    Job 行永远停在 running。后果不只是进度条空转 ——
    `find_active_job` 会把它当成"正在跑的批量任务"，之后该项目**再也提交不了**
    同类任务，只能重启后端（recover_zombie_tasks 仅在 lifespan 启动时跑一次）。

    放在派发层而不是逐个 runner 里加：一处修复覆盖全部 RUNNERS，
    也不会漏掉将来新增的 runner。
    """
    from .jobs import _update  # 局部导入避免循环依赖
    try:
        await runner(jid)
    except asyncio.CancelledError:
        # 进程关闭等正常取消：标记出来，不要留个假的 running
        try:
            _update(jid, status="failed", error="任务被中断（服务重启或取消）")
        except Exception:  # noqa: BLE001
            pass
        raise
    except Exception as e:  # noqa: BLE001
        logger.exception("[job %s] kind=%s 未捕获异常，置为 failed", jid, kind)
        try:
            _update(jid, status="failed",
                    error=f"任务异常终止: {type(e).__name__}: {e}"[:2000])
        except Exception:  # noqa: BLE001
            logger.exception("[job %s] 连 failed 都没写进去", jid)


@router.get("/jobs/{job_id}", response_model=JobOut)
def job_status(job_id: str) -> JobOut:
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")
    return JobOut(
        id=job.id, kind=job.kind, status=job.status,
        progress=job.progress, result=job.result, error=job.error,
        phase=get_job_phase(job.id),
    )


@router.get("/projects/{project_id}/jobs")
def list_project_jobs(project_id: str, active: bool = True,
                      limit: int = 60) -> dict:
    """按项目列出 job。

    active=true（默认）只回 pending/running——打开项目时接回进行中任务，
    不依赖 localStorage（换设备/清缓存后进度不失联）。
    active=false 回全部历史，供「AI 任务」面板做失败回溯与重试。

    按项目筛走 `Job.project_id` 索引列（B30）。原来是全表 `.all()` 载入后
    逐行 `json.loads(payload)` 过滤 —— jobs 表只增不删，实测 173 行就已经要
    把 547 KiB 的 payload+result 全部读进内存（其中 result 这个接口压根不用，
    最大单条 34 KiB），行数只会一直涨。
    兼容老数据：迁移已回填 project_id；万一回填漏了（payload 损坏等），
    下面仍按 payload 复核一次，不会把 job 漏掉。
    """
    from .db import Job
    with get_session() as session:
        q = (session.query(Job)
             .filter(Job.project_id == project_id)
             .order_by(Job.created_at.desc()))
        if active:
            q = q.filter(Job.status.in_(("pending", "running")))
        # 多取一些再在应用层排序切片：created_at 为空的老行在 SQL 里排序不稳
        rows = q.limit(max(1, limit) * 3).all()
        out = []
        for j in rows:
            try:
                pl = json.loads(j.payload or "{}")
            except json.JSONDecodeError:
                pl = {}
            if not isinstance(pl, dict):
                pl = {}
            shot_ids = pl.get("shot_ids") or []
            out.append({
                "id": j.id, "kind": j.kind, "status": j.status,
                "progress": j.progress,
                # 错误串可能很长（含上游 traceback），面板只展示摘要
                "error": (j.error or "")[:300] or None,
                "created_at": j.created_at, "updated_at": j.updated_at,
                # 定向任务带上镜头，面板可"定位到该镜"
                "shot_ids": shot_ids if isinstance(shot_ids, list) else [],
                "phase": get_job_phase(j.id),
            })
        # 新任务在前；created_at 为空的老数据排最后（ISO 串可直接字典序比较）
        out.sort(key=lambda r: r["created_at"] or "", reverse=True)
        return {"jobs": out[:max(1, limit)]}


@router.post("/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict:
    """请求取消一个任务。

    ⚠️ 语义是"标记为已取消"，不是强杀协程——runner 跑在 asyncio 后台任务里，
    没有可靠的中断点。已经发出去的上游生成请求该扣的费仍会扣。
    标记后 runner 的下一个检查点会自行退出（见 jobs.py::is_cancelled）。
    """
    from .db import Job
    with get_session() as session:
        job = session.get(Job, job_id)
        if not job:
            raise HTTPException(status_code=404, detail="job not found")
        if job.status in ("done", "failed", "cancelled"):
            return {"ok": True, "status": job.status, "changed": False}
        job.status = "cancelled"
        job.error = "用户取消"
        job.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        session.commit()
    return {"ok": True, "status": "cancelled", "changed": True}


# ---------- P2-5 SSE 事件推送（修 G3 实时性 / F2 密集轮询）----------
from fastapi.responses import StreamingResponse  # noqa: E402

from .events import poll as events_poll, tail_seq  # noqa: E402


@router.get("/projects/{project_id}/events")
async def project_events(project_id: str) -> StreamingResponse:
    """SSE：本项目 job/shot/audio 状态变更实时推送。

    前端用 fetch 流式读取（EventSource 带不了 Authorization 头，登录体系下
    会 401；fetch 方案桌面端 WebView 与浏览器通道都通）。连接即从"当前"起
    只推增量——历史状态由 /detail、/jobs 快照接口承载，职责分离。
    心跳 15s 探测断连 + 防代理超时；X-Accel-Buffering 逐响应关 nginx 缓冲
    （站点 /fw/ 段未配 proxy_buffering off，不加此头事件会被攒批延迟）。
    """
    async def gen():
        cursor = tail_seq()
        yield "retry: 3000\n\n"
        idle = 0.0
        while True:
            cursor, items, dropped = events_poll(project_id, cursor)
            if dropped:
                # 缓冲溢出，这中间有本项目事件被挤掉了（B20）。
                # 不能装作没发生：少了哪几条状态变更无从知晓，前端会显示
                # 陈旧状态直到兜底轮询慢慢对上。明确要求前端全量重同步。
                idle = 0.0
                yield "event: resync\ndata: {\"reason\":\"event_buffer_overflow\"}\n\n"
            if items:
                idle = 0.0
                for _seq, ev, data in items:
                    yield f"event: {ev}\ndata: {data}\n\n"
            elif not dropped:
                idle += 0.5
                if idle >= 15:
                    idle = 0.0
                    yield ": ping\n\n"
            await asyncio.sleep(0.5)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ---------- 场景多视角参考图 / 设定板 / 影调档案 / 资产视觉体检（2026-09-09）----------
#
# 这四组接口服务用户 2026-09-09 的四条反馈（见
# docs/PLAN-场景多视角与影调统一.md）：场景资产出全套 8 张多视角参考图并在左上角
# 标场景名、把 8 张拼成美术设定板、全片影调统一、"人物图无场景 / 场景图无人"可核验。
#
# ⚠️ 放在文件末尾是**必需**的：这里要用到上面才定义的 `JobOut` / `BackgroundTasks`
# 与 `_run_job_guarded`。本文件用了 `from __future__ import annotations`，
# 但 FastAPI 在**装饰器执行时**就要解析返回注解，前置会 NameError。

from . import scene_view as _sv                        # noqa: E402
from . import look_profile as _lp                      # noqa: E402
from .db import SceneView                              # noqa: E402


def _scene_asset(session, asset_id: str) -> Asset:
    """取一个**场景**资产行，不是场景就 400。"""
    a = session.get(Asset, asset_id)
    if not a:
        raise HTTPException(status_code=404, detail="asset not found")
    if a.kind != "location":
        raise HTTPException(status_code=400, detail="只有场景资产有多视角参考图")
    return a


def _view_row_payload(r: SceneView) -> dict:
    qc = None
    if (r.qc_json or "").strip():
        try:
            qc = json.loads(r.qc_json)
        except json.JSONDecodeError:
            qc = None       # 脏数据当没体检过，不让它把弹窗打崩
    v = _sv.BY_KEY.get(r.view_key)
    return {"id": r.id, "key": r.view_key, "kind": r.kind,
            "label": r.label, "sort": r.sort,
            "primary": bool(v.primary) if v else False,
            "image_url": r.image_url, "prompt": r.prompt, "qc": qc}


@router.get("/assets/{asset_id}/scene-views")
def get_scene_views(asset_id: str) -> dict:
    """一个场景资产的 8 张多视角参考图现状（资产弹窗打开时拉一次）。

    这里会**顺带补齐** 8 行 `SceneView`（`ensure_views` 幂等），并认领老项目
    已有的那张 `Asset.image_url` 当主视角——不认领的话前端会显示"主视角缺图"，
    用户点补齐就白花一次钱画同一个房间的同一个角度。

    视图定义（标签/顺序）随 `views` 一起下发，前端不硬编码任何标签。
    """
    with get_session() as session:
        a = _scene_asset(session, asset_id)
        rows = _sv.ensure_views(session, a)
        changed = _sv.sync_primary_to_asset(session, a)
        session.commit()
        payload = [_view_row_payload(r) for r in rows]
        return {"asset_id": a.id, "name": a.name, "project_id": a.project_id,
                "description": a.prompt, "board_url": a.board_url,
                "progress": _sv.progress(session, a.id),
                "defs": _sv.views_payload(),
                "views": payload,
                # 主视角刚被认领/更新过 → 前端顺带刷一下资产缩略图
                "primary_synced": changed}


class SceneViewsGenerateIn(BaseModel):
    #: 指定视角 = 无论有没有图都重画这几张；空 = 只补缺图的（省钱的默认）
    view_keys: list[str] = []
    #: 缺省用**项目自己的** image_model（不是全局默认——那正是色调不统一的成因之二）
    model_id: Optional[str] = None
    size: str = "1024x1024"


@router.post("/assets/{asset_id}/scene-views/generate")
async def generate_scene_views(asset_id: str, body: SceneViewsGenerateIn,
                               background: BackgroundTasks) -> JobOut:
    """生成/补齐该场景的多视角参考图（走 asset_batch job，前端按 job 轮询进度）。

    提示词一律由 `jobs.scene_view_items_for_asset` 拼——**本路由不自己拼提示词**，
    否则弹窗手动补的图和一键成片自动补的图会是两套口径（`asset_prompt` 模块头
    记过这个教训）。

    影调档案在这里 `ensure`（没有就按剧本生一份）：8 张图必须共用同一套调色基调，
    否则一个场景内部就先花了。失败不阻断——退回无影调提示词。
    """
    from .jobs import _resolve_project_gen_settings, scene_view_items_for_asset

    with get_session() as session:
        a = _scene_asset(session, asset_id)
        proj = session.get(Project, a.project_id)
        project_id, title = a.project_id, (proj.title if proj else "")
        image_model = body.model_id or _resolve_project_gen_settings(proj)[1]

    try:
        look = await _lp.ensure(project_id)
    except Exception as e:  # noqa: BLE001 影调是增强项，绝不阻断出图
        logger.warning("[look] 场景视角生成时取影调失败，按无影调继续: %r", e)
        look = None

    bad = [k for k in body.view_keys if k not in _sv.BY_KEY]
    if bad:
        raise HTTPException(status_code=400, detail=f"未知视角: {'、'.join(bad)}")

    # 与批量补资产的去重（同 submit_job 的理由：同一批图生成两遍就是纯烧钱）。
    # 分两种情况，判据与 `find_active_job` 的 TB-04 一致：
    #   · 没点名视角（= 补齐缺失）→ 与在跑的 asset_batch **完全重叠**，挡住；
    #   · 点名了视角（= 用户要重画这一张）→ 定向操作，放行，否则"重画"点了没反应。
    # 查重与建 job 之间不能有 await，故共用 `_SUBMIT_LOCK`（见 submit_job 的说明）。
    async with _SUBMIT_LOCK:
        if not body.view_keys:
            dup = find_active_job("asset_batch", project_id)
            if dup:
                raise HTTPException(status_code=409, detail={
                    "reason": "batch_running", "job_id": dup,
                    "message": "该项目的资产生图任务正在跑，缺失视角会由它一并补齐。"
                               "要立刻重画某一张请点名视角。"})
        with get_session() as session:
            a = _scene_asset(session, asset_id)
            items = scene_view_items_for_asset(session, a, title, look,
                                               body.view_keys or None)
            session.commit()
        if not items:
            raise HTTPException(status_code=400, detail={
                "reason": "nothing_to_do",
                "message": "这个场景的 8 张参考图都已生成。要重画请指定视角。"})

        jid = create_job("asset_batch", {"project_id": project_id, "items": items,
                                         "size": body.size, "model_id": image_model})
    background.add_task(_run_job_guarded, RUNNERS["asset_batch"], jid, "asset_batch")
    return JobOut(id=jid, kind="asset_batch", status="pending", progress=0)


@router.delete("/assets/{asset_id}/scene-views/{view_key}")
def clear_scene_view(asset_id: str, view_key: str) -> dict:
    """清掉某个视角的图（只清这一行，图片文件保留在磁盘上）。

    为什么不顺手删文件：这张图可能已经被注入进某些镜头的提示词/已出的片子里，
    删文件会让那些镜头的参考图 404。清引用足够——用户要的是"重画这一张"。
    主视角被清空时同步清 `Asset.image_url`，否则 `ensure_views` 下次又把它认领回来。
    """
    if view_key not in _sv.BY_KEY:
        raise HTTPException(status_code=400, detail=f"未知视角: {view_key}")
    with get_session() as session:
        a = _scene_asset(session, asset_id)
        row = (session.query(SceneView)
               .filter(SceneView.asset_id == a.id,
                       SceneView.view_key == view_key).first())
        if row is None:
            raise HTTPException(status_code=404, detail="该视角还没有记录")
        old, row.image_url, row.qc_json = row.image_url, None, None
        if _sv.BY_KEY[view_key].primary and a.image_url == old:
            a.image_url = None
        session.commit()
    return {"ok": True}


@router.post("/assets/{asset_id}/board")
def build_scene_board(asset_id: str) -> dict:
    """把该场景已有的视角图拼成**美术设定板**并落库（`Asset.board_url`）。

    ⚠️ 设定板是**派生产物、只给人看**：它带格子线与中文标注，一旦当参考图注入
    镜头，模型会把格子和标注抄进画面（见 `scene_board` 模块头）。所以它只写
    `board_url` 这一列，绝不写 `image_url`，注入链路也从不读它。

    缺图的格子画"未生成"占位，不报错——"这个场景齐不齐"本身就是有用的信息。
    """
    from . import scene_board
    with get_session() as session:
        a = _scene_asset(session, asset_id)
        proj = session.get(Project, a.project_id)
        title = proj.title if proj else ""
        look_text = _lp.phrase(_lp.decode(proj.look_json) if proj else None)
        views = [{"label": r.label, "kind": r.kind, "image_url": r.image_url}
                 for r in _sv.ensure_views(session, a)]
        desc, name = a.prompt, a.name
        session.commit()

    url = scene_board.build(title, name, views, description=desc,
                            look_text=look_text or None)
    if not url:
        raise HTTPException(status_code=502, detail="设定板拼装失败（详见后端日志）")
    with get_session() as session:
        a = session.get(Asset, asset_id)
        if a is not None:
            a.board_url = url
            session.commit()
    return {"ok": True, "board_url": url}


# ---------------------------------------------------------------- 影调档案

@router.get("/projects/{project_id}/look")
def get_project_look(project_id: str) -> dict:
    """全片影调档案 + 词表（前端据此渲染下拉，不硬编码任何词）。"""
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="project not found")
        look = _lp.decode(p.look_json)
    return {"look": look,                      # None = 还没生成过
            "phrase": _lp.phrase(look),        # 实际拼进提示词的那句话，可见即可查
            "axes": _lp.axes_payload(),
            "extra_max": _lp.EXTRA_MAX_LEN,
            "axis_max": _lp.AXIS_MAX_LEN}


class ProjectLookIn(BaseModel):
    #: {轴 key: 取值}。词表外的自定义短词也接受（越界值只标注、不丢弃）
    axes: dict[str, str] = {}
    #: 词表表达不了的整片质感补充
    extra: str = ""


@router.put("/projects/{project_id}/look")
def put_project_look(project_id: str, body: ProjectLookIn) -> dict:
    """手改影调档案（标 `confirmed`，此后自动流程不再覆盖）。

    ⚠️ 改影调**不会**自动重画任何已生成的图。它只影响此后新生成的资产图、
    场景视角图、首帧图与视频提示词——想让老图跟上，得删掉重画（前端给这句提示）。
    """
    with get_session() as session:
        if session.get(Project, project_id) is None:
            raise HTTPException(status_code=404, detail="project not found")
    doc = _lp.save(project_id, {"axes": body.axes, "extra": body.extra},
                   confirmed=True)
    if doc is None:
        raise HTTPException(status_code=400, detail="影调档案为空（至少给一个轴的取值）")
    return {"ok": True, "look": doc, "phrase": _lp.phrase(doc)}


class ProjectStyleIn(BaseModel):
    #: 画风 key（`style_preset.STYLES`）。空串/None = 清空，回到该模式默认档。
    art_style: Optional[str] = None


@router.get("/projects/{project_id}/art-style")
def get_project_art_style(project_id: str) -> dict:
    """项目画风现状 + 该模式可选清单（含未启用档，供前端灰显）。"""
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="project not found")
        mode, chosen = p.production_mode, p.art_style
    eff = _sp.resolve(mode, chosen)
    cat = {m["key"]: m for m in _sp.catalog()["modes"]}
    m = cat.get((mode or "drama"), cat["drama"])
    return {
        "production_mode": mode,
        "art_style": chosen,
        "effective_style": eff.key,
        "effective_label": eff.label,
        #: 选了一档但它还没启用 —— 前端要显式说明"当前实际按都市档生成"，
        #: 否则用户会以为自己选的古风已经生效，出图不对却找不到原因。
        "pending": bool(chosen) and chosen != eff.key,
        "styles": m["styles"],
        "default_style": m["default"],
    }


@router.put("/projects/{project_id}/art-style")
def put_project_art_style(project_id: str, body: ProjectStyleIn) -> dict:
    """改画风。

    ⚠️ 与影调同理：**不会重画任何已生成的图**，只影响此后新生成的资产图、
    场景视角图、首帧图与视频提示词。前端把这句话摊开写在面板上。

    非法 key（不属于本模式/不存在）被 `sanitize` 清成 None 而不是报错——
    但这里要把结果如实回给前端（`art_style` 为 null 就是没设上）。
    """
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="project not found")
        p.art_style = _sp.sanitize(p.production_mode, body.art_style)
        session.commit()
        mode, chosen = p.production_mode, p.art_style
    eff = _sp.resolve(mode, chosen)
    return {"ok": True, "art_style": chosen, "effective_style": eff.key,
            "effective_label": eff.label,
            "pending": bool(chosen) and chosen != eff.key}


@router.post("/projects/{project_id}/look/regenerate")
async def regenerate_project_look(project_id: str) -> dict:
    """按剧本重新判一套影调（清空旧档案后重跑）。

    与形象档案同理：影调是审美判断，重判几乎必然给出不同结果，所以**只能**
    由用户显式触发，自动流程永不重生成（`look_profile.ensure` 绝不覆盖已有）。
    """
    with get_session() as session:
        p = session.get(Project, project_id)
        if not p:
            raise HTTPException(status_code=404, detail="project not found")
        p.look_json = None          # 清空才会被 ensure 当作"缺档案"
        session.commit()
    look = await _lp.ensure(project_id)
    if not look:
        raise HTTPException(status_code=502, detail="影调档案生成失败，请重试")
    return {"ok": True, "look": look, "phrase": _lp.phrase(look)}


# ---------------------------------------------------------------- 资产视觉体检

class AssetQcIn(BaseModel):
    #: 只体检这几个视角（场景资产用）；空 = 全部有图的
    view_keys: list[str] = []
    #: 角色图：是否按"三视图 + 左上角标注"的新口径判。2026-09-09 之前生成的
    #: 老定妆图是单视图无标注，对它们报这两项是代际差异而非缺陷。
    expect_three_view: bool = True
    expect_name_label: bool = True


@router.post("/assets/{asset_id}/qc")
async def qc_asset(asset_id: str, body: AssetQcIn) -> dict:
    """视觉体检：核验"人物图里没有场景 / 场景图里没有人 / 标注是否到位"。

    体检**不阻断任何流程、判不合格也只标记不删图**：判定本身会出错（模型也会
    看错），自动删图等于让一个不可靠的判断销毁用户资产（见 `asset_qc` 模块头）。

    场景视角的结论落库到 `scene_views.qc_json`（重开弹窗还能看到）；
    角色图只返回不落库——`assets` / `asset_stages` 上没有承载它的列，
    为一个可选的质检结论加列不值得。
    """
    from . import asset_qc

    with get_session() as session:
        a = session.get(Asset, asset_id)
        if not a:
            raise HTTPException(status_code=404, detail="asset not found")
        kind, name = a.kind, a.name
        if kind == "location":
            rows = _sv.ensure_views(session, a)
            session.commit()
            want = set(body.view_keys or [])
            targets = [(r.id, r.view_key, r.label, r.image_url) for r in rows
                       if (r.image_url or "").strip()
                       and (not want or r.view_key in want)]
        else:
            targets = [(None, None, "定妆图", a.image_url)] \
                if (a.image_url or "").strip() else []
            # 角色的图实际挂在造型阶段上，资产通用图往往为空，这里一并体检。
            # 墓碑阶段跳过：体检要调模型（花钱/耗时），对一个用户已经删掉的
            # 造型出结论毫无用处。
            for st in stage_gate.alive(
                    session.query(AssetStage)
                    .filter(AssetStage.project_id == a.project_id,
                            AssetStage.character_name == a.name)).all():
                if (st.image_url or "").strip():
                    targets.append((None, None, st.stage_name or "造型", st.image_url))
    if not targets:
        raise HTTPException(status_code=400, detail="这个资产还没有可体检的图")

    async def _one(t):
        _rid, _key, label, url = t
        if kind == "location":
            res = await asset_qc.check_scene(
                url, expect_name_label=body.expect_name_label)
        else:
            res = await asset_qc.check_character(
                url, expect_three_view=body.expect_three_view,
                expect_name_label=body.expect_name_label)
        return {"view_key": _key, "row_id": _rid, "label": label,
                "image_url": url, "result": res,
                "summary": asset_qc.describe(res)}

    out = await asyncio.gather(*[_one(t) for t in targets])

    if kind == "location":
        with get_session() as session:
            for item in out:
                if not item["row_id"] or item["result"] is None:
                    continue        # 体检没跑成就不写——别把"未完成"存成"通过"
                row = session.get(SceneView, item["row_id"])
                if row is not None:
                    row.qc_json = json.dumps(item["result"], ensure_ascii=False)
            session.commit()

    bad = [i for i in out if i["result"] and not i["result"].get("ok")]
    return {"name": name, "kind": kind, "checked": len(out),
            "failed": len(bad), "items": list(out)}
