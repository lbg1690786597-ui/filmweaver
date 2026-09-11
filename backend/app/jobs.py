"""异步任务执行器（MVP：进程内 asyncio 后台任务 + DB 状态）。

不引 celery/redis 队列的原因：MVP 单机单进程足够，任务状态已落 SQLite，
桌面端靠轮询 /v2/jobs/{id} 拿进度；后续量大再平移到 celery，接口不变。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from .asset_prompt import character_prompt, scene_prompt
from .character_brief import brief_for_image
from .db import Job, Shot, AssetStage, get_session, reset_clip_window
from .db import effective_characters as _effective_characters
from .events import publish
from .providers.image import ImageProvider, ContentRejected
from .providers.registry import registry
from .providers.base import AudioMode, VideoRequest, to_public_url
from .scene_desc import ensure_scene_descriptions
from . import stale as stale_mod          # 过期原因与消解规则（单一真源）
from .vision_desc import strip_auto

log = logging.getLogger(__name__)


# ---- 全局视频生成并发池 ----
# 信号量语义天然实现"池满排队、有槽即进"：新任务/重试统一 acquire，
# 上一批任何任务结束释放槽位，等待者立即获得执行权。
_VIDEO_POOL: asyncio.Semaphore | None = None
_IMAGE_GATE: "asyncio.Semaphore | _NoLimit | None" = None
_TTS_GATE: "asyncio.Semaphore | _NoLimit | None" = None


def _video_pool() -> asyncio.Semaphore:
    global _VIDEO_POOL
    if _VIDEO_POOL is None:
        from .config import get_settings
        _VIDEO_POOL = asyncio.Semaphore(max(1, get_settings().video_concurrency))
    return _VIDEO_POOL


class _NoLimit:
    """无上限闸门：与 asyncio.Semaphore 同接口的空实现（async with 直接放行）。"""

    async def __aenter__(self) -> "_NoLimit":
        return self

    async def __aexit__(self, *_exc) -> None:
        return None


def _image_gate() -> asyncio.Semaphore | _NoLimit:
    """图像生成闸门。

    2026-08 起默认**不设并发上限**（settings.image_concurrency=0）：KEY 自身支持
    ≥500 并发、且图像侧有 zx1/api4me 双渠道，此前 8 并发过于保守，把整批生图
    拖成串行体感。真正的过载保护改由 providers/image.py 承担——瞬态错误抖动退避
    重试、渠道级故障标记冷却并切换另一渠道，天然自适应真实承载力。

    ⚠️ 遵并发铁律：这是**取消上限**（放大吞吐），不是降并发；若仍被网关限流，
    正确解法是加 KEY / 提配额，而非把这个值调回小数字。
    需要临时限流时可设环境变量 FW_IMAGE_CONCURRENCY=N（>0 即启用信号量）。

    ⚠️ 必须缓存成模块级单例（与 _video_pool 一致）。
    原来每次调用都 `asyncio.Semaphore(n)` 新建一个 —— 信号量是**按对象**
    计数的，每个 job 各拿一个新闸门，等于"每 job 限 N 并发"而不是
    "全局限 N 并发"：10 个 job 同时跑就是 10×N。
    设了 FW_IMAGE_CONCURRENCY 却发现没拦住，根因在此。

    注：这里只修"限额不生效"，不改任何并发数值（默认仍是 0 = 无上限，
    行为与修复前一致）。
    """
    global _IMAGE_GATE
    if _IMAGE_GATE is None:
        from .config import get_settings
        n = get_settings().image_concurrency
        _IMAGE_GATE = asyncio.Semaphore(n) if n and n > 0 else _NoLimit()
    return _IMAGE_GATE


def _tts_gate() -> asyncio.Semaphore | _NoLimit:
    """TTS 合成闸门（与 _image_gate 同构，含同一个单例陷阱的规避）。

    解说剧一集就是几十段旁白，每段 60-70s——串行跑完要一小时以上，
    而各段之间毫无依赖，并发不影响音质。

    默认 **不设上限**：RunningHub 并发上限 800，实际生产很难打到，
    设人为上限只会白白拖慢。遵并发铁律——瓶颈时加 KEY / 扩容，不是降并发。
    需要临时限流时设 FW_TTS_CONCURRENCY=N。
    """
    global _TTS_GATE
    if _TTS_GATE is None:
        from .config import get_settings
        n = get_settings().tts_concurrency
        _TTS_GATE = asyncio.Semaphore(n) if n and n > 0 else _NoLimit()
    return _TTS_GATE


def create_job(kind: str, payload: dict) -> str:
    jid = uuid.uuid4().hex[:12]
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    # project_id 冗余进独立索引列（B30）：payload 仍是唯一事实来源，
    # 这一列只为"按项目筛 job"能走索引，不必全表载入再逐行解析 JSON。
    pid = payload.get("project_id") if isinstance(payload, dict) else None
    with get_session() as session:
        session.add(Job(id=jid, kind=kind, payload=json.dumps(payload, ensure_ascii=False),
                        project_id=pid if isinstance(pid, str) else None,
                        created_at=now, updated_at=now))
        session.commit()
    return jid


#: 同项目内互斥的 job 分组：命中同组且仍在跑，就不许再提交第二个。
#: 判据是"重复跑一遍纯属浪费钱"：这些 job 的 shot_ids 缺省=全项目，
#: 用户多点一次就会有两批任务生成同一批镜头。
#: （2026-08 实测：项目 e3e5d6e517c6 因双击提交，113/170 镜被生成两遍，
#:  shot_versions 里 170 个镜头躺了 276 个版本，约 106 次视频生成白烧。）
#: 分组而非按 kind 精确匹配的原因：「🚀 一条龙」内部就是首帧+片段，
#: 它在跑的时候再点「▶ 全部生成」同样是重复烧同一批镜头。
#: 资产/拆解各自成组——它们与出片是不同资源，没必要互相挡。
#: 单镜重生不在此列（不是批量 job），用户针对某一镜的操作永远不该被批量任务挡住。
_EXCLUSIVE_GROUPS: dict[str, str] = {
    "shot_videos": "shots",
    "first_frames": "shots",
    "first_frame_pipeline": "shots",
    "one_click_film": "shots",
    "asset_batch": "assets",
    # 与 asset_batch 互斥：识别会删掉「还没出图」的阶段行重排，若此时批量生图
    # 正在按 stage_id 落图，图会落到一个刚被删掉的阶段上（钱花了、图丢了）。
    "costume_scan": "assets",
    "breakdown_all": "breakdown",
}


def find_active_job(kind: str, project_id: str | None,
                    payload: dict | None = None) -> str | None:
    """同项目、同互斥组且仍在 pending/running 的 job id；没有则 None。

    payload 是 JSON 文本列，活跃 job 至多几条，直接内存过滤即可，
    不值得为它加索引列。

    TB-04：**定向提交不参与去重**。上面的注释一直写着「单镜重生永远不该被
    批量任务挡住」，但实际拦截发生在这里、只看 kind + project_id——前端的
    「重试这一镜」走的也是 shot_videos，于是被在跑的整批任务判成重复，
    直接返回那个批量 job，用户点了没反应、还以为自己重试成功了。

    判据：payload 明确带了 shot_ids（非空列表）= 用户点名了要哪几镜，
    这是定向操作，放行。缺省/None = 覆盖全项目的批量任务，照旧去重。
    """
    if payload:
        ids = payload.get("shot_ids")
        if isinstance(ids, list) and ids:
            return None

    group = _EXCLUSIVE_GROUPS.get(kind)
    if not group or not project_id:
        return None
    peers = [k for k, g in _EXCLUSIVE_GROUPS.items() if g == group]
    with get_session() as session:
        # 按 project_id 索引列直接筛（B30）：原来是把所有活跃 job 载入再逐行
        # json.loads(payload) 比对。活跃 job 通常只有几条，但这条路径在每次
        # 提交都要走，没理由做全表扫描。
        rows = (session.query(Job)
                .filter(Job.kind.in_(peers),
                        Job.status.in_(("pending", "running")),
                        Job.project_id == project_id)
                .all())
        if rows:
            return rows[0].id
        # 兜底：老数据 project_id 可能为 NULL（回填漏掉/payload 损坏），
        # 此时仍按 payload 复核，避免去重失效导致重复烧钱。
        legacy = (session.query(Job)
                  .filter(Job.kind.in_(peers),
                          Job.status.in_(("pending", "running")),
                          Job.project_id.is_(None))
                  .all())
        for j in legacy:
            try:
                if json.loads(j.payload or "{}").get("project_id") == project_id:
                    return j.id
            except ValueError:
                continue
    return None


#: job 的「当前阶段」标签（内存态，随进程生死；job 本来也活不过进程重启）。
#: 存在的理由：i2va 批量出片会**先把整批首帧生完再提交视频**，170 镜的头几分钟
#: 视频数恒为 0、进度条几乎不动，用户看着就是"点了没反应"（2026-08 实测投诉，
#: 用户因此又点了一次，同一批镜头被生成两遍）。把阶段摊到台面上才能自证在干活。
#: 形如 {"key": "frames", "label": "正在出首帧", "done": 32, "total": 170}
_JOB_PHASE: dict[str, dict] = {}


def set_job_phase(jid: str, phase: dict | None) -> None:
    """设置/清除 job 阶段标签。清除用于收尾，避免 dict 无限增长。"""
    if phase is None:
        _JOB_PHASE.pop(jid, None)
    else:
        _JOB_PHASE[jid] = phase


def get_job_phase(jid: str) -> dict | None:
    return _JOB_PHASE.get(jid)


def is_cancelled(jid: str) -> bool:
    """任务是否已被用户取消（routes_v2::cancel_job 只改状态位）。

    批量 runner 在每个镜头/每个分片的边界调一次：不能中途硬杀协程，
    但可以不再发起**下一个**上游请求——这是能少烧钱的最大粒度。
    """
    with get_session() as session:
        job = session.get(Job, jid)
        return bool(job and job.status == "cancelled")


#: 逐条目结果里"这一项是被取消的"的统一措辞。判定整批是否属于用户取消要按它匹配，
#: 所以**只能有一处定义**——散着写字面量，改了文案就会悄悄退化成"整批失败"。
_CANCELLED_MSG = "已取消"

#: 写进 Job.error 的失败明细上限。生产上出现过 12KB 的 JSON 直接灌进这一列，
#: 前端原样铺在错误卡片里，用户面对的是一屏 `{"name":...,"error":...}`。
_ERR_ITEMS_CAP = 5
_ERR_TEXT_CAP = 500


def _brief_errors(failed: list[dict]) -> str:
    """把逐条目失败明细压成人能读的一句话 + 前几条样例。

    保留原始 JSON 的诉求是"可排查"，但那属于 `Job.result`（本来就存着全量
    results）；`Job.error` 是**给用户看的**，必须短。

    各 runner 的条目形状不同（资产用 name、镜头用 order、拆解用 episode），
    统一取第一个能标识"是哪一条"的字段当标签。
    """
    if not failed:
        return ""

    def _label(r: dict) -> str:
        for k, fmt in (("name", "{}"), ("order", "第 {} 镜"),
                       ("episode", "第 {} 集"), ("id", "{}")):
            if r.get(k) is not None:
                return fmt.format(r[k])
        return "?"

    head = "；".join(f"{_label(r)}: {str(r.get('error', '')).strip()[:80]}"
                     for r in failed[:_ERR_ITEMS_CAP])
    more = f"（另有 {len(failed) - _ERR_ITEMS_CAP} 项失败）" \
        if len(failed) > _ERR_ITEMS_CAP else ""
    return f"{len(failed)} 项失败：{head}{more}"[:_ERR_TEXT_CAP]


def _update(jid: str, **fields) -> None:
    with get_session() as session:
        job = session.get(Job, jid)
        if not job:
            return
        # 已取消的任务不许被 runner 的收尾 _update 改回 done/failed——
        # 否则用户点了取消、进度条却在几十秒后跳成"已完成"，看起来像没生效。
        # 进度/结果仍照写，方便回溯取消时跑到哪儿了。
        if job.status == "cancelled":
            fields.pop("status", None)
        for k, v in fields.items():
            setattr(job, k, v)
        job.updated_at = datetime.now(timezone.utc).isoformat(timespec="seconds")
        session.commit()
        # 终态清理必须在**组装 SSE 快照之前**做，否则收尾那一条事件里还挂着
        # 「正在出首帧 32/170」，前端收到 status=done 的同时又收到一个进行中
        # 的阶段标签，进度条会停在最后一个阶段上不消失。
        #
        # cancelled 也是终态（B32）。原来只清 done/failed，而上面那段又把
        # cancelled 任务的 status 更新全部 pop 掉 —— 于是被取消的 job
        # **永远**到不了 done/failed，阶段标签就在 _JOB_PHASE 里留到进程重启。
        # 后端是长驻裸进程（filmweaver-dev-backend.service），取消得越多这个
        # dict 越大，且 runner 后续的收尾 _update 还会把这个陈旧阶段一路推给
        # SSE，前端在任务已取消后仍显示「正在出首帧」。
        if job.status in ("done", "failed", "cancelled"):
            _JOB_PHASE.pop(job.id, None)
        # P2-5 SSE：job 状态/进度变更即发事件（payload 里带 project_id 的才推）
        snap = {"id": job.id, "kind": job.kind, "status": job.status,
                "progress": job.progress,
                "error": (job.error or "")[:200] or None,
                # 阶段标签随事件一起推：SSE 在线时轮询降到 15s 兜底，
                # 光靠轮询拿 phase 会慢到失去"在干活"的说服力
                "phase": _JOB_PHASE.get(job.id)}
        try:
            pid = json.loads(job.payload or "{}").get("project_id")
        except ValueError:
            pid = None
    publish(pid, "job", snap)


def get_job(jid: str) -> Job | None:
    with get_session() as session:
        return session.get(Job, jid)


async def run_asset_batch(jid: str, parent_jid: str | None = None) -> None:
    """批量资产生图：payload={"items":[{"name","prompt","stage_id"?},...],"model_id","size","project_id"}。

    并发策略（显著提速且保同角色多阶段一致性）：
    - 场景图：直接并发（无依赖）；
    - 角色阶段（带 stage_id）：按 character_name 分组，同角色串行（基准→参考并发），
      不同角色并发（受 Semaphore(8) 限流）。基准选已有图的阶段，全没图取 ep_from 最小。
      基准图失败则逐个尝试其他阶段，全失败才报该角色整体失败（退回文生图会导致跨阶段
      人物不一致 = 接下来视频全废，必须阻断）。
    - 配角/自定义资产（无 stage_id）：与场景图同批并发。

    实时刷新：每张落库即推进度（前端逐张点亮）。
    """
    from collections import defaultdict
    from .config import get_settings
    from .db import Asset, AssetStage

    job = get_job(jid)
    if not job:
        return
    payload = json.loads(job.payload)
    items = payload.get("items", [])
    model_id = payload.get("model_id")
    size = payload.get("size", "1024x1024")
    project_id = payload.get("project_id")

    _update(jid, status="running")
    provider = ImageProvider(model_id=model_id)
    total = len(items)
    done_count = 0
    results: list[dict] = []

    def _report(name: str, urls: list[str] | None = None, error: str | None = None):
        nonlocal done_count
        r = {"name": name}
        if urls:
            r["urls"] = urls
        if error:
            r["error"] = error
        results.append(r)
        done_count += 1
        _update(jid, progress=int(done_count / max(total, 1) * 100),
                result=json.dumps(results, ensure_ascii=False))
        # 同步回报到父 job 的阶段计数：一键成片的进度面板与资产轨都读它。
        # 不报的话父 phase.done 恒为 0——前端以为一张都没出，
        # 资产图要等整条流水线跑完才出现在轨道上。
        if parent_jid:
            set_job_phase(parent_jid, {"key": "assets", "label": "正在补资产图",
                                       "done": done_count, "total": total})

    async def _gen_and_save(item: dict, ref_urls: list[str] | None = None
                            ) -> tuple[str | None, str | None]:
        """生成一张图并落库，返回 (url, error)。"""
        # 取消检查点。必须在 provider.generate **之前** —— 那一步才是花钱的。
        # 本函数此前完全没有检查点：run_asset_batch 收了 parent_jid 却只拿它
        # 当阶段标签用，用户点「停止生产」之后，剩下的图照样一张张生成并计费。
        # 每张图入口检查一次，而不是只在批次开头 —— 图像生成是逐张 await 的，
        # 只在开头检查等于"取消一律无效"（所有协程在第一轮事件循环就通过了）。
        if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
            return None, _CANCELLED_MSG
        try:
            urls = await provider.generate(item["prompt"], size=size, ref_urls=ref_urls)
            if not urls:
                return None, "模型未返回图片"
            url = urls[0]
            # ⚠️ 目标行不存在时必须报失败，不能静默丢弃。
            # 这里的图已经生成、钱已经花了；如果对应的 AssetStage/Asset 在生成
            # 期间被删（用户重新识别造型、或同步接口 POST /v2/stages/draft
            # 的批量删除 —— 它不是 job，find_active_job 的互斥拦不住它），
            # 原来的写法会跳过写库、照样 return (url, None)，
            # _report 记为成功。结果：花了钱、图变成孤儿文件、
            # 用户看到一个绿勾和一个空的资产槽位，无从判断发生了什么。
            if item.get("stage_id"):
                with get_session() as session:
                    st = session.get(AssetStage, item["stage_id"])
                    if not st:
                        return None, (f"生成成功但目标阶段已不存在"
                                      f"（可能在生成期间被删除）；图片已生成: {url}")
                    st.image_url = url
                    session.commit()
            elif item.get("scene_view_id"):
                # 场景多视角：图落在 SceneView 行上。主视角还要**写回**
                # Asset.image_url——readiness/资产页缩略图/注入兜底全读那一列，
                # 不写回去整个项目会报"所有场景都没图"（见 scene_view 模块头）。
                from .db import SceneView
                with get_session() as session:
                    sv_row = session.get(SceneView, item["scene_view_id"])
                    if not sv_row:
                        return None, (f"生成成功但目标场景视角已不存在"
                                      f"（可能在生成期间被删除）；图片已生成: {url}")
                    sv_row.image_url = url
                    sv_row.prompt = item.get("prompt")
                    if item.get("primary"):
                        a = session.get(Asset, sv_row.asset_id)
                        if a is not None:
                            a.image_url = url
                    session.commit()
            elif project_id:
                raw_name = item.get("name", "")
                plain = raw_name.split("-", 1)[1] if "-" in raw_name else raw_name
                with get_session() as session:
                    a = (session.query(Asset)
                         .filter(Asset.project_id == project_id, Asset.name == plain)
                         .first())
                    if not a:
                        return None, (f"生成成功但目标资产「{plain}」已不存在"
                                      f"（可能在生成期间被删除）；图片已生成: {url}")
                    a.image_url = url
                    session.commit()
            return url, None
        except Exception as e:  # noqa: BLE001
            # 用 repr：httpx 超时/连接类异常 str() 为空，repr 才能看到类型
            return None, repr(e)[:200]

    async def _gen_character(cname: str, char_items: list[dict], base_url: str | None):
        """一个角色的所有待生成阶段。

        base_url 非空 = 该角色已有定妆图（本批之外的阶段图 / 角色通用图），
        直接全部并发喂它做参考。base_url 为空 = 全新角色：先串行生一张基准，
        再用基准并发生剩余。

        基准图**必须**成功。退回纯文生图会让同角色跨阶段换脸，用户不一定当场发现，
        后续视频按不一致的首帧全量生成，损失远大于这里报错停下。所以逐个阶段换提示词
        重试，全失败才把该角色整组判失败（且一张都不落库）。
        基准阶段试失败的条目不在此时结算——它们回到 pend，稍后带基准图重试一次。
        """
        pend = sorted(char_items, key=lambda x: x.get("ep_from", 999))
        if base_url is None:
            base_errs: list[str] = []
            for it in list(pend):
                url, err = await _gen_and_save(it)
                if url:
                    _report(it["name"], [url])
                    pend.remove(it)
                    base_url = url
                    break
                base_errs.append(f"{it['name']}={err}")
            if base_url is None:
                # 该角色一张都生不出来：整组判失败，不留"各自文生图"的隐患
                for it in pend:
                    _report(it["name"],
                            error=f"基准定妆图生成失败，整组跳过（以免跨阶段换脸）：{base_errs[0] if base_errs else ''}")
                results.append({
                    "name": f"角色「{cname}」",
                    "error": f"所有 {len(base_errs)} 个阶段的基准定妆图均生成失败，"
                             f"该角色未产出任何图。明细：" + "；".join(e[:80] for e in base_errs),
                })
                _update(jid, result=json.dumps(results, ensure_ascii=False))
                return
        # 剩余阶段并发，全部以同一张基准图为参考 → 同角色跨造型保持同一张脸
        if pend:
            out = await asyncio.gather(*[_gen_and_save(it, ref_urls=[base_url])
                                         for it in pend])
            for it, (url, err) in zip(pend, out):
                _report(it["name"], [url] if url else None,
                        error=None if url else f"生成失败：{err}")

    async def _gen_scene(scene_key: str, view_items: list[dict],
                         base_url: str | None):
        """一个场景的所有待生成视角（多视角参考图，2026-09-09 新增）。

        与 `_gen_character` 同构，理由也同构：先串行生**主视角全景**当基准，
        其余 7 张全部 `ref_urls=[base]` 并发生成。

        为什么场景也需要基准链（用户反馈「不同图片画面色调不统一」的成因之三）：
        没有基准图时，同一个客厅的 8 个视角是 8 次独立生成 —— 不但色调各走各的，
        连"这是同一个房间"都不成立（墙纸、地板、家具会各画一套）。角色侧靠基准图
        链解决了跨造型换脸，场景侧照抄即可。

        与 `_gen_character` 的**一处关键差别**：主视角失败时**不**整组判失败，
        而是退回各自独立生成。理由是代价不对称——
        · 角色换脸 = 后续视频全废（必须阻断）；
        · 场景视角不一致 = 参考图差一点，画面仍能用（阻断反而让这个场景一张图都没有，
          注入时连兜底都没得挑，退化成纯文生图）。
        """
        prim = [it for it in view_items if it.get("primary")]
        rest = [it for it in view_items if not it.get("primary")]
        if base_url is None and prim:
            it = prim[0]
            url, err = await _gen_and_save(it)
            _report(it["name"], [url] if url else None,
                    error=None if url else f"生成失败：{err}")
            base_url = url
            prim = []
        pend = prim + rest
        if not pend:
            return
        if base_url is None:
            log.warning("[asset_batch] 场景「%s」主视角未生成，其余视角退回独立生成"
                        "（视角之间可能不是同一个空间）", scene_key)
        out = await asyncio.gather(*[
            _gen_and_save(it, ref_urls=[base_url] if base_url else None)
            for it in pend])
        for it, (url, err) in zip(pend, out):
            _report(it["name"], [url] if url else None,
                    error=None if url else f"生成失败：{err}")

    async def _gen_simple(item: dict):
        """场景 / 无阶段的配角：彼此无依赖，直接并发。"""
        url, err = await _gen_and_save(item)
        _report(item["name"], [url] if url else None,
                error=None if url else f"生成失败：{err}")

    # ---- 分组：角色阶段（按角色聚合）| 场景视角（按场景聚合）| 无阶段配角 ----
    by_char: dict[str, list[dict]] = defaultdict(list)
    by_scene: dict[str, list[dict]] = defaultdict(list)
    simple: list[dict] = []
    char_base: dict[str, str | None] = {}
    scene_base: dict[str, str | None] = {}
    with get_session() as session:
        for item in items:
            if item.get("scene_view_id"):
                # 多视角场景图：按场景资产聚合，同场景串行出基准 → 其余并发
                by_scene[item.get("scene_asset_id") or item["scene_view_id"]].append(item)
                continue
            st = (session.get(AssetStage, item["stage_id"])
                  if item.get("stage_id") else None)
            if st is None:
                simple.append(item)
                continue
            item["ep_from"] = st.ep_from          # 基准优先级：时间上最早的造型
            by_char[st.character_name].append(item)
        # 基准图优先取"该角色已有的图"：本批之外的阶段图 > 角色通用图
        # （判定与资产弹窗手动生图共用 asset_ref.character_base_ref，
        #  否则两条路挑的基准不一样，手动补的那张就跟批量出的不是同一张脸）。
        # 已有图时无需先串行生一张，全部阶段可直接并发。
        from .asset_ref import character_base_ref
        for cname in by_char:
            char_base[cname] = character_base_ref(
                session, project_id, cname,
                exclude_stage_ids={it["stage_id"] for it in by_char[cname]})
        # 场景基准 = 已有的主视角图。补齐个别缺失视角时（主视角早就有图）
        # 直接拿它当参考，不必先串行生一张。
        from .scene_view import base_ref as _scene_base_ref
        for said in by_scene:
            base = _scene_base_ref(session, said)
            # 本批要重画主视角时，那张旧图不能当基准——否则新主视角会照抄旧的，
            # 用户点"重画"等于没画。
            if any(it.get("primary") for it in by_scene[said]):
                base = None
            scene_base[said] = base

    # ---- 并发执行 ----
    # 图像侧默认**不设并发上限**（settings.image_concurrency=0）：渠道冷却 + 抖动退避
    # 天然自适应真实承载力，此前固定 8 并发过于保守。慢的根因是整批串行；
    # 若网关仍限流（429），正确解法是加 KEY / 提配额（遵并发铁律）。
    gate = _image_gate()

    async def _limited(coro_fn):
        async with gate:
            await coro_fn()

    await asyncio.gather(
        *[_limited(lambda it=it: _gen_simple(it)) for it in simple],
        *[_limited(lambda c=c, its=its: _gen_character(c, its, char_base.get(c)))
          for c, its in by_char.items()],
        *[_limited(lambda k=k, its=its: _gen_scene(k, its, scene_base.get(k)))
          for k, its in by_scene.items()],
    )

    # 整批判定：一张都没产出才算 failed（部分成功仍 done，失败明细进 error 供前端提示）。
    # 注意 results 里除逐条目结果外还可能有「角色「X」」这样的整组汇总行，不能按条数比。
    failed = [r for r in results if "error" in r]
    ok = [r for r in results if r.get("urls")]
    # ⚠️ 用户主动取消不是"失败"（2026-09-01 生产报障）。
    # 原来一律判 failed，于是用户点了「停止生产」之后，界面弹出一张红色
    # 「生成失败」卡片，正文是**每一条**资产的
    # `{"name":"场景-AEGIS公司","error":"生成失败：已取消"}` —— 实测生产上那条
    # 记录 12KB、几十项，用户完全读不出"这是我自己取消的"。
    # 取消时给 cancelled + 一句人话；`_update` 里那段"cancelled 不许被改回"
    # 只挡 status，仍会把 error 写进去，所以必须在这里就给对文案。
    cancelled = bool(failed) and all(
        str(r.get("error", "")).endswith(_CANCELLED_MSG) for r in failed)
    if cancelled and not ok:
        _update(jid, status="cancelled",
                error=f"已取消（{len(failed)} 项未开始生成）")
        return
    _update(
        jid,
        status="failed" if (total and not ok) else "done",
        error=_brief_errors(failed) if failed else None,
    )


def _resolve_project_gen_settings(proj) -> tuple[str | None, str | None]:
    """解析项目级 (generation_mode, image_model)。

    2026-08 重构：新项目统一读 default_profile JSON；
    旧预设项目（fast/consistent/premium/first_frame）通过 _LEGACY_DEFAULTS 兜底。
    """
    if proj is None:
        return None, None
    gen_mode = image_model = None
    if proj.default_profile:
        try:
            cs = json.loads(proj.default_profile)
            gen_mode = cs.get("generation_mode")
            image_model = cs.get("image_model")
        except (ValueError, AttributeError):
            pass
    if not gen_mode or not image_model:
        # 旧预设兜底
        from .routes_v2 import _LEGACY_DEFAULTS
        pm = proj.production_mode or ""
        d = _LEGACY_DEFAULTS.get(pm, {})
        gen_mode = gen_mode or d.get("generation_mode")
        image_model = image_model or d.get("image_model")
    return gen_mode, image_model


#: 画幅 → 首帧图 size（与视频画幅一致，防止首帧比例错配导致裁切偏移）
_FRAME_SIZES = {"9:16": "1024x1792", "16:9": "1792x1024", "1:1": "1024x1024",
                "3:4": "1024x1365", "4:3": "1365x1024", "21:9": "1792x768"}

#: 首帧生成喂给图像模型的参考图张数上限。
#: 与视频模型的 max_reference_images 无关——那是"视频侧能吃几张"，
#: 这是"生图侧能吃几张"，两者不可混用（混用会篡改视频通道能力值）。
_FRAME_REF_LIMIT = 4

#: 每 (project_id, canonical) 一把锁：同场景多镜头并发时，
#: 只让第一个镜头生成场景锚点，其余等待后复用，避免重复烧钱与锚点竞争。
#: 只锁"锚点生成"，不锁视频生成——视频侧 300 并发不受影响（遵并发铁律）。
#:
#: ⚠️ 曾按 (project_id, episode, location) 建键。那意味着同一个房间在第 1 集和
#: 第 10 集各生成一张互不相干的基准帧，跨集必漂；而拆解出的 location 每集写法
#: 还不一样（实测 22 个场景名跨集复用率 0，见 db.SceneAlias），于是同一集内
#: 换个写法也会再出一张。现在统一按**归一场景名**共享。
_ANCHOR_LOCKS: dict[tuple[str, str], asyncio.Lock] = {}
_ANCHOR_LOCKS_GUARD = asyncio.Lock()


async def _anchor_lock(key: tuple[str, str]) -> asyncio.Lock:
    """取该场景的锁（首次访问时创建）。守卫锁保证 dict 写入本身线程安全。"""
    async with _ANCHOR_LOCKS_GUARD:
        lk = _ANCHOR_LOCKS.get(key)
        if lk is None:
            lk = asyncio.Lock()
            _ANCHOR_LOCKS[key] = lk
        return lk


def scene_canonical(project_id: str, location: str | None) -> str:
    """`Shot.location` 原值 → 归一场景名（空名返回空串）。"""
    if not location or not location.strip():
        return ""
    from .scenes import canonical_of
    with get_session() as session:
        return canonical_of(session, project_id, location)


def _get_anchor(project_id: str, canonical: str, episode: int | None = None,
                location: str | None = None) -> str | None:
    """查场景锚定图 URL（无则 None）。

    先按归一场景名查；查不到再按旧键 (episode, location) 兜一次——旧库里
    `canonical` 是 NULL 的历史行仍要能命中，否则升级后所有锚点都要重出一遍（白烧钱）。
    """
    from .db import SceneAnchor
    with get_session() as session:
        if canonical:
            a = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id,
                         SceneAnchor.canonical == canonical).first())
            if a is not None:
                return a.image_url
        if location:
            q = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id,
                         SceneAnchor.location == location))
            if episode is not None:
                q = q.filter(SceneAnchor.episode == episode)
            a = q.first()
            if a is not None:
                return a.image_url
        return None


def _put_anchor(project_id: str, canonical: str, episode: int, location: str,
                image_url: str, prompt: str) -> None:
    """落库场景锚定图（同一归一场景已存在则覆盖——重生锚点走同一入口）。

    `episode` / `location` 只作"这张锚点是从哪一镜建起来的"来源记录，
    共享与查找一律按 `canonical`。
    """
    from .db import SceneAnchor
    with get_session() as session:
        a = None
        if canonical:
            a = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id,
                         SceneAnchor.canonical == canonical).first())
        if a is None:
            # 旧行（canonical 为 NULL）就地补上 canonical，不再新增一行
            a = (session.query(SceneAnchor)
                 .filter(SceneAnchor.project_id == project_id,
                         SceneAnchor.episode == episode,
                         SceneAnchor.location == location).first())
        if a is None:
            a = SceneAnchor(id=uuid.uuid4().hex[:16], project_id=project_id,
                            episode=episode, location=location)
            session.add(a)
        a.canonical = canonical or None
        a.image_url = image_url
        a.prompt = prompt
        session.commit()


async def _ensure_scene_anchor(project_id: str, episode: int, location: str,
                               ref_urls: list[str], ref_labels: list[str],
                               aspect: str, image_model: str | None,
                               force: bool = False,
                               canonical: str | None = None) -> str | None:
    """取（或首次生成）该场景的锚定基准帧。

    同场景所有镜头共享此帧作参考 → 陈设/光线/机位基调统一，
    这是"同一场景不同镜头之间场景漂移"的主要解法。
    共享粒度是**归一场景**（同一个房间跨集/跨写法都是同一张），
    `canonical` 不传则就地解析。
    返回 None 表示锚点不可用（上层降级为仅用资产图，不阻塞出片）。
    """
    if not location:
        return None
    canon = canonical if canonical is not None else scene_canonical(project_id, location)
    if not force:
        hit = _get_anchor(project_id, canon, episode, location)
        if hit:
            return hit
    lk = await _anchor_lock((project_id, canon or location))
    async with lk:
        # 锁内二次查库：并发同场景的其他镜头可能已建好锚点
        if not force:
            hit = _get_anchor(project_id, canon, episode, location)
            if hit:
                return hit
        listing = ("；".join(f"参考图{i + 1}为{lb}"
                            for i, lb in enumerate(ref_labels)) if ref_labels else "")
        st = _style_of(project_id)
        prompt = (
            f"{st.anchor_head}：{canon or location}。{listing}"
            f"{'。人物外观、服装、发型与场景陈设必须与参考图完全一致，不得改变。' if ref_labels else ''}"
            "requirements：完整呈现该场景的空间布局、陈设、材质与光线氛围，"
            "视角为该场景的标准全景机位，构图稳定、光线自然。"
            "本图将作为该场景所有镜头的统一视觉基准。"
            "禁止出现任何文字、水印、字幕、分镜框。"
            # 画风否定项必须跟着 anchor_head 一起给：基准帧是"该场景所有镜头的
            # 视觉基准"，它跑偏了下游每一镜都跟着跑偏。只给正向的
            # 「国漫动画场景基准图」而不给「禁止真人实拍照片感」，模型很容易
            # 出成实景照片——这一层是整条链上最不能省否定项的地方。
            # （都市档因此比改动前多一句「禁止卡通、动漫、插画、3D 渲染风格」，
            #  与该档本意同向，属收紧。）
            + st.negative
            # 锚点是"该场景所有镜头的视觉基准"，它自己不带影调，
            # 下游每镜首帧就会各自漂一点色 —— 影调必须从基准帧这一层就定下来。
            + _look_line(project_id))
        url = await _image_gen(prompt, aspect, image_model, ref_urls)
        if url:
            _put_anchor(project_id, canon, episode, location, url, prompt)
        return url


async def _image_gen(prompt: str, aspect: str, image_model: str | None,
                     ref_urls: list[str], strict: bool = False) -> str | None:
    """调图像模型出一张图。

    strict=False（默认）：失败返回 None，调用方自行降级——视频批量生成走这条，
      首帧失败会自动回退全参考路线，不该因一张图中断整批出片。
    strict=True：把异常原样抛出，让调用方拿到**真实失败原因**（尤其是
      ContentRejected 内容审核拒绝）。批量首帧走这条：用户明确要的就是首帧图，
      失败时必须告诉他"是提示词被判违规、该换模型或改写"，而不是吞成一句
      含糊的"图像渠道不可用"（2026-08 项目 812 的实际困惑来源）。
    """
    from .providers.image import ImageProvider
    provider = ImageProvider(model_id=image_model or "gpt-image-2")
    try:
        urls = await provider.generate(
            prompt, size=_FRAME_SIZES.get(aspect, "1024x1792"), n=1,
            ref_urls=ref_urls[:_FRAME_REF_LIMIT] or None)
        return urls[0] if urls else None
    except Exception:  # noqa: BLE001  生图失败不阻塞出片，由上层降级
        if strict:
            raise
        return None


#: `_gen_first_frame(anchor=...)` 的"未指定"哨兵——区分"没传"与"显式传 None"。
_ANCHOR_AUTO: object = object()


#: 首帧图提示词蒸馏的 system prompt。
#: ⚠️ 不复用 seedance2 / minimax_h3 那套**视频**框架：那套的产物必然带运镜、
#: 时序推进与台词，喂给生图模型只会让画面出字幕、构图被运动词带偏。
#: 首帧要的是"t=0 这一瞬间画面里有什么"，是一道独立的图像描述任务。
_FRAME_DISTILL_SYS = """你是分镜首帧图提示词专家。把一条镜头描述改写成"该镜头第一帧画面"的静态图像提示词。

硬性规则：
1. 只描述镜头**开始那一瞬间**画面里可见的东西。镜头中后段才发生的动作、结果、反转一律不写。
2. 禁止任何时间推进词：然后、接着、随后、开始、逐渐、最终、转身后……画面是一个凝固的瞬间。
3. 禁止运镜词（推、拉、摇、移、跟、变焦、镜头缓缓……）。机位只能写成静态取景：景别（特写/近景/中景/全景/远景）、角度（平视/俯拍/仰拍/过肩）。
4. 禁止台词、旁白、音效、字幕、画外音。禁止要求画面出现任何文字。
5. 人物必须处于**动作自然进行中**的姿态（重心、视线、手部有明确去向），不是摆拍、不是看镜头、不是居中站定的海报构图。
6. 参考图锁定的是人物**长相与发型**、以及场景陈设——这些不要重复描述。
7. **服装例外**：定妆图只是该角色的常规造型，不代表本镜穿什么。剧本明确写了本镜服装（如"一身红裙""黑色小西装""浴袍"）时，**必须把这件服装写进提示词**并注明"服装以本描述为准，仅面部与发型参照参考图"。剧本没写服装才沿用参考图造型、不着笔墨。
8. 输出一段中文，不超过 200 字，纯文本，不要 markdown、不要代码块、不要标题、不要分点。只输出提示词本身。"""


async def _distill_frame_prompt(script_ref: str, gen_prompt: str | None,
                                location: str | None,
                                labels: list[str]) -> str | None:
    """把镜头描述蒸馏成"首帧静态画面"的生图提示词。

    为什么不能直接用 script_ref / gen_prompt：
    - script_ref 是**整镜**剧本行（含台词、含中后段动作），直接截断喂生图，
      模型会把整镜内容压进一张图，或干脆画出台词字幕；
    - gen_prompt 是给**视频**模型的稿（运镜 + 时序推进），静态图里没有"运动"
      可言，那些词只会污染构图。
    两者都作为素材交给 LLM，由它抽出 t=0 的可见状态。script_ref 是权威语义源，
    gen_prompt 仅作补充（且 i2va 重跑时它已被改写成"只描述运动"，不可单独依赖）。

    失败返回 None → 调用方回退确定性拼接，不阻断出片。
    """
    from .providers.llm import LLMProvider
    parts = [f"【镜头剧本】{script_ref[:600]}"]
    if gen_prompt and gen_prompt.strip() != (script_ref or "").strip():
        parts.append(f"【已有视频提示词（仅供参考，其中的运镜与时序不要带进首帧）】"
                     f"{gen_prompt[:400]}")
    if location:
        parts.append(f"【场景】{location}")
    if labels:
        parts.append(f"【已提供参考图】{'；'.join(labels)}（外观以参考图为准，不要重复描述）")
    try:
        llm = LLMProvider()
        out = await llm.complete(_FRAME_DISTILL_SYS, "\n".join(parts),
                                 temperature=0.3)
    except Exception:  # noqa: BLE001 蒸馏失败不阻断出片，上层回退拼接
        return None
    text = (out or "").strip()
    # 模型偶尔仍包代码块/前言，取最长的一段纯文本行
    if "```" in text:
        import re as _re
        blocks = _re.findall(r"```(?:[a-zA-Z]*)\s*(.*?)```", text, _re.DOTALL)
        text = (blocks[0].strip() if blocks else text.replace("```", "").strip())
    text = text.strip().strip("`").strip()
    return text[:400] or None


async def _gen_first_frame(project_id: str, episode: int, location: str | None,
                           script_ref: str, ref_urls: list[str],
                           ref_labels: list[str], aspect: str,
                           image_model: str | None,
                           gen_prompt: str | None = None,
                           anchor: "str | None | object" = _ANCHOR_AUTO,
                           strict: bool = False) -> str | None:
    """首帧流水线第一步：图像模型生成本镜首帧（图生图喂资产参考保一致性）。

    抗偏移四重保障：
    ① 图生图（images/edits / gemini inlineData）——角色/场景外观由参考图钳制；
    ② 首帧 size 与项目画幅一致——视频侧无需裁切，杜绝构图偏移；
    ③ **场景锚定图复用**——同场景所有镜头以同一张基准帧为参考，
       解决"每镜各自生图导致同场景陈设/光线漂移"这一首帧路线的核心难题；
    ④ **首帧语义蒸馏**——LLM 把整镜描述压成"t=0 可见状态"再生图。
       曾直接把 `script_ref[:400]` 喂生图并要求"静态画面…动作处于起始瞬间"，
       结果是整镜内容挤进一张图 + 摆拍感定格，这正是"首帧常常不适合做首帧"
       的成因（2026-08 项目 812 反馈）。蒸馏失败回退确定性拼接，不阻断出片。
    失败返回 None（上层回退全参考路线，不阻塞出片）。

    gen_prompt: 该镜已有的视频提示词，作为蒸馏的补充素材（权威源仍是 script_ref）。

    anchor: 传入即直接采用这张场景基准帧（显式 None = 该场景无可用锚点，不再尝试）；
      不传则就地按需生成/复用（run_shot_videos 老路径不变）。批量首帧会先并发预热
      全部锚点再传进来——否则同场景镜头会**占着并发槽干等锚点锁**，整池吞吐塌成 1。
    """
    if anchor is _ANCHOR_AUTO:
        anchor = await _ensure_scene_anchor(
            project_id, episode, location or "", ref_urls, ref_labels,
            aspect, image_model)
    # 锚点排在资产图之后：角色一致性权重最高，场景基准作为氛围/陈设锚
    refs = list(ref_urls)
    labels = list(ref_labels)
    if anchor and anchor not in refs:
        refs.append(anchor)
        labels.append(f"场景基准图「{location}」")
    listing = ("；".join(f"参考图{i + 1}为{lb}" for i, lb in enumerate(labels))
               if labels else "")
    scene = await _distill_frame_prompt(script_ref, gen_prompt, location, labels)
    # 蒸馏失败 → 回退原口径（整镜截断），至少还能出图
    body = scene or f"{script_ref[:400]}"
    st = _style_of(project_id)
    prompt = (
        f"{st.frame_head}：{body}"
        f"{'。' + listing if listing else ''}"
        f"{'。人物外观、服装、发型与场景陈设必须与参考图完全一致，不得改变。' if labels else ''}"
        f"{'画面所处空间必须与场景基准图一致：陈设、材质、光线氛围保持统一，不得更换场景。' if anchor else ''}"
        # 不再说"静态画面/起始瞬间"——那是摆拍定格的根源。要的是"运动中被抓拍的一格"。
        "这一格是视频的第一帧，取自连续运动之中："
        "人物重心、视线与手部动作都有明确去向，身体不得静止摆拍、不得看镜头、不得居中海报式站位；"
        "构图完整、景别与角度明确、光线自然。"
        "禁止出现任何文字、水印、字幕、分镜框、拼图或多格画面。"
        # 与场景基准帧同理：正向的画风句（frame_head）必须配上同向的否定项，
        # 否则动漫档的首帧很容易出成实拍照。都市档由此比改动前多一句
        # 「禁止卡通、动漫、插画、3D 渲染风格」，同向收紧。
        + st.negative
        # 影调放最后：它是"整张图怎么调色"的全局声明。与资产图共用
        # `look_profile.phrase()` 的同一份档案与同一套字面 —— 资产图一套色、
        # 成片另一套色，才是用户看到的"不同图片色调不统一"。
        # 句尾自带边界声明（不改变本镜既有的日/夜与明暗光线情境）。
        + _look_line(project_id))
    return await _image_gen(prompt, aspect, image_model, refs, strict=strict)


def _resolve_project_video_model(proj) -> str | None:
    """解析项目级默认视频模型。

    2026-08 重构：production_mode 从"技术参数预设"改为"配音策略"（drama/narration），
    技术参数统一存入 default_profile JSON。
    旧值（fast/consistent/premium/first_frame/custom）在迁移期间通过
    _LEGACY_DEFAULTS 平滑读取。
    """
    if proj is None:
        return None
    if proj.default_profile:
        try:
            model = json.loads(proj.default_profile).get("video_model")
            if model:
                return model
        except (ValueError, AttributeError):
            pass
    # 旧数据兜底：production_mode 是旧预设值时从 _LEGACY_DEFAULTS 取
    from .routes_v2 import _LEGACY_DEFAULTS
    pm = proj.production_mode or ""
    return _LEGACY_DEFAULTS.get(pm, {}).get("video_model")


def _resolve_project_resolution(proj) -> str | None:
    """解析项目级默认分辨率档位（"480p"/"720p"/"1080p"/"2k"）。

    与 `_resolve_project_video_model` 同一套口径：**先读 `default_profile`**
    （新建向导把 video_model / image_model / generation_mode / resolution
    四项一起存在这里，不分模式），读不到再退 `_LEGACY_DEFAULTS`。

    ⚠️ 2026-09-10 修：此前这段逻辑内联在 `run_shot_videos` 里，且条件写成
    「production_mode 等于 custom 且 default_profile 非空」——
    只有旧的 custom 项目才读得到。可 2026-08 改版后 `production_mode` 已经变成
    **配音策略**（drama/narration/anime），没有一个新项目是 custom，
    于是**新建项目时选的分辨率对所有新项目一律无效**（proj_mp=None，
    实际下发由 Provider 自己定）。同一份 default_profile 里的 video_model
    却是全模式读的，两者口径不一致纯属遗漏。
    """
    if proj is None:
        return None
    if proj.default_profile:
        try:
            res = json.loads(proj.default_profile).get("resolution")
            if res:
                return str(res).lower()
        except (ValueError, AttributeError):
            pass
    from .routes_v2 import _LEGACY_DEFAULTS
    pm = proj.production_mode or ""
    res = _LEGACY_DEFAULTS.get(pm, {}).get("resolution")
    return str(res).lower() if res else None


async def run_shot_videos(jid: str, progress_cb=None, phase_jid: str | None = None,
                          parent_jid: str | None = None) -> None:
    """镜头批量生成视频（阶段④，R0 状态机版）。

    payload = {
      "project_id": "...",            # 必填
      "shot_ids": ["..."] | null,     # 优先：按镜头 id 选择（契约 C2）
      "orders": [1,2,3] | null,       # 兼容旧口径
      "model_id": null,               # 显式指定则覆盖策略链
      "resolution": null,             # 本次覆写分辨率档位（480p/720p/1080p/2k）；
                                      # **null = 沿用项目设置**，不要为了"沿用"下发具体值
      "aspect_ratio": null,           # 本次覆写画面比例；null = 沿用项目 base_aspect
      "prompt_prefix": "..."
    }
    每镜执行链：prompting(有框架则优化) → generating → 成功建 shot_version 置 review。
    模型选择按契约 C4：shot.profile_override > project.production_mode 映射 > settings。

    `phase_jid`：阶段标签写到哪个 job 上（默认自己）。一条龙把父 job id 传进来，
    好让用户在父任务上就看到"正在出首帧 32/170"，而不是盯着一个不可见的子 job。
    """
    from .config import get_settings
    from .prompt_opt import optimize_to_prompt_detailed, optimize_full

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    #: TB-05 生成变体：显式 seed 让同一条 prompt 出可复现的另一版画面。
    #: None（缺省）= Provider 自行随机化，这是常规生成的行为，不要改。
    batch_seed = p.get("seed")
    if batch_seed is not None:
        try:
            batch_seed = int(batch_seed)
        except (TypeError, ValueError):
            batch_seed = None

    # 项目级默认（C4 中层）：共用解析函数（预设映射 / default_profile）
    from .db import Project
    from .routes_v2 import RESOLUTION_TIERS
    with get_session() as session:
        proj = session.get(Project, project_id)
        mode_model = _resolve_project_video_model(proj)
        proj_resolution = _resolve_project_resolution(proj)
        proj_aspect = proj.base_aspect if proj else "9:16"
        proj_aspect_raw = proj_aspect
        # 首帧流水线（i2va）：项目 generation_mode=i2va 时启用两段式生成
        proj_gen_mode, proj_image_model = _resolve_project_gen_settings(proj)

    # ---- 本次覆写（一键成片「本次参数」/ 单独出片时的临时选择）----
    # payload 里给了就以它为准，没给（None）= 沿用项目设置。
    # ⚠️ 必须区分"没给"与"给了空值"：`p.get("resolution") or proj_resolution`
    # 这种写法会把显式的空串也当成没给，但更要命的是反过来——一旦前端为了
    # "沿用"而下发一个具体值（旧代码就是 width/height 兜底成 1080×1920），
    # 用户在项目里选的档位就被永久顶掉了。所以约定：**沿用就不要下发这个键**。
    batch_resolution = p.get("resolution")
    if batch_resolution:
        batch_resolution = str(batch_resolution).lower()
        if batch_resolution not in RESOLUTION_TIERS:
            log.warning("未知分辨率档位 %r（job=%s），忽略，沿用项目设置 %r",
                        batch_resolution, jid, proj_resolution)
            batch_resolution = None
    eff_resolution = batch_resolution or proj_resolution
    eff_aspect = p.get("aspect_ratio") or proj_aspect_raw
    #: 生效分辨率 → megapixels（镜头 override.megapixels 仍最优先，见 VideoRequest 处）
    proj_mp = RESOLUTION_TIERS.get(eff_resolution or "", None)
    proj_aspect = eff_aspect
    if batch_resolution or p.get("aspect_ratio"):
        log.info("job=%s 本次参数覆写：分辨率 %s→%s，画幅 %s→%s",
                 jid, proj_resolution, eff_resolution, proj_aspect_raw, eff_aspect)

    default_model = p.get("model_id") or mode_model or get_settings().video_model

    with get_session() as session:
        q = session.query(Shot).filter(Shot.project_id == project_id).order_by(Shot.order)
        shots = q.all()
        shot_ids = p.get("shot_ids")
        orders = p.get("orders")
        if shot_ids:
            shots = [s for s in shots if s.id in set(shot_ids)]
        elif orders:
            shots = [s for s in shots if s.order in set(orders)]
        else:
            shots = [s for s in shots if not s.video_url]  # 默认只补未生成的
        # 归一后镜头轨承载外部素材（is_special：已自带成片）与停用镜头，二者都不该送去生成。
        # 显式点选（shot_ids/orders）时同样过滤，避免误触发对片头/片尾重跑。
        shots = [s for s in shots if not s.disabled and not s.is_special]
        plan = [(s.id, s.order, s.script_ref, s.profile_override, s.duration_sec)
                for s in shots]

    if not plan:
        _update(jid, status="done", progress=100,
                result=json.dumps({"shots": [], "note": "没有待生成的镜头"}, ensure_ascii=False))
        return

    _update(jid, status="running")
    # 场景描述就地补齐（幂等，全都有描述时零调用）。出片是最后一道关口——
    # 项目可能是先前建的、资产图早就出好了，此时 Asset.prompt 仍为空，
    # 优化器会每镜自行发明陈设。补在这里保证老项目重跑也能拿到空间依据。
    # ⚠️ 不传 p["model_id"]：本 job 的 model_id 是**视频**模型覆盖值，
    # 而 ensure_scene_descriptions 要的是文本模型 id，传进去会拿去调 LLM。
    await ensure_scene_descriptions(project_id)
    prefix = p.get("prompt_prefix") or ""
    results: list[dict] = []
    done_count = 0
    lock = asyncio.Lock()  # 保护 results/进度写入

    # ---- 阶段可见 ----
    # i2va 批量出片实际是两段：整批先出首帧（生图无并发上限，170 张一起冲），
    # 出完才逐镜提交视频。头几分钟"已出片 0/170"是**正常**的，不是卡死。
    # 预估有多少镜要出首帧：镜头 override 优先，其次项目 gen_mode；
    # 已有 first_frame_url 的不算（`_run_one` 里 want_first_frame 同口径）。
    def _wants_frame(override_raw: str | None) -> bool:
        try:
            ov = json.loads(override_raw) if override_raw else {}
        except ValueError:
            ov = {}
        return ((ov.get("generation_mode") or proj_gen_mode) == "i2va"
                and not ov.get("first_frame_url"))

    frames_total = sum(1 for (_s, _o, _r, ov, _d) in plan if _wants_frame(ov))
    frames_done = 0
    ph_jid = phase_jid or jid

    def _phase() -> dict:
        """首帧未出齐 → 报首帧阶段；否则报出片阶段。

        两段其实是重叠的（某镜首帧一出就直接排队生视频），所以两组计数都带上，
        前端要展开细节时不必再算一次。
        """
        in_frames = frames_total > 0 and frames_done < frames_total
        return {
            "key": "frames" if in_frames else "videos",
            "label": "正在出首帧" if in_frames else "正在出片",
            "done": frames_done if in_frames else done_count,
            "total": frames_total if in_frames else len(plan),
            "frames_done": frames_done, "frames_total": frames_total,
            "videos_done": done_count, "videos_total": len(plan),
        }

    async def _report() -> None:
        # 有首帧阶段时进度按 4:6 分配——否则前 40% 的时间进度条纹丝不动，
        # 用户唯一能得到的信号就是"像死了"
        if frames_total:
            pct = int(40 * frames_done / frames_total + 60 * done_count / len(plan))
        else:
            pct = int(done_count / len(plan) * 100)
        set_job_phase(ph_jid, _phase())
        _update(jid, progress=pct,
                result=json.dumps({"shots": sorted(results, key=lambda r: r["order"])},
                                  ensure_ascii=False))
        if progress_cb:
            progress_cb(pct)

    async def _frame_stage_done() -> None:
        """某镜的首帧环节收场（成功/失败/因模型不支持跳过都算），推进阶段进度。"""
        nonlocal frames_done
        async with lock:
            frames_done += 1
            await _report()

    if frames_total:
        set_job_phase(ph_jid, _phase())
        _update(jid, progress=0)

    async def _run_one(sid: str, order: int, script_ref: str,
                       override_raw: str | None, ai_duration: float | None) -> None:
        """单镜全流程：提示词 → 并发池内生成（失败自动重试，重试释放槽再排队）。"""
        nonlocal done_count
        # 取消检查点：不硬杀协程，但不再为**这一镜**发起上游请求。
        # gather 已把所有镜头派发出去了，逐个在入口自行退出是唯一能省钱的粒度。
        #
        # 必须同时看 parent_jid：一键成片为每段新建独立子 job，
        # 用户在 UI 上取消的是**父** job，只查 jid 的话取消传不到正在跑的子任务，
        # 170 个镜头会照样烧完。
        if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
            return
        from .config import get_settings
        s = get_settings()
        # ---- C4 合并：镜头 override 最高优先 ----
        override = json.loads(override_raw) if override_raw else {}
        model_id = override.get("model_id") or default_model
        provider = registry.get_video(model_id)
        if provider is None:
            _set_shot_status(sid, "failed", f"未注册的视频模型: {model_id}")
            # 这镜也算过首帧预算（frames_total 是按 override/项目模式估的），
            # 不销账首帧阶段永远差一格、进度条卡在 39% 不动
            if _wants_frame(override_raw):
                await _frame_stage_done()
            async with lock:
                results.append({"order": order, "error": f"未注册的视频模型: {model_id}"})
                done_count += 1
                await _report()
            return

        raw_prompt = override.get("prompt") or (f"{prefix}{script_ref}" if prefix else script_ref)

        # ---- prompting（池外做：不占生成并发槽）----
        _set_shot_status(sid, "prompting")
        from .providers.base import infer_generation_mode
        explicit_refs = override.get("ref_urls") or []
        injected_refs: list[str] = []
        injected_labels: list[str] = []
        injected_notes: list[str] = []

        # ---- 首帧流水线（i2va）：资产参考 → 图像模型出首帧 → 首帧生视频 ----
        # 镜头 override 的 generation_mode/first_frame_url 最优先（用户手选不覆盖）。
        shot_gen_mode = override.get("generation_mode") or proj_gen_mode
        first_frame = override.get("first_frame_url")
        used_first_frame_pipeline = False
        fallback_reason: str | None = None
        want_first_frame = (shot_gen_mode == "i2va" and not first_frame)

        # 注入张数：走首帧路线时按生图侧上限取（资产图是喂给图像模型的）；
        # 否则按视频模型自身的参考图能力取。
        # ⚠️ 不可用生图侧的张数去顶替视频模型的 max_reference_images——
        # 那会篡改视频通道能力值，污染全参考老路线。
        if not explicit_refs:
            inject_cap = (_FRAME_REF_LIMIT if want_first_frame
                          else getattr(provider, "max_reference_images", 0))
            # 参考位**全额**给定妆图/场景图。
            # 2026-09-11 之前这里会扣掉一位留给"上一镜尾帧"（尾帧接力），
            # 该设计已停用且不会再回来——理由与实测见
            # `docs/DECISION-2026-09-11-尾帧接力停用.md`（一句话：它挤掉一张定妆图，
            # 模型只把它当风格参考，而它作为"视频里渲染出来的人脸"必被 Seedance
            # 人脸审核拦下，实测注入尾帧的 8 镜 8/8 失败、未注入的 9 镜 9/9 通过）。
            injected_refs, injected_labels, injected_notes = \
                _auto_inject_refs_detailed(sid, inject_cap)
            # Seedance 会拦"疑似真人"的参考图（AI 定妆图也照拦）——
            # 换成已入库的 asset:// 可信资产即可过审。非 Seedance 通道原样返回。
            injected_refs = await _to_trusted_assets(sid, injected_refs, model_id)

        if want_first_frame:
            # 能力兜底：模型不支持 i2va（如 H3 未配首帧工作流）→ 不白烧生图钱，
            # 直接回退全参考路线并记录原因（meta 可查，不静默）。
            support = provider.mode_support().get("i2va", {})
            if not support.get("available", False):
                fallback_reason = support.get("reason") or f"{model_id} 不支持首帧输入"
                want_first_frame = False
                await _frame_stage_done()

        # 首尾帧/尾帧路线目前**只支持手动供图**（镜头高级设置里填首帧图+尾帧图）：
        # 自动流水线只会生成首帧，凑不齐两端。此时会按素材推断落到全参考，
        # 记录原因避免"以为在跑 fl2va 其实是全参考"。
        if shot_gen_mode in ("fl2va", "l2va") and not fallback_reason:
            need = ("首帧图与尾帧图" if shot_gen_mode == "fl2va" else "尾帧图")
            have_ff = bool(first_frame)
            have_lf = bool(override.get("last_frame_url"))
            if not (have_lf and (have_ff or shot_gen_mode == "l2va")):
                fallback_reason = (
                    f"生成模式 {shot_gen_mode} 需要手动提供{need}"
                    f"（镜头高级设置内填写），自动流水线暂不产出尾帧，已按素材回退")

        if want_first_frame:
            refs_for_frame = explicit_refs or injected_refs
            labels_for_frame = injected_labels if not explicit_refs else []
            with get_session() as _s:
                _sh = _s.get(Shot, sid)
                _ep, _loc = (_sh.episode, _sh.location) if _sh else (1, None)
                _pregen = _sh.gen_prompt if _sh else None
            first_frame = await _gen_first_frame(
                project_id, _ep, _loc, raw_prompt, refs_for_frame, labels_for_frame,
                override.get("aspect_ratio") or proj_aspect,
                override.get("image_model") or proj_image_model,
                gen_prompt=_pregen)
            if first_frame:
                used_first_frame_pipeline = True
                _set_shot_first_frame(sid, first_frame)
            else:
                fallback_reason = "首帧生成失败，已回退全参考"
            # 首帧失败 → first_frame 为 None，下方自动回退全参考/纯文本路线
            await _frame_stage_done()

        vreq = VideoRequest(
            prompt=raw_prompt,
            generation_mode=override.get("generation_mode")
                if override.get("generation_mode") else
                ("i2va" if used_first_frame_pipeline else None),
            first_frame_url=first_frame,
            last_frame_url=override.get("last_frame_url"),
            # 首帧流水线：参考图已固化进首帧，不再重复下发（部分模型 i2va 与
            # reference 互斥；一致性由首帧图承载）
            reference_image_urls=([] if used_first_frame_pipeline
                                  else (explicit_refs or injected_refs)),
            reference_audio_url=override.get("reference_audio_url"),
            duration_ms=override.get("duration_ms")
                or (int(ai_duration * 1000) if ai_duration else None),
            aspect_ratio=override.get("aspect_ratio") or proj_aspect,
            megapixels=override.get("megapixels") if override.get("megapixels") is not None else proj_mp,
            # TB-05 生成变体：payload 显式给 seed 时用它，否则镜头级 override，
            # 再否则 None（Provider 自行随机化 —— 不随机的话同 prompt 永远同一结果）。
            seed=batch_seed if batch_seed is not None else override.get("seed"),
        )
        gen_mode = infer_generation_mode(vreq)
        # ---- 角色音色注入（在 gen_mode 之后，且**不参与** gen_mode 推断）----
        # 顺序是有意的：音色只能改音色。放在推断之前的话，一个纯文本镜头会只因
        # 主角有音色就从 t2va 变成 full_reference，连带换掉提示词框架与工作流路由。
        # （infer_generation_mode 里也去掉了音频那一支，两处一致。）
        voice_note: dict | None = None
        if not vreq.reference_audio_url:      # 镜头 override 显式给了就不抢
            audio_ok = bool(provider.mode_support().get(gen_mode, {})
                            .get("reference_audio", False))
            v_url, v_label, v_skip = _auto_inject_voice_ref(sid)
            if v_url and audio_ok:
                vreq.reference_audio_url = v_url
                voice_note = {"url": v_url, "label": v_label}
            elif v_url:
                # 有音色但这个通道/模式吃不下 → 明确记原因。能力判定一律以
                # mode_support() 为准：base 的默认字典里根本没有 reference_audio
                # 这个键，取不到就是不支持（保守默认，绝不猜）。
                voice_note = {"skipped": f"{model_id} 在 {gen_mode} 模式下不支持参考音频",
                              "label": v_label}
            elif v_skip:
                voice_note = {"skipped": v_skip}
        ctx, brief, shot_chars = await _build_prompt_ctx(
            sid, project_id, model_id,
            gen_mode=gen_mode,
            duration_ms=vreq.duration_ms,
            used_first_frame=used_first_frame_pipeline,
            ref_count=len(vreq.reference_image_urls or []),
            injected_labels=injected_labels,
            injected_notes=injected_notes,
            explicit_refs=bool(explicit_refs))
        with get_session() as session:
            _shot = session.get(Shot, sid)
            pregen = _shot.gen_prompt if _shot else None
            stale_reason = _shot.stale_reason if _shot else None
            shot_is_stale = bool(_shot.stale) if _shot else False
        if shot_is_stale and stale_mod.needs_prompt_rebuild(stale_reason):
            # ⚠️ P2-15：这镜之所以过期，病因**就是** gen_prompt 基于旧拆解
            # （改了集正文 / 改了本镜 script_ref / 旁白拆段改写了 script_ref）。
            # 拿它当优化基线 = 把病因当药：用户改完剧本点「重新生成」，片子重出了、
            # 内容还是旧的，全程零报错——因为新的 script_ref 一个字都没进模型。
            # 丢掉它，下面自然走 `pregen or raw_prompt` 的 raw_prompt 分支
            # （raw_prompt 就是当前 script_ref），也不再命中"纯文生视频直接用
            # 预生成稿"的快路径。regen（只是时长变了）不受影响，照用旧稿。
            log.info("[shot %s] stale=%s，弃用旧 gen_prompt，从 script_ref 重新优化",
                     order, stale_reason or "unknown")
            pregen = None
        opt_fallback: str | None = None   # 提示词优化降级原因（None=正常优化）
        if override.get("prompt"):
            final_prompt = override["prompt"]
        elif pregen and not vreq.reference_image_urls and not used_first_frame_pipeline:
            # 纯文生视频：没有参考图也没有首帧，ctx 里没有任何"必须与图对齐"的
            # 信息，预生成稿直接可用。
            final_prompt = pregen
        else:
            # 有参考图 / 走首帧流水线 → **必须**带 ctx 重新优化一次。
            #
            # ⚠️ 这里曾经写成"只有 seedance 有注入图时才重优化"，于是海螺 H3
            # 全能参考（「⚡ 快速验证」预设的默认路线）走的是 final_prompt = pregen：
            # 上面精心组装的参考图身份清单、各图实际造型、服装锚定硬约束、人物档案
            # **一条都没送到模型**。而 pregen 是拆解当时写的——那时资产还没生成，
            # 它只能凭剧本猜服装、猜性别。实测后果：女主换了衣服、女配穿上女主的
            # 衣服（B4），女主被写成 he/a man（B3）。参考图是全能参考路线**唯一**
            # 的一致性来源，提示词与它打架就等于把这条路线关掉。
            final_prompt, opt_fallback, blocking = await optimize_full(
                pregen or raw_prompt, video_model_id=model_id,
                extra_context="; ".join(ctx))
            # 3.9 走位台账：同一次调用顺带产出的"本镜结尾谁在哪"，落库供
            # **下一个连续镜头**当开场硬约束（见 _scene_run_ctx 第 4 段）。
            # 抽不到就不写，下一镜退回原来的通用位置约束，不影响本镜出片。
            _save_blocking(sid, blocking)
            if opt_fallback:
                # 降级 = 上面组装的参考图造型/人物档案/服装锚定一条都没生效。
                # 表面症状只是"提示词又跟资产图对不上"，必须留痕才查得出来。
                log.warning("[shot %s] 提示词优化降级：%s", order, opt_fallback)
            # 人称自检：与人物档案冲突（全女阵容却出现 he/man）时按档案重写一次。
            # 只做一轮，失败也不阻断生成——宁可出片也不要卡住整批。
            if brief and shot_chars:
                from .character_brief import (fix_pronoun_instruction,
                                              pronoun_conflict)
                conflict = pronoun_conflict(final_prompt, brief, shot_chars)
                if conflict:
                    log.warning("[shot %s] 人称冲突，重写提示词：%s", order, conflict)
                    final_prompt, _fb2 = await optimize_to_prompt_detailed(
                        final_prompt, video_model_id=model_id,
                        extra_context="; ".join(
                            ctx + [fix_pronoun_instruction(conflict)]))
                    if _fb2:
                        opt_fallback = f"人称重写时{_fb2}"
                        log.warning("[shot %s] 人称重写降级：%s", order, _fb2)
            # 最终稿写回 gen_prompt：镜头卡「✨ 提示词」即所见即所发（含 @图片N 引用）
            if final_prompt and final_prompt != pregen:
                with get_session() as session:
                    _shot2 = session.get(Shot, sid)
                    if _shot2:
                        _shot2.gen_prompt = final_prompt
                        _shot2.prompt_state = "sent"
                        session.commit()
        vreq.prompt = final_prompt

        # ---- generating：并发池内提交，失败自动重试 ----
        last_err = "生成失败"
        for attempt in range(1 + max(0, s.video_retries)):
            if attempt:  # 重试退避（在池外等待，不占槽）
                await asyncio.sleep(min(60.0, s.video_retry_backoff * (2 ** (attempt - 1))))
            async with _video_pool():  # 池满→在此排队；上一批任一任务结束即放行
                # ⚠️ 拿到槽位后**再查一次**取消。
                # 函数入口那次检查形同虚设：gather 一次性派发全部协程，
                # 它们在第一轮事件循环里就都通过了入口检查，然后堵在这个
                # 信号量上排队几分钟到几十分钟。用户的取消几乎必然发生在
                # 那之后 —— 不在这里补一次，排队中的镜头照样会全部提交、全部计费。
                if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
                    return
                _set_shot_status(sid, "generating")
                try:
                    res = await provider.submit(vreq)
                except Exception as e:  # noqa: BLE001
                    last_err = repr(e)
                    continue  # 释放槽 → 退避 → 重新排队重试
            if res.status == "done" and res.video_url:
                meta = dict(res.raw or {})
                if injected_refs:
                    meta["injected_refs"] = injected_refs
                if voice_note:
                    # 音色是"听得见但看不见"的东西：不落 meta 的话，用户问
                    # "我传的音色到底用没用上"就只能靠耳朵猜。用上了记 url+是谁，
                    # 没用上记为什么没用上，两种情况都不许静默。
                    meta["voice_ref"] = voice_note
                if used_first_frame_pipeline:
                    meta["first_frame_url"] = first_frame  # 首帧流水线溯源（版本 meta 可查）
                if fallback_reason:
                    # 想走首帧/首尾帧但没走成 → 记录原因，避免"以为在跑X其实是全参考"
                    meta["mode_fallback"] = fallback_reason
                    meta["first_frame_fallback"] = fallback_reason  # 兼容既有版本记录字段
                if opt_fallback:
                    # 提示词优化没跑成 → 这一版用的是未经资产对齐的原稿
                    meta["prompt_opt_fallback"] = opt_fallback
                if attempt:
                    meta["retries"] = attempt
                # TB-05：显式 seed 记进版本 meta，"生成变体"才可复现/可对比。
                # Provider 自选的 seed 通常已在 res.raw 里，不覆盖它。
                if batch_seed is not None:
                    meta.setdefault("seed", batch_seed)
                    meta["seed_source"] = "explicit"
                # P1-1：抽首帧供轨道/列表用 <img> 渲染。失败只是没缩略图，不影响出片，
                # 所以不放进 try 之外的失败分支，也不因它重试。
                from .media import make_thumb, probe_duration_local
                thumb_url = await make_thumb(res.video_url)
                # 出片时长回检：此前**没有任何环节**把成片的真实时长与计划时长
                # （Shot.duration_sec，拆镜按台词/旁白算出来的）比对过，于是
                # "通道少给了一截"这件事可以一路静默到成片——2026-09-04 的真人剧
                # 验证片就是这么烂的：17 镜计划 16~29s、实际全是 15.07s，32 条字幕
                # 落在视频结束之后，零报错。根因是 seedance provider 写死 min(15)
                # （已修，见 7c60e45），但**根因修了不等于这一类问题不会再来**：
                # 任何通道、任何原因少给时长，这里都该看得见。
                #
                # 只记录、不自动纠正：短了的正解是"重新生成更长的一版"，而不是
                # 把计划时长改小去迁就成片——后者会把台词/旁白挤出画面，且看起来
                # 一切正常。真相是"画面不够长"，就如实记成"画面不够长"。
                actual_sec = await probe_duration_local(res.video_url)
                sync_to: float | None = None
                if actual_sec > 0:
                    meta["actual_sec"] = round(actual_sec, 3)
                    planned = float(ai_duration or 0)
                    if planned > 0 and (planned - actual_sec) > max(0.5, planned * 0.05):
                        meta["duration_short"] = {"planned": round(planned, 3),
                                                  "actual": round(actual_sec, 3)}
                        log.warning(
                            "第 %s 镜出片时长不足：计划 %.2fs，实际 %.2fs（通道 %s）",
                            order, planned, actual_sec, model_id)
                    if getattr(provider, "audio_mode", None) == AudioMode.inline:
                        # 音画一体的通道（seedance 等）：**成片文件就是完整成品**
                        # ——画面和声音都在里面，没有第二条轨去定义"这一镜该多长"。
                        # 所以时间轴长度应当等于文件长度，不多不少。
                        #
                        # 不这么做的代价是双向的，而且**两边都是静默的**
                        # （2026-09-06 真人剧 29/29 镜全部命中）：
                        #   · 计划 > 实际 → 导出取 `clip_dur_sec ?? duration_sec`
                        #     （adapters/shotToClip.ts、render/normalize.ts 同口径），
                        #     多出来的部分是定格帧 + 静音，最多 0.44s
                        #   · 计划 < 实际 → 尾巴被裁掉，裁的是台词的最后半个字，
                        #     最多 0.6s
                        # 差值的来源是结构性的：下发给通道的是 int(round(计划))，
                        # 回来的片子又比下发值多出零点几秒的编码尾巴，
                        # 所以「计划」和「实际」本来就不可能相等。
                        #
                        # ⚠️ 这不会把"通道少给了一大截"糊过去：真正的缺斤短两由上面
                        # 那个 duration_short 分支拦下并 warning，时间轴如实缩到
                        # 实际长度只是不再假装有那么多画面——该重生成还是要重生成。
                        #
                        # ⚠️ 只对 inline 通道：解说剧（H3 + 独立 TTS 轨）的镜头长度
                        # 由旁白定（_sync_shot_duration），画面多出来的尾巴本就该裁，
                        # 在这里跟着画面走会在旁白结束后留一段静场。
                        if abs(actual_sec - (ai_duration or 0)) > 0.02:
                            sync_to = round(actual_sec, 3)
                vno = _save_shot_version(sid, res.video_url, model_id, final_prompt, meta,
                                         thumb_url=thumb_url)
                with get_session() as session:
                    shot = session.get(Shot, sid)
                    if shot:
                        shot.video_url = res.video_url
                        # 3.1：素材换了，旧的取片窗口（相对旧 video_url 的坐标）
                        # 就指向了另一段内容——不清会静默导出黑帧，见 db.py。
                        reset_clip_window(shot)
                        shot.thumb_url = thumb_url
                        # 生成即默认采用（用户决策：删「采用」按钮；切换版本=采用该版本）
                        shot.status = "adopted"
                        shot.adopted_version = vno
                        if sync_to:
                            # clip_dur_sec 为 None = 没有手工取片窗口，导出直接用
                            # duration_sec；此时同步它即可。用户自己设过窗口就别动，
                            # 那是明确的剪辑意图，不该被一次重生成覆盖掉。
                            if shot.clip_dur_sec is None and shot.clip_in_sec is None:
                                shot.duration_sec = sync_to
                        # P1-2：本次生成已按最新注入集合出片 → 清「参考图已变」标记
                        shot.refs_stale = 0
                        # P2-15：`stale` 以前**从没人清过**——重出片能治好的过期
                        # （regen：时长变了；reprompt：提示词已在上面按新 script_ref
                        # 重建过）出完片旗标还挂着，用户永远看着一个洗不掉的「已过期」。
                        # rebreak 与老数据(NULL)不清：切分本身是错的，出多少次片都没用。
                        if stale_mod.clears_on_regen(shot.stale_reason):
                            stale_mod.clear_stale(shot)
                        session.commit()
                async with lock:
                    results.append({"order": order, "video_url": res.video_url,
                                    "version_no": vno, "retries": attempt})
                    done_count += 1
                    await _report()
                return
            last_err = res.error or "生成失败"
        # 重试次数用尽
        _set_shot_status(sid, "failed", str(last_err))
        async with lock:
            results.append({"order": order, "error": str(last_err)[:300]})
            done_count += 1
            await _report()

    # 并发派发全部镜头（全局池控总并发；本 job 不设自身上限）
    await asyncio.gather(*(
        _run_one(sid, order, ref, ov, dur) for sid, order, ref, ov, dur in plan
    ))

    failed = [r for r in results if "error" in r]
    # 用户取消不是失败。⚠️ 这里**不能**照 run_asset_batch 那样按条目文案判断：
    # 本函数的取消检查点是裸 `return`（不往 results 记条目），被取消的镜头
    # 根本不出现在 results 里 —— 于是 failed=0、判定 done，用户取消了 170 镜
    # 却在任务中心看到一个绿勾。直接查状态位才是准的。
    if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
        skipped = len(plan) - len(results)
        _update(jid, status="cancelled",
                error=f"已取消（{skipped} 镜未生成）" if skipped else "已取消")
        return
    _update(
        jid,
        status="failed" if len(failed) == len(plan) else "done",
        # error 是给用户看的，必须短；全量明细在 result 里（可排查）。
        error=_brief_errors(failed) if failed else None,
    )


def _scene_desc_text(sid: str) -> tuple[str, str]:
    """本镜场景的文字设定（`Asset(kind="location").prompt`）。

    返回 `(场景名, 描述)`；查不到描述时描述为空串。描述由 `scene_desc.py` 产出，
    出图/出片链路已在入口处 `ensure_scene_descriptions` 幂等补齐。

    场景名返回**归一名**：资产按归一名存，描述也按归一名产出，这里再报原名
    会让提示词里的场景名与参考图标注对不上（同一个房间两种叫法）。
    """
    from .scenes import canonical_of, location_asset
    with get_session() as s:
        cur = s.get(Shot, sid)
        loc = (cur.location or "").strip() if cur else ""
        if not loc:
            return "", ""
        name = canonical_of(s, cur.project_id, loc) or loc
        a = location_asset(s, cur.project_id, loc)
        return name, strip_auto(a.prompt) if a and a.prompt else ""


#: 前情剧本喂给优化器的字数上限（取尾部——离本镜最近的才决定人此刻在哪）。
_RUN_RECAP_CAP = 700
#: 本场首镜提示词的引用上限。只要它里面的空间与陈设描写，不需要整篇。
_RUN_ANCHOR_CAP = 500


def _scene_run_ctx(sid: str) -> list[str]:
    """同场连续戏的**空间与走位延续**约束（修「同场景内桌子外观/人物位置多次偏移」）。

    ## 问题

    实测项目「912」前 6 镜同属场景「半岛酒店顶楼餐厅」、2-6 镜全标
    `link_to_prev="continuous"`，注入的场景参考图也是同一张，但每镜的提示词
    各自把这个空间重新描述了一遍：

        镜3「豪华高档的豪门会客室」+「大理石茶几」
        镜4「璀璨水晶吊灯」
        镜5「高档餐厅包厢内」

    连**房间类型和场景名**都换了，桌子自然一镜一个样。人物位置关系同理：
    镜1「三人对坐餐桌」，镜3 变成「陆沉在大理石茶几一侧、林语与林母在另一侧」。

    根因是每镜的提示词优化都是**独立**的一次调用：它只看得见本镜原稿，
    不知道自己处在一场连续戏的中间，也不知道前面几镜把这个空间写成了什么样。
    参考图管不住这件事——图只钳制"长什么样"，文字一旦把餐厅说成会客室，
    模型按文字走。

    ## 做法

    纯 DB 推导，不额外花任何调用：
      1. 从本镜往前后走出**连续同场景段**（判据在 `continuity.continuous_runs`，
         3.9 起两个调用方共用那一份），据此告诉优化器"本镜是第 k/n 镜，未换景"；
      2. 把段内**本镜之前**的剧本原文（尾部 `_RUN_RECAP_CAP` 字）作为前情，
         让它能推断人此刻坐在哪、站在哪，而不是重新安排走位；
      3. 段首镜已有提示词时把它的空间描写附上——全段都锚到**同一份**文字，
         而不是一镜接一镜地漂。段首自己不引用自己；
      4. **上一镜的走位台账**（3.9）：`blocking_out` 有值时，把"上一镜结束时
         谁在哪、什么姿态、朝哪"逐条写出来，要求本镜开场与之一致。

    ## 第 4 条为什么是必需的，而不是第 1-3 条的锦上添花

    第 1 条那句「人物的座次、站位、朝向与距离延续上一镜结尾」在 3.9 之前
    就已经存在了，用户实测**依然跳变**。原因是它是一句**没有事实支撑的空话**：
      · 通用约束句本身不含任何位置信息；
      · `recap` 是剧本原文，而剧本几乎从不写走位（"林母叹了口气"里没有位置）；
      · `anchor` 是**段首**的提示词，到第 5 镜时早就失真了。
    而当时另有一条「尾帧接力」（把上一镜尾帧当参考图注入）也试图解决它，
    同样无效：作为众多参考图之一，它的权重被定妆图稀释，模型只当它是风格
    参考、不当位置约束。该设计已于 2026-09-11 停用（见
    `docs/DECISION-2026-09-11-尾帧接力停用.md`），**走位台账是它留下的唯一正解**。

    位置必须是**可传递的显式状态**，这就是台账存在的理由。

    返回 ctx 段落列表；本镜不在任何连续段里（独立镜/转场）时返回 `[]`——
    那种情况下重新设定空间是正常的，不该加约束。
    """
    from .continuity import continuous_runs, parse_blocking, blocking_text
    with get_session() as s:
        cur = s.get(Shot, sid)
        if not cur or not (cur.location or "").strip():
            return []
        run = next((r for r in continuous_runs(s, cur.project_id)
                    if any(x.id == cur.id for x in r)), None)
        if not run or len(run) < 2:
            return []          # 单镜成段：不构成"同场连续戏"
        idx = next(i for i, r in enumerate(run) if r.id == cur.id)

        k, n = idx + 1, len(run)
        loc_name = (cur.location or "").strip()
        out = [
            f"【同场连续戏】本镜与前后共 {n} 个镜头同属场景「{loc_name}」，"
            f"本镜是其中第 {k} 镜，**中途没有换景**。因此：\n"
            f"1. 空间类型与场景名必须始终是「{loc_name}」，"
            f"严禁改写成别的房间（如把餐厅写成会客室、客厅、包厢或大堂）；\n"
            f"2. 家具的种类、外观、材质、颜色与摆放位置在全段内完全一致"
            f"（同一张桌子不能一镜是餐桌、下一镜变成大理石茶几），"
            f"灯具、窗户、墙面与光线方向同理；\n"
            f"3. 人物的座次、站位、彼此的朝向与距离延续上一镜结尾，"
            f"不得重新安排走位；本镜只描述**发生了变化**的动作与表情；\n"
            f"4. 不得新增本段前面没有出现过的陈设或装饰。",
        ]
        # 上一镜的走位台账：本模块里唯一带**事实**的一段
        if idx > 0:
            prev = run[idx - 1]
            btxt = blocking_text(parse_blocking(prev.blocking_out))
            if btxt:
                out.append(
                    f"【上一镜（#{prev.order}）结束时的人物位置】以下是硬事实，"
                    f"本镜**开场画面必须与之完全一致**：\n{btxt}\n"
                    f"本镜只描述在此基础上**发生了变化**的位置与姿态；"
                    f"没有提到变化的角色一律保持原位、原朝向，"
                    f"**不得**重新安排座次或走位，**不得**让其中任何人消失或离场。")
        recap = "".join((r.script_ref or "") for r in run[:idx]).strip()
        if recap:
            out.append(
                "本场戏在本镜之前已经发生的剧本内容（仅用于推断人物此刻的位置、"
                "姿态与状态，**不要**在本镜里重复表演一遍）：\n"
                + recap[-_RUN_RECAP_CAP:])
        anchor = run[0]
        if anchor.id != cur.id and (anchor.gen_prompt or "").strip():
            out.append(
                f"本场戏首镜（#{anchor.order}）已确立的画面设定如下，"
                f"本镜的空间与陈设描写必须与之一致（与本镜原稿冲突时以此为准）：\n"
                + (anchor.gen_prompt or "").strip()[:_RUN_ANCHOR_CAP])
        return out


def _auto_inject_refs(sid: str, max_refs: int) -> tuple[list[str], list[str]]:
    """定妆图自动注入（契约 C6）。完整说明见 _auto_inject_refs_detailed。

    薄壳：只取 (urls, labels)，给不需要造型描述的调用方（首帧生成等）用。
    """
    urls, labels, _ = _auto_inject_refs_detailed(sid, max_refs)
    return urls, labels


def _auto_inject_refs_detailed(
        sid: str, max_refs: int) -> tuple[list[str], list[str], list[str]]:
    """定妆图自动注入（契约 C6）：按镜头所属集取出场角色的阶段定妆图。

    返回 (urls, labels, notes)：labels 与 urls 一一对应（如 "角色「林晚」"/"场景「茶楼」"），
    供 Seedance @图片N 引用映射（图片顺序 = images 数组顺序 = @编号）。
    notes 是**被选中那张图里人物到底穿什么**（AssetStage.description），
    与 urls 同序：参考图只钳制长相，服装是否照抄取决于提示词怎么写；提示词里
    没有这份描述时优化器会凭空发明服装（实测：女主的浅米色风衣被写成
    "sleek dark dress"，女配反而穿上了女主的衣服）。有了 notes 才能在优化时
    要求"与参考图逐件对齐"。无描述可用的图对应空串（保持与 urls 同序）。
    仅在镜头无显式 ref_urls override 且模型支持参考图时调用。
    每角色 1 张，超模型上限按出场顺序截断。
    P1-2：角色集合走 effective_characters()（= (拆解真值 ∪ 人工add) − 人工remove），
    与资产轨渲染同一契约，保证「轨道显示的覆盖 = 实际注入」。
    P1-3：角色图之后补注场景参考图（effective_locations → Asset(kind=location)），
    角色优先占位（一致性权重更高），场景在余量内补位。
    2026-09-09：场景侧改为从该场景的**多视角参考图集**（`scene_view`，8 张）里
    挑一张——镜头文本认出景别就用那一档，否则用主视角全景，取不到再兜底
    `Asset.image_url`（老项目只有那一张）。**仍然只占一个参考位**。

    注入规则（修「资产页有图却注入不到」+「确认无意义」）：
    1. 不再过滤 `status=="confirmed"`——用户把图生成/上传到某阶段即视为选定该图，
       不该再多一道确认。status 仅留作资产页的人工标记，不影响注入。
    2. 阶段无图（或本镜不在阶段的 shot 精修区间内）时，**回退角色通用定妆图**
       `Asset(kind="character").image_url`。此前只认 AssetStage，导致资产页
       明明每个角色都有图、注入时却一张都取不到（首帧退化成纯文生图）。
       优先级：命中本镜的镜头级变体阶段 > 命中集区间的基础阶段图 > 角色通用图。
    3. 阶段挑选必须**先按特异性排序，再取第一条**（修一个真实 bug）：
       原实现是 `.order_by(ep_from).first()`，一旦某角色在同一集里既有基础阶段
       又有镜头级服装变体（如「丝绸睡裙」只覆盖 #12-#18），`.first()` 可能先拿到
       变体那条；随后发现本镜不在变体的 shot 区间内就把 st 置成 None，直接跌到
       角色通用图，**基础阶段图被整条跳过**。结果：明明有该集的基础定妆图，
       注入的却是通用图（丢造型区分），或者干脆没有图。
       现在改为：候选里优先选 shot 区间命中本镜的（越窄越优先），
       其次选没有 shot 区间限制的基础阶段。
    4. **场景绑定服装（"同一场景下同一人物服装相同"）自成一档**，且**不看集区间**：
       第 1 集在卧室穿的白色睡衣（`scene_bound=1` + `location=归一卧室名`），
       第 10 集镜头又回到同一个归一场景、剧本没另写衣着时，注入的是**同一张图**。
       跨多少集都成立（用户确认："沿用，除非剧本另写"）——剧本另写时那是明写镜号
       的变体，档位更高，自然压过本档。
       事件型服装（`scene_bound=0`，如婚纱@教堂）不进本档，只在自己的镜号区间/
       集区间内生效，人物再进教堂不会因此又穿上婚纱。
    5. **指针行解析到源阶段的图**（`source_stage_id`，见 db.AssetStage）：同一件衣服
       在相隔很远的两段镜头各出现一次时，后一段是指针行、自身无图，注入时取源那张，
       保证同一件衣服全剧只有一个样子、也只花一次生图钱。
    """
    from . import asset_gate
    from .costumes import resolve_stage_image
    from .db import Asset, AssetStage, effective_characters
    from .scene_view import pick_for_shot as sv_pick_for_shot
    from .scenes import canonical_locations, canonical_of
    if max_refs < 1:
        return [], [], []
    with get_session() as session:
        shot = session.get(Shot, sid)
        if not shot:
            return [], [], []
        chars = effective_characters(shot)
        # 归一名：场景资产按归一名存，拿原名「夜 内 楚家公馆-客厅」去查是查不到的
        locs = canonical_locations(session, shot.project_id, shot)
        # 用户删掉的资产**在这里断链**（需求 4「删掉的不该再被调用」）。
        # 注意只从**参考图集合**里剔除，镜头本身的 characters / location 一个字
        # 不改（用户决策「只断资产链，不动剧本」）——这一镜照样有这个角色、
        # 照样发生在这个场景，只是不再给模型那张参考图。
        _gone = asset_gate.deleted_names(session, shot.project_id)
        if _gone:
            chars = [c for c in chars if c not in _gone]
            locs = [x for x in locs if x not in _gone]
        if not chars and not locs:
            return [], [], []
        # 本镜所在的**归一场景**：服装继承的判据。用原名比对是错的
        # （同一个房间每集写法都不同，实测跨集复用率 0，见 db.SceneAlias）。
        shot_canon = canonical_of(session, shot.project_id, shot.location)
        urls: list[str] = []
        labels: list[str] = []
        notes: list[str] = []
        for c in chars:
            # 不再按集区间过滤 SQL：场景绑定服装必须**跨集**可见，
            # 过滤掉就等于把"第 10 集沿用第 1 集睡衣"这条规则关掉了。
            # 集区间的判断下沉到 _rank，只对基础阶段生效。
            # 墓碑阶段不参与候选（stage_gate）：用户删掉的造型不该再进画面。
            # 这是**花钱路径**上的过滤，漏了就等于删除功能不生效。
            from . import stage_gate
            cands = (stage_gate.alive(
                     session.query(AssetStage)
                     .filter(AssetStage.project_id == shot.project_id,
                             AssetStage.character_name == c))
                     .order_by(AssetStage.ep_from).all())
            # 图按指针行解析（自身无图的指针行取源阶段那张），解析不到的不参与排序
            imgs = {x.id: resolve_stage_image(session, x) for x in cands}
            cands = [x for x in cands if imgs.get(x.id)]

            def _rank(st: AssetStage) -> tuple[int, int]:
                lo, hi = st.shot_from, st.shot_to
                loc = (st.location or "").strip()
                in_ep = st.ep_from <= shot.episode <= st.ep_to
                has_shots = lo is not None or hi is not None
                miss_shots = ((lo is not None and shot.order < lo)
                              or (hi is not None and shot.order > hi))
                if has_shots and not miss_shots:
                    # ① 剧本明写、镜号命中本镜的变体：最强证据，越窄越具体
                    width = (hi - lo) if (lo is not None and hi is not None) else 10 ** 6
                    return (0, width)
                if st.scene_bound and loc and loc == shot_canon:
                    # ② 场景决定型服装 + 本镜就在这个归一场景：跨集沿用（不看 in_ep）
                    return (1, 0)
                if loc and loc == shot_canon and in_ep:
                    # ③ 事件型服装但场景与集都对得上：仍比通用基础造型贴切
                    return (2, 0)
                if not has_shots and not loc and in_ep:
                    return (3, 0)                       # ④ 基础阶段
                return (4, 0)                           # 对本镜不适用
            ranked = sorted(cands, key=_rank)
            st = next((x for x in ranked if _rank(x)[0] < 4), None)
            url = imgs.get(st.id) if st is not None else None
            # 标签：命中的**镜头级变体 / 场景绑定服装**把造型名带上
            # （"角色「白薇」（本镜造型：丝绸睡裙）"）。这类图必定是按它自己的
            # description 现生成的，图与名字不会打脸，写进提示词能显著加强
            # "这一镜就得穿这件"的锚定。基础阶段不带名字——它的图可能是从兜底占位
            # 继承来的通用图，带上造型名反而会误导模型。
            label = f"角色「{c}」"
            if st is not None and (st.stage_name or "").strip() and (
                    st.shot_from is not None or st.shot_to is not None
                    or (st.location or "").strip()):
                label = f"角色「{c}」（本镜造型：{st.stage_name}）"
            # 造型描述：这张图里人物到底穿什么。指针行自身可能没写描述，
            # 取源阶段的（同一件衣服，描述必然同源）。
            # strip_auto：去掉"〔自动识图〕"标记只留正文——标记是给 UI 区分
            # 人写/机器写的，喂给优化器纯属噪音。
            note = ""
            if st is not None:
                desc = strip_auto(st.description)
                if not desc and st.source_stage_id:
                    src = session.get(AssetStage, st.source_stage_id)
                    # 源被删掉了就别取它的描述——图已经不穿透墓碑
                    # （costumes.resolve_stage_image），描述再取就成了
                    # "文字说睡裙、参考图是别的造型"的自相矛盾。
                    desc = (strip_auto(src.description)
                            if src is not None and not src.deleted_at else "")
                if desc:
                    name = (st.stage_name or "").strip()
                    note = f"{name}：{desc}" if name else desc
            if url is None:
                ca = (session.query(Asset)
                      .filter(Asset.project_id == shot.project_id,
                              Asset.kind == "character", Asset.name == c,
                              Asset.image_url.isnot(None)).first())
                url = ca.image_url if ca else None
                # 回退到通用定妆图时，阶段描述描述的不是这张图，不能拿来当依据；
                # 改用该图自己的 prompt（AI 生图的原始提示词，或上传后视觉反推的造型）。
                # ⚠️ 不做任何字数硬截断：从中间斩断会把"脚穿黑色皮鞋"这类锚点截没，
                # 长度控制在 vision_desc 的提示词里做软约束。
                note = strip_auto(ca.prompt) if ca else ""
            if url is None:
                continue
            if url not in urls:
                urls.append(url)
                labels.append(label)
                notes.append(note)
            if len(urls) >= max_refs:
                break
        # P1-3 场景参考图补位：角色图未占满时按注入集合补场景（有图才注入）
        for loc in locs:
            if len(urls) >= max_refs:
                break
            a = (session.query(Asset)
                 .filter(Asset.project_id == shot.project_id,
                         Asset.kind == "location",
                         Asset.name == loc).first())
            if a is None:
                continue
            # 多视角（2026-09-09）：从这个场景的 8 张参考图里挑**一张**最贴本镜的
            # ——镜头文本里认出景别就用那一档，认不出用主视角全景。
            # 只挑一张：厂商上限只有 4 张（video_seedance.max_reference_images），
            # 角色一致性权重更高，场景不能占掉多个位。
            url, vlabel = sv_pick_for_shot(session, a.id, shot=shot)
            if url is None:
                url, vlabel = a.image_url, None      # 兜底：老项目只有那一张图
            if not url or url in urls:
                continue
            urls.append(url)
            labels.append(f"场景「{loc}」（{vlabel}）" if vlabel else f"场景「{loc}」")
            notes.append(strip_auto(a.prompt))
        return urls, labels, notes


def _auto_inject_voice_ref(sid: str) -> tuple[str | None, str, str | None]:
    """角色音色自动注入：这一镜谁说话最多，就参考谁的音色。

    返回 `(voice_url, label, skip_reason)`。三者恒有意义，调用方**必须把结果
    记进版本 meta**——不这么做的话，"音色没生效"永远只能靠听。

    ## 为什么需要它

    `Asset.voice_url`（资产弹窗里的「🎙 上传音色」）此前**没有任何消费方**：
    视频侧只认镜头 override 里的 `reference_audio_url`，而**没有任何界面写过
    那个字段**。于是"给人物上传音色"是一个上传完就到此为止的动作——
    文件存下来了，UI 也显示"已设置"，生成时一个字节都不会被用到，且全程无提示。
    （另外两个音色概念别混：`Project.narration_voice_url` 是解说剧的整片旁白，
     `AudioClip.voice_ref_url` 是解说剧逐条 TTS 的克隆参考，走 run_tts_batch。
     这里处理的是第三个：真人剧音画一体通道里的**角色音色**。）

    ## 选谁

    按**说话时长**降序（`drama_timing.speaker_seconds`），不是按出场顺序：
    一镜多人时第一句常常是一句「嗯。」，按顺序取会把配角的音色安到主角身上。
    通道目前只吃一段参考音（`max_reference_audios` 虽为 3，但多段音色无法
    与角色对应，给多了只会让模型串音），所以只取戏份最重的那一个。

    ## 边界

    · 本镜没有任何台词（纯动作/空镜）→ 不注入，skip_reason=None（不是问题）。
    · 说话人被用户删了资产 → 断链，与参考图同一条规则（asset_gate）。
    · 说话人有资产但没上传音色 → 不注入，skip_reason 写清楚是谁，
      这样"我明明传了音色"能当场对上"传的不是这一镜说话的那个人"。
    """
    from . import asset_gate
    from .db import Asset, effective_characters
    from .drama_timing import speaker_seconds
    with get_session() as session:
        shot = session.get(Shot, sid)
        if not shot:
            return None, "", None
        spoken = speaker_seconds(shot.script_ref or "")
        if not spoken:
            return None, "", None          # 无台词镜：本就不需要音色
        gone = asset_gate.deleted_names(session, shot.project_id)
        # 出场角色集合只用来**排序时兜底**，不做硬过滤：说话人是从剧本原文里
        # 解析出来的，比 characters 字段更接近事实（后者可能被人工 remove 过，
        # 但人删的是"参考图里别出现他"，不是"他这镜没说话"）。
        known = set(effective_characters(shot) or [])
        ranked = sorted(spoken.items(), key=lambda kv: (-kv[1], kv[0]))
        missing: list[str] = []
        for name, _sec in ranked:
            if name in gone:
                continue                   # 用户删掉的资产：断链，与参考图同规则
            a = (session.query(Asset)
                 .filter(Asset.project_id == shot.project_id,
                         Asset.kind == "character", Asset.name == name,
                         Asset.voice_url.isnot(None)).first())
            if a is not None and (a.voice_url or "").strip():
                tag = "" if name in known else "（该角色不在本镜出场清单里）"
                return a.voice_url, f"角色「{name}」音色{tag}", None
            missing.append(name)
        if not missing:
            return None, "", None
        return None, "", "本镜说话人（%s）都没有上传音色" % "、".join(missing[:3])


async def _to_trusted_assets(sid: str, urls: list[str],
                             model_id: str) -> list[str]:
    """把定妆图换成火山可信资产引用（asset://），绕过 Seedance 人脸审核。

    只对 Seedance 系生效：H3/Veo 没有这道审核，入库纯属白花配额与时间。

    "要用的时候再入库"——在这里做而不是资产生成时，避免给根本不出片的
    角色白占素材库容量。已入库的会直接命中缓存（stage.volc_asset_id），
    同一角色几十个镜头只入一次。

    入库要发网络请求并等几十秒，所以：
      - 放在**出 session 之后**做，不占数据库连接
      - 用 to_thread 包住同步的 HTTP 调用，不阻塞事件循环
    任何一步失败都回退原始 URL——入库是优化项，不能因它把生成打死。
    """
    if not urls or "seedance" not in (model_id or "").lower():
        return urls
    try:
        from .providers.volcano_assets import resolve_reference_url
    except ImportError:
        return urls

    # ⚠️ 绝不能在 with get_session() 里做那个网络调用。
    #
    # resolve_reference_url → wait_active(...) 会以 5s 间隔轮询**最长 180 秒**。
    # 放在 session 内的话，170 镜并发时每个镜头都占着一条连接好几分钟，
    # pool_size=20 + max_overflow=30 必然耗尽 → QueuePool timeout 抛出 →
    # 逃出 _run_one → 整个 job 卡在 running（见 A7 那条连锁）。
    # 另外 stage 是 session 绑定对象，却要在 to_thread 的工作线程里被改 ——
    # SQLAlchemy 的 Session 不是线程安全的。
    #
    # 所以拆成三段：① session 内取快照 → ② 出 session 做网络调用
    # → ③ 新 session 写回结果。
    from types import SimpleNamespace

    # ① 取快照（连接只占这一小段）
    with get_session() as session:
        shot = session.get(Shot, sid)
        if not shot:
            return urls
        project_id = shot.project_id
        # 按 url 反查 stage：注入函数返回的只是 url 列表，且它那个 session
        # 已经关了（detached 对象改了不会落库），必须在本 session 里重新取。
        snap = {
            st.image_url: SimpleNamespace(
                id=st.id,
                volc_asset_id=st.volc_asset_id,
                volc_asset_status=st.volc_asset_status,
                # ⚠️ 这两个字段必须跟着一起带：resolve_reference_url 用它们拼
                # 素材组名（`<项目id>:<角色名>`，火山侧**一个角色一组**）与素材名。
                # 漏掉就会双双取到默认值，于是所有角色挤进同一个
                # `<项目id>:unknown` 组、素材名一律叫 `unknown-`——
                # 私域形象「按角色归组」的能力等于没有，人工去素材库里也认不出谁是谁。
                # （上面尾帧那个调用方是对的：它显式传了 tailframe/tail。）
                character_name=st.character_name,
                stage_name=st.stage_name,
            )
            for st in session.query(AssetStage)
            .filter(AssetStage.project_id == project_id,
                    AssetStage.image_url.in_(urls)).all()
        }

    # ② 网络调用（无数据库连接在手）
    out: list[str] = []
    for u in urls:
        st = snap.get(u)
        if st is None:
            out.append(u)      # 场景图/通用定妆图：无处挂 asset_id，原样送
            continue
        public = to_public_url(u)
        # resolve_reference_url 就地改 st 的 volc_asset_id / volc_asset_status，
        # 这里 st 是普通对象，改它不涉及任何 session
        out.append(await asyncio.to_thread(
            resolve_reference_url, st, public, project_id))

    # ③ 写回（再次短暂持有连接）
    changed = [s for s in snap.values()
               if s.volc_asset_id or s.volc_asset_status]
    if changed:
        with get_session() as session:
            for s in changed:
                row = session.get(AssetStage, s.id)
                if not row:
                    continue     # 期间被删（造型重识别），跳过即可
                row.volc_asset_id = s.volc_asset_id
                row.volc_asset_status = s.volc_asset_status
            session.commit()
    return out


async def _build_prompt_ctx(
    sid: str,
    project_id: str,
    model_id: str,
    *,
    gen_mode: str | None,
    duration_ms: int | None,
    used_first_frame: bool,
    ref_count: int,
    injected_labels: list[str],
    injected_notes: list[str],
    explicit_refs: bool,
) -> tuple[list[str], dict[str, dict], list[str]]:
    """组装喂给提示词优化器的「补充背景与硬性约束」。

    返回 (ctx 段落列表, 人物档案, 本镜出场角色)。

    ⚠️ 这段必须**只有一份**：出片链路（run_shot_videos）与「按当前资产重新生成
    提示词」（run_reprompt）都要用它。曾经的教训是同一套约束在两处各写一遍，
    改了一处忘了另一处，用户看到的提示词与实际下发的对不上。
    """
    ctx = [f"生成模式: {gen_mode}"] if gen_mode else []
    if duration_ms:
        ctx.append(f"目标时长: {duration_ms / 1000:.2f} 秒")
    if used_first_frame:
        # 首帧路线：提示词描述"从首帧开始怎么动"，严禁重新描述人物外观/场景
        # （外观已由首帧钳制，重复描述反而诱导模型偏移）
        ctx.append(
            "首帧图已提供（画面即视频第一帧，人物与场景外观以首帧为准）；"
            "提示词只需描述人物动作、表演与情绪变化，"
            "机位默认固定（原稿没写运镜就不要加运镜），"
            "禁止重新描述人物长相/服装/场景陈设，禁止切换场景")
    # 画风：与影调同一个道理，但更硬。**全参考路线没有首帧图**，视频模型只看
    # 提示词与定妆图，若不在这里声明画风，动漫剧就会出成实拍——比色调不统一
    # 严重得多。首帧路线下首帧图已定画风，仍然要说：视频模型有把画面"还原成
    # 实拍"的倾向，一句声明的成本可以忽略。
    _st = _style_of(project_id)
    ctx.append(_st.video_line)
    # 影调：全片一套调色配方，视频侧也必须说。
    # 首帧路线下首帧图已带影调，但**全参考路线压根没有首帧图**——视频模型只看
    # 提示词与定妆图，影调若只写在资产图提示词里，成片就会与资产图各一套色，
    # 这正是用户 2026-09-09 反馈「不同图片画面色调不统一」的另一半。
    # 与资产图共用 `look_profile.phrase()` 的同一份档案与同一套字面。
    _look = _look_line(project_id)
    if _look:
        ctx.append(_look + ("首帧图已按这套影调出图，视频沿用即可，不要重新调色。"
                            if used_first_frame else ""))
    if ref_count:
        # Seedance @图片N 引用：图片顺序 = images 数组顺序 = @编号。
        # 有 labels（自动注入）时告知优化器每张图是谁，可在提示词中 @图片N 精确引用；
        # 无 labels（手动 ref_urls）只报数量并严禁虚构 @引用（同主平台防幻觉策略）。
        if model_id.startswith("seedance") and injected_labels and not explicit_refs:
            listing = "; ".join(
                f"图片{i + 1}={lb}" for i, lb in enumerate(injected_labels))
            ctx.append(
                f"本次实际提供 {len(injected_labels)} 张参考图: {listing}。"
                f"提示词中可用 @图片N 引用对应角色/场景（如 @图片1）保持形象一致；"
                f"除这些外不存在任何图片，严禁引用或发明其它 @图片N")
        elif injected_labels and not explicit_refs:
            # 非 seedance（如海螺 H3 全能参考）：没有 @图片N 语法，但同样要
            # 让优化器知道每张图是谁，否则提示词会重新描述人物外观、与参考图打架。
            listing = "；".join(
                f"参考图{i + 1}为{lb}" for i, lb in enumerate(injected_labels))
            ctx.append(f"本次提供 {len(injected_labels)} 张参考图: {listing}")
        else:
            ctx.append(f"参考图 {ref_count} 张(角色/场景定妆参考)"
                       + ("；提示词中严禁出现 @图片N 等图片引用"
                          if model_id.startswith("seedance") else ""))
        # 服装锚定（修「同一场景内人物服装不一致」）：
        # 参考图钳制的是长相，**服装并不会自动被继承**——提示词只要不提服装，
        # 模型就按自己的理解给每镜换一套衣服，于是同场景相邻镜头里同一角色
        # 忽然换装。必须显式要求"服装照抄参考图"，并禁止优化器自行发明服装
        # （它很擅长为了画面丰富度加"一身红色长裙"这类无据描述）。
        # 例外：剧本本镜明写了换装/特定服装时以剧本为准，否则会把剧情写没。
        ctx.append(
            "人物的服装、发型、配饰必须与其参考图完全一致，逐件照抄，"
            "不得更换颜色/款式/层数；除剧本本镜明确写了换装或特定衣着外，"
            "严禁自行发明或补充任何服装描述")
        # 参考图里到底穿的什么（AssetStage.description / Asset.prompt）。
        # 只说"照抄参考图"是不够的——优化器看不到图，原稿里若已写了错误的
        # 服装（预生成提示词是拆解时写的，那会儿资产还没生成），它只会照抄
        # 原稿的错误。必须把每张图的造型写出来，并明确"冲突时以此为准"。
        #
        # ⚠️ 人物图与场景图要分两段说（修 912「同场景桌子外观多次偏移」）：
        # 原来是一段通稿，措辞全是"服装/发型/配饰"——场景图的描述（空间类型、
        # 家具材质、光线）混在里面等于没有任何约束落到它身上。
        ref_notes = [f"参考图{i + 1}（{injected_labels[i]}）：{n}"
                     for i, n in enumerate(injected_notes)
                     if n and not injected_labels[i].startswith("场景")]
        scene_notes = [f"参考图{i + 1}（{injected_labels[i]}）：{n}"
                       for i, n in enumerate(injected_notes)
                       if n and injected_labels[i].startswith("场景")]
        if ref_notes and not explicit_refs:
            ctx.append(
                "各人物参考图的实际造型如下，提示词中对应人物的服装/发型/配饰"
                "描述必须与之逐项对齐；原稿中与之矛盾的服装描写一律以此为准"
                "改写或删除（不要给 A 写上 B 的衣服）：\n" + "\n".join(ref_notes))
        if scene_notes and not explicit_refs:
            # 场景锚定：空间的样子由**这一份**描述唯一确定。不写这一段的后果
            # 实测就是每镜自行发明陈设——同一个「半岛酒店顶楼餐厅」被写成
            # 「豪门会客室 + 大理石茶几」「璀璨水晶吊灯」「高档餐厅包厢」。
            ctx.append(
                "本镜所在场景的既定设定如下（这是该空间的唯一依据，"
                "同一场景在所有镜头里必须完全一致）：\n" + "\n".join(scene_notes)
                + "\n提示词中该空间的房间类型、家具种类与外观、材质、颜色、"
                  "灯具与光线必须与之一致，**不得**新增、替换或升级其中的陈设"
                  "（例如把餐桌换成大理石茶几、凭空加一盏水晶吊灯），"
                  "也**不得**改写场景的名称与场所性质；原稿中与之矛盾的"
                  "场景描写一律以此为准改写或删除。")
        # 无描述参考图的确定性兜底（用户直接上传图、且视觉反推也失败时会走到）：
        # 有图但没有任何文字造型 → 优化器无从对齐，只会照抄原稿里那句拆解时
        # 凭空猜的服装，结果就是"图里穿风衣、提示词写深色连衣裙"。此时唯一
        # 安全的做法是**让提示词彻底不提服装**，把外观交给参考图自己钳制。
        #
        # ⚠️ 人物与场景要分开说（修 912「同场景桌子外观多次偏移」）：
        # 原来这段只禁"服装、发型、配饰、颜色与款式"，那是人物的词汇表；
        # 场景图落进 blind 时，"不许写陈设/不许改场景名"一个字都没说，
        # 于是优化器照样发明「大理石茶几」「璀璨水晶吊灯」，甚至把
        # 「顶楼餐厅」写成「豪门会客室」。
        blind = [injected_labels[i] for i, n in enumerate(injected_notes)
                 if not n and i < len(injected_labels)]
        if blind and not explicit_refs:
            blind_scene = [b for b in blind if b.startswith("场景")]
            blind_char = [b for b in blind if not b.startswith("场景")]
            if blind_char:
                ctx.append(
                    f"以下人物参考图没有文字造型说明：{'、'.join(blind_char)}。"
                    "提示词中**禁止**书写这些人物的服装、发型、配饰、颜色与款式"
                    "（写了必然与图打架），只写其动作、表情、走位与景别；"
                    "原稿里针对他们的任何服装与外观描写一律删除。")
            if blind_scene:
                ctx.append(
                    f"以下场景参考图没有文字空间说明：{'、'.join(blind_scene)}。"
                    "该空间的样子完全以参考图为准：提示词中**禁止**书写它的"
                    "房间类型、家具种类与外观、材质、颜色、灯具、窗户与陈设细节"
                    "（写了必然与图打架），也**禁止**改写场景的名称与场所性质"
                    "（例如把餐厅说成会客室或包厢）；只写人物在其中的位置、"
                    "动作与景别，原稿里对该空间的臆测性描写一律删除。")
    # 场景设定的文字兜底：场景**没有**参考图、或没占到注入名额时，
    # 上面的 scene_notes 一段都不会出——而那正是最需要文字约束的情况
    # （连图都没有，空间完全靠优化器想象）。有描述就必须给。
    if not explicit_refs and not any(
            lb.startswith("场景") for lb in injected_labels):
        loc_name, loc_desc = _scene_desc_text(sid)
        if loc_desc:
            ctx.append(
                f"本镜场景「{loc_name}」的既定设定如下（该空间的唯一依据，"
                f"同一场景在所有镜头里必须完全一致）：\n{loc_desc}\n"
                f"提示词中该空间的房间类型、家具与陈设、材质、颜色与光线"
                f"必须与之一致，不得新增或替换陈设，也不得改写场景名称与"
                f"场所性质；原稿中与之矛盾的场景描写一律以此为准改写或删除。")
    # 同场连续戏的空间/走位延续（纯 DB 推导，不额外调用）。
    # 放在 ref_count 之外：连续段的空间与走位要不要延续，与本镜有没有
    # 参考图无关——纯文生图的镜头同样会一镜一个样。
    ctx.extend(_scene_run_ctx(sid))
    # 人物档案：修「女主角被写成 he / a man」——参考图钳制的是长相，
    # 提示词里的人称与性别称谓一旦写反，模型按提示词走，参考图直接失效。
    # 档案按 (项目, 集) 缓存，一集只花一次纯文本调用。
    with get_session() as session:
        _sh = session.get(Shot, sid)
        shot_ep = _sh.episode if _sh else 1
        shot_chars = _effective_characters(_sh) if _sh else []
    brief: dict[str, dict] = {}
    if shot_chars:
        from .character_brief import brief_context, character_brief
        brief = await character_brief(project_id, shot_ep)
        # 形象档案的气质回灌（同 _pregen_prompts：只吃气质，不吃五官——
        # 五官会和本镜注入的定妆图参考打架）
        try:
            from .character_profile import load_profiles, merge_into_brief
            brief = merge_into_brief(brief, load_profiles(project_id))
        except Exception as e:  # noqa: BLE001
            log.warning("[profiles] 逐镜档案回灌失败，按无档案继续: %r", e)
        bc = brief_context(brief, shot_chars)
        if bc:
            ctx.append(bc)
        # 3.9 在场名单：把"画面里必须有谁"说死。
        #
        # 光注入定妆图是不够的 —— 优化器看得见图的**标签**，却没有任何一句话
        # 要求它把这个人写进画面。实测「真人剧-验证片」镜 2 的成稿是
        # 「陆沉与林语对面而坐」：林母的图就算注入了，提示词里没有她，
        # 模型照样画两个人。
        #
        # 推导补进来的（L1.5）要单独点名并说明"无台词但在场"，否则优化器
        # 会把这个突然冒出来、原稿里毫无戏份的名字当噪声忽略掉。
        silent = [c for c in _present_only(sid) if c in shot_chars]
        line = ("本镜画面中必须同时出现以下角色，一个都不能少："
                + "、".join(shot_chars) + "。")
        if silent:
            line += ("其中 " + "、".join(silent)
                     + " 在本镜没有台词、也没有主动作，但**仍然在场**："
                     "保持其位置、姿态与朝向延续上一镜结尾，"
                     "不得让其离场、消失或被移出画面，也不要为其编造新的戏份。")
        ctx.append(line)
    return ctx, brief, shot_chars


def _present_only(sid: str) -> list[str]:
    """本镜里**只由在场推导（L1.5）补进来**的角色（不含拆解真值里本来就有的）。

    用来在提示词里单独点名"这些人无台词但在场"。查不到就返回空列表——
    这一段只是措辞更贴切，缺了不影响主约束。
    """
    from .continuity import parse_characters
    with get_session() as s:
        sh = s.get(Shot, sid)
        if not sh:
            return []
        own = set(parse_characters(sh.characters))
        return [c for c in parse_characters(sh.present_characters) if c not in own]


#: 上游报错文本 → 失败分类。分类决定 UI 给什么建议：
#: moderation 重试同一提示词必然再被拒，要改词/换模型；channel 值得重试。
def classify_failure(err: str) -> str:
    e = (err or "").lower()
    if any(k in e for k in ("sensitivecontent", "moderation", "content_policy",
                            "privacyinformation", "real person", "审核", "敏感")):
        return "moderation"
    if any(k in e for k in ("timeout", "timed out", "connection", "502", "503",
                            "504", "429", "rate limit", "channeldown")):
        return "channel"
    return "other"


def _save_blocking(sid: str, blocking: dict | None) -> None:
    """落库本镜结尾的走位台账（3.9）。抽不到 / 全是脏数据时**不动**旧值。

    为什么不清空：台账的消费者是**下一镜**。这次没抽到就沿用上次那份，
    总比让下一镜彻底失去位置约束强 —— 后者正是要修的那个毛病。
    真要作废：用户改了拆解会走重拆路径，那时整批镜头都会重来。
    """
    from .continuity import parse_blocking
    if not blocking:
        return
    clean = parse_blocking(json.dumps(blocking, ensure_ascii=False))
    if not clean:
        log.info("[shot %s] 走位台账解析后为空，保留上一份", sid)
        return
    try:
        with get_session() as session:
            sh = session.get(Shot, sid)
            if sh:
                sh.blocking_out = json.dumps(clean, ensure_ascii=False)
                session.commit()
    except Exception:  # noqa: BLE001 台账是锦上添花，绝不能因它中断出片
        log.exception("[shot %s] 走位台账落库失败（本镜照常出片）", sid)


def _set_shot_status(sid: str, status: str, error: str | None = None) -> None:
    with get_session() as session:
        shot = session.get(Shot, sid)
        if shot:
            shot.status = status
            if status == "failed":
                # 只留摘要：上游错误常带整段 JSON + traceback，全塞进去
                # UI 上没法看，日志里也已经有完整版
                shot.fail_reason = (error or "")[:300] or None
                shot.fail_kind = classify_failure(error or "")
            elif status in ("adopted", "review", "generating"):
                # 重试成功后要清掉旧错误，否则镜头一直挂着上次的失败原因
                shot.fail_reason = None
                shot.fail_kind = None
            session.commit()
            # P2-5 SSE：镜头状态流转（prompting/generating/adopted/failed）实时推送
            publish(shot.project_id, "shot", {"id": sid, "status": status,
                                              "fail_kind": shot.fail_kind,
                                              "fail_reason": shot.fail_reason})


def _set_shot_first_frame(sid: str, url: str) -> None:
    """落库本镜首帧图并实时推前端（镜头卡即时显示，用户可先审首帧再等视频）。"""
    with get_session() as session:
        shot = session.get(Shot, sid)
        if shot:
            shot.first_frame_url = url
            session.commit()
            publish(shot.project_id, "shot", {"id": sid, "first_frame_url": url})


def _save_shot_version(sid: str, video_url: str, model_id: str,
                       prompt: str, meta: dict | None,
                       thumb_url: str | None = None) -> int:
    """落一条版本记录，返回版本号（同镜头内自增）。"""
    from datetime import datetime, timezone
    from .db import ShotVersion
    with get_session() as session:
        last = (session.query(ShotVersion).filter(ShotVersion.shot_id == sid)
                .order_by(ShotVersion.version_no.desc()).first())
        vno = (last.version_no + 1) if last else 1
        session.add(ShotVersion(
            id=uuid.uuid4().hex[:12], shot_id=sid, version_no=vno,
            video_url=video_url, thumb_url=thumb_url,
            model_id=model_id, prompt=prompt,
            meta=json.dumps(meta, ensure_ascii=False) if meta else None,
            created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ))
        session.commit()
        return vno


def _plan_default_stages(session, project_id: str, cname: str,
                         eps: list[int]) -> list[tuple[int, int]]:
    """为「完全没有定妆图的角色」规划要补建的造型阶段区间。

    输入 eps = 该角色的出场集数（可能不连续，如 [1,2,5]）。
    返回 [(ep_from, ep_to), ...]，已排除与既有阶段重叠的集。

    ## 为什么不能简单地"按连续段拆分"（这是一个真实 bug 的修复）

    旧实现把出场集压成**连续段**，每段建一个阶段，且都叫「默认造型」、
    description 相同（都取角色通用 prompt）。于是出场集有跳集的角色（如白薇
    出现在第 1、2、5 集）会得到两个**一模一样**的阶段：
      「默认造型」ep1-2 / 「默认造型」ep5-5
    用户在资产页看到两条完全相同的记录，无法理解区别在哪，还要为同一个造型
    付两次生图钱、并且两张图长得不一样（同一角色跨集变脸）。

    正确做法：**同一个"默认造型"本质上只该有一个阶段**。既然没有任何造型信息
    可区分，就用一个区间 [min, max] 覆盖到底——中间没出场的集数被覆盖了也无害
    （注入只按镜头所在集查阶段，该集没镜头就查不到）。只有当区间会与**既有
    阶段**重叠时才必须避让，此时才退化成多段。
    """
    from .db import AssetStage
    from . import stage_gate
    if not eps:
        return []
    # 墓碑阶段**不占集号**（stage_gate 里那条刻意的取舍）：否则用户删掉一个
    # 阶段后，那几集依旧被一个看不见的东西占着，规划只能绕开它 → 重跑识别后
    # 那段集永远没有造型，而用户在界面上找不到原因。
    siblings = stage_gate.alive_stages(session, project_id, cname)
    taken = {e for st in siblings for e in range(st.ep_from, st.ep_to + 1)}
    lo, hi = min(eps), max(eps)
    # 首选：一个区间打通到底（无空缺 → 同角色只有一条「默认造型」）
    span = [e for e in range(lo, hi + 1) if e not in taken]
    if not span:
        return []
    if len(span) == hi - lo + 1:
        return [(lo, hi)]
    # 与既有阶段重叠：只能按可用集的连续段拆（避免 patch_stage 的 409 重叠校验）
    runs: list[list[int]] = []
    for e in span:
        if runs and e == runs[-1][1] + 1:
            runs[-1][1] = e
        else:
            runs.append([e, e])
    return [(a, b) for a, b in runs]


async def run_one_click_film(jid: str) -> None:
    """一键成片 Saga（阶段⑤）：拆解 → 资产 → 首帧 → 片段 → 拼接。

    原「🚀 一条龙」已并入：同一条链（拆解→资产→首帧→片段→拼接），差别只在从哪环
    切入。后端会跳过已完成的环节（拆解：有 shots 则跳过；资产/首帧：gen_assets=false
    则跳过；片段：已出片的镜头自动跳过），所以从任何入口调用都安全。

    payload = {
      "project_id": "...",
      "script": "...",               # 缺省时取项目的 optimized_script/raw_script
      "gen_assets": false,           # true = 先补缺失资产图，再出首帧和片段
      "llm_model": null, "video_model": null, "prompt_prefix": null,
      "resolution": null,            # 本次覆写分辨率档位；null = 沿用项目设置
      "aspect_ratio": null           # 本次覆写画面比例；null = 沿用项目 base_aspect
    }
    ⚠️ 2026-09-10：payload 里原来写的是 `width/height/fps`，**这三个键从来没有
    任何代码读过**（服务端不再合成，成片由桌面端 ffmpeg 出，尺寸由片段本身决定）。
    前端却一直在下发 `width: 1080, height: 1920` 兜底，于是「本次参数」里改的
    分辨率既没生效、也没报错。真正管用的旋钮只有一个：下发给 Provider 的
    `VideoRequest.megapixels` / `aspect_ratio`，它们在 run_shot_videos 里定，
    所以这一层要把 `resolution` / `aspect_ratio` 原样透传给 shot_videos 子 job。
    进度分配：拆解 0-10，资产 10-30，首帧 30-60，片段 60-85，收尾 85-100。
    **不产出成片文件**：最后的合成由桌面端本机 ffmpeg 完成（多轨/转场/字幕样式）。
    任一段整体失败即置 failed 并带上失败段落名，不静默往下走。
    """
    from .db import Asset, AssetStage, Project
    from .readiness import compute_readiness

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            _update(jid, status="failed", error=f"项目不存在: {project_id}")
            return
        script = p.get("script") or proj.optimized_script or proj.raw_script
    if not script:
        _update(jid, status="failed", error="项目没有剧本，请先导入/优化剧本")
        return

    _update(jid, status="running", progress=1)

    # 一键成片的五段流程标签。前端 PreflightDialog 按 key 逐步点亮，
    # 所以这里的 key 与前端 STAGES 必须一一对应——改名要两边一起改。
    def _stage(key: str, label: str, done: int = 0, total: int = 0) -> None:
        set_job_phase(jid, {"key": key, "label": label, "done": done, "total": total})

    # 段边界取消：用户点「停止生产」后不再进入下一段。
    # 段**内**的取消由子 runner 的镜头级检查点负责（parent_jid 传导）。
    def _abort_if_cancelled() -> bool:
        if is_cancelled(jid):
            set_job_phase(jid, None)
            return True
        return False

    # 1) 镜头拆解（0-10）：项目还没镜头，或显式传了新剧本则重拆
    # 这一段的 total 事前未知（拆完才知道多少镜），故只报 label 不报计数
    #
    # ⚠️ 必须走 breakdown_by_episode（**逐集**拆），不能直接 do_breakdown(整本剧本)。
    # 后者不传 episode，`do_breakdown` 会把全部镜头打上 episode=1，
    # 于是 generate_narration 按集分组时只看得见第 1 集的正文，把它稀释到全部
    # 镜头上——第 2 集起的旁白从头到尾不参与。实测项目 930 就是这样变成
    # "画面在演第 6 集、声音在念第 5 集"的。
    _stage("breakdown", "正在拆解镜头")
    try:
        with get_session() as session:
            has_shots = session.query(Shot).filter(Shot.project_id == project_id).count() > 0
        if not has_shots or p.get("script"):
            await breakdown_by_episode(
                project_id, script, p.get("llm_model"),
                # 显式传了新剧本 = 用户要按这本重来，已有镜头一律重拆
                force=bool(p.get("script")),
                video_model=p.get("video_model"))
        _update(jid, progress=10)
    except Exception as e:  # noqa: BLE001
        _update(jid, status="failed", error=f"拆解失败: {e!r}")
        return
    if _abort_if_cancelled():
        return

    # 2) 资产补齐（10-30）：只有 gen_assets=true 且真有缺口时才跑
    if p.get("gen_assets"):
        # 2-0) 先让 AI 规划造型阶段（含剧本明写的服装变体，如「丝绸睡裙」）。
        #
        # 为什么必须在生图之前跑这一步：原先一键链路根本不调 stages/draft，
        # 于是"剧本里写了不同服装人设的角色"永远只会拿到一条 `默认造型`
        # ——那件衣服既没被识别、也没被生成资产（用户反馈的正是这一点）。
        # stages_draft 会保护已有图的角色（kept_chars），所以重复调用不会
        # 冲掉用户已经出过图的时间线，也不会重复烧钱。
        # 识别失败（LLM 挂了/返回非 JSON）不阻断：退回"每角色一条默认造型"的
        # 老行为，总比整个一键成片失败好。
        _stage("costume", "正在识别服装造型")
        try:
            from .routes_v2 import StageDraftIn, stages_draft
            r = await stages_draft(StageDraftIn(project_id=project_id,
                                                model_id=p.get("llm_model")))
            log.info("[one_click_film %s] 造型阶段规划完成: 共 %s 个（其中服装变体 %s 个）",
                     jid, r.get("created"), r.get("variants"))
        except Exception as e:  # noqa: BLE001 识别失败不阻断，退回默认造型
            log.warning("[one_click_film %s] 造型阶段识别失败，退回默认造型: %r", jid, e)

        rd = compute_readiness(project_id)
        if rd.get("error"):
            _update(jid, status="failed", error=f"项目不存在: {project_id}")
            return
        # Q1：先取人物档案（性别/年龄段/身份），供定妆照提示词使用。
        # 必须在 session 块**之前** await —— 同步 session 里不能跑协程，
        # 且 character_brief 会调 LLM，占着 DB 连接等网络是明确的反模式。
        _briefs = await _collect_briefs(project_id, rd, p.get("model_id"))
        # 形象档案（骨相/五官/气质）：同理必须在 session 块前 await。
        # 用户 2026-09-09 决策：一键成片里自动跑，不需要单独点一次。
        _profiles = await _collect_profiles(project_id, rd, p.get("model_id"))
        # 影调档案（全片一套调色基调）：同理必须在 session 块前 await。
        # 它拼进下面所有 character_prompt / scene_prompt，是"不同图色调不统一"的主要修法。
        _look = await _collect_look(project_id)
        # 画风预设（都市/古风/国漫…）：读一行库，不 await。它同时决定前缀、
        # 否定项与质感词——只换前缀会与残留的「禁止动漫」自相矛盾，
        # 见 style_preset 模块头。
        _style = _style_of(project_id)
        # Q3：场景描述就地补齐。没有它 scene_prompt 只报一个场景名，
        # 出来的参考图是"某个高档餐厅"而不是**这一个**餐厅；
        # 更要紧的是镜头提示词也拿不到陈设依据（见 ensure_scene_descriptions）。
        # 不透传 p["model_id"]：本 job 的 model_id 语义是**视频**模型覆盖值。
        await ensure_scene_descriptions(project_id)
        items: list[dict] = []
        with get_session() as session:
            proj = session.get(Project, project_id)
            title = proj.title if proj else ""
            # 🐛 资产生图此前**不传 model_id**，于是 ImageProvider(model_id=None)
            # 恒取 settings.image_model（全局默认），而镜头图走的是项目自己的
            # image_model。两者是同一型号时看不出问题，用户一改项目模型，
            # 资产图和成片立刻两种质感——这是"色调不统一"的成因之二。
            _asset_image_model = _resolve_project_gen_settings(proj)[1]
            # 2a) 阶段无图（直接生图进该阶段）
            for row in rd["assets"]["stages_no_image"]:
                st = session.get(AssetStage, row["id"])
                if st is None:
                    continue
                items.append({
                    "name": f"角色-{st.character_name}",
                    "stage_id": st.id,
                    "prompt": character_prompt(
                        title, st.character_name,
                        stage_name=st.stage_name,
                        description=st.description,
                        brief=brief_for_image(_briefs, st.character_name),
                        profile=_profiles.get(st.character_name),
                        look=_look, style=_style),
                })
            # 2b) 角色完全无定妆图：补建阶段行再生图
            for row in rd["assets"]["chars_no_asset"]:
                cname, eps = row["name"], row["episodes"]
                runs = _plan_default_stages(session, project_id, cname, eps)
                if not runs:
                    continue
                ca = (session.query(Asset)
                      .filter(Asset.project_id == project_id,
                              Asset.kind == "character", Asset.name == cname).first())
                desc = (ca.prompt if ca and ca.prompt else "") or ""
                for ep_from, ep_to in runs:
                    st = AssetStage(id=uuid.uuid4().hex[:12], project_id=project_id,
                                    character_name=cname, stage_name="默认造型",
                                    ep_from=ep_from, ep_to=ep_to, description=desc)
                    session.add(st)
                    session.commit()
                    items.append({
                        "name": f"角色-{cname}",
                        "stage_id": st.id,
                        "prompt": character_prompt(
                            title, cname, description=desc,
                            brief=brief_for_image(_briefs, cname),
                            profile=_profiles.get(cname),
                            look=_look, style=_style),
                    })
            # 场景多视角参考图（8 张/场景：方位 4 + 景别 4）。
            # 一张图不够的理由见 scene_view 模块头：镜头一换机位，模型手里只有
            # 一个方向的照片，只能现编这个房间的其它面——同一个客厅会不是同一个客厅。
            items += _scene_view_items(session, project_id, title,
                                       rd["assets"]["locations_no_image"], _look)
        if items:
            # 段边界再查一次取消：用户在拆解/资产盘点这段时间里点了「停止生产」时，
            # 原来照样建子 job 并跑一遍——每一项在入口秒退成"已取消"，
            # 子 job 却被判 failed，再把 12KB 的明细灌进父 job 的 error，
            # 用户于是在自己点的取消之后收到一张红色「生成失败」卡片（2026-09-01 生产报障）。
            if _abort_if_cancelled():
                return
            _stage("assets", "正在补资产图", 0, len(items))
            sub_a = create_job("asset_batch", {"project_id": project_id,
                                               "items": items, "size": "1024x1024",
                                               "model_id": _asset_image_model})
            await run_asset_batch(sub_a, parent_jid=jid)
            a_job = get_job(sub_a)
            if a_job is not None and a_job.status == "cancelled":
                _abort_if_cancelled()
                return
            if a_job is None or a_job.status == "failed":
                _update(jid, status="failed",
                        error=f"资产生成失败: {(a_job.error if a_job else 'job 丢失')}")
                return
        _update(jid, progress=30)
    else:
        _update(jid, progress=30)
    if _abort_if_cancelled():
        return

    # 3) 全部首帧（30-60）：只有项目/镜头走 i2va 的才真会出首帧
    # （full_reference 项目跳过这一步，rd.first_frames.mode_active==false）
    rd = compute_readiness(project_id)
    if rd.get("error"):
        _update(jid, status="failed", error=f"项目不存在: {project_id}")
        return
    if rd["first_frames"]["mode_active"] and rd["first_frames"]["required"] > 0:
        _stage("frames", "正在生成首帧", 0, rd["first_frames"]["required"])
        sub_ff = create_job("first_frames", {"project_id": project_id, "force": False})
        await run_first_frames(
            sub_ff,
            progress_cb=lambda pct: _update(jid, progress=30 + int(pct * 0.3)),
            phase_jid=jid, parent_jid=jid)
        ff_job = get_job(sub_ff)
        if ff_job is None or ff_job.status == "failed":
            _update(jid, status="failed",
                    error=f"首帧生成全部失败: {ff_job.error if ff_job else 'job 丢失'}")
            return
    _update(jid, progress=60)
    if _abort_if_cancelled():
        return

    # 3.5) 解说剧配音（60-70）——**必须在出视频之前**。
    #
    # 解说剧的镜头时长由旁白时长决定（run_tts_batch 里的 _sync_shot_duration）。
    # 如果先出视频再配音，时长一改这些视频全部作废，等于白烧一轮钱。
    # 所以顺序是：切旁白 → 合成 → 回写时长 → 再按新时长出视频。
    #
    # 真人剧不走这里：它的台词配音是叠在既有画面上的，不改镜头时长，
    # 用户在音频面板按需合成即可。
    narration_done = 0
    with get_session() as session:
        proj_mode = session.get(Project, project_id)
        is_narration = bool(proj_mode and proj_mode.production_mode == "narration")
        narr_voice = proj_mode.narration_voice_url if proj_mode else None
    if is_narration:
        from .routes_v2 import GenNarrationIn, generate_narration
        _stage("narration", "正在生成解说旁白")
        try:
            gen = generate_narration(project_id, GenNarrationIn(project_id=project_id))
            narration_done = gen.get("created", 0)
        except Exception as e:  # noqa: BLE001
            # 切分失败不该让整条链断在这——没有旁白的成片仍然可用（只是哑的），
            # 而用户可以事后在音频面板补。但要把原因带到最终结果里。
            log.warning("[autopilot] 解说旁白切分失败: %r", e)
        if not narr_voice:
            # 没配解说音色就没法合成。不静默跳过——那会让用户拿到一部
            # 没有解说的"解说剧"，还不知道为什么。
            _update(jid, status="failed",
                    error="解说剧需要先设置解说音色：音频面板 →「解说音色」上传一段人声参考")
            return
        _stage("narration_tts", "正在合成解说配音")
        sub_tts = create_job("tts_batch", {"project_id": project_id})
        await run_tts_batch(sub_tts)
        tts_job = get_job(sub_tts)
        if tts_job is None or tts_job.status == "failed":
            _update(jid, status="failed",
                    error=f"解说配音失败: {tts_job.error if tts_job else 'job 丢失'}")
            return
        _update(jid, progress=70)
        if _abort_if_cancelled():
            return

    # 4) 逐镜生成视频（70-85）：复用 run_shot_videos，用子 job 承载细粒度结果
    with get_session() as session:
        _need = (session.query(Shot)
                 .filter(Shot.project_id == project_id,
                         Shot.video_url.is_(None),
                         Shot.disabled == 0).count())
    _stage("videos", "正在生成片段", 0, _need)
    sub_jid = create_job("shot_videos", {
        "project_id": project_id,
        "model_id": p.get("video_model"),
        "prompt_prefix": p.get("prompt_prefix"),
        # 「本次参数」里改的分辨率/画幅必须透传下去——真正下发给 Provider 的是
        # 子 job（run_shot_videos），一键成片这一层只是转发。漏传的话用户在
        # 面板上改了、也看见"已改"了，实际出片仍按项目设置走（静默失效）。
        # 值为 None 表示"沿用项目设置"，run_shot_videos 按 None 处理。
        "resolution": p.get("resolution"),
        "aspect_ratio": p.get("aspect_ratio"),
    })
    await run_shot_videos(
        sub_jid,
        progress_cb=lambda pct: _update(jid, progress=70 + int(pct * 0.15)),
        phase_jid=jid, parent_jid=jid,
    )
    sub = get_job(sub_jid)
    if sub is None or sub.status == "failed":
        _update(jid, status="failed",
                error=f"镜头生成全部失败: {sub.error if sub else 'job 丢失'}")
        return
    _update(jid, progress=85, result=sub.result)
    if _abort_if_cancelled():
        return

    # 5) 收尾（85-100）：**不再服务端拼接**。
    #
    # 服务端拼接只能做单轨顺序拼接——不渲染转场、不合成叠加层、字幕烧录也只有
    # 一个写死的 FontSize=18。它产出的"成片"和桌面端本机渲染的成片根本不是
    # 同一件东西，而用户拿到的又都叫"成片"，反而更容易误以为效果就该这样。
    # 现在统一由桌面端本机 ffmpeg 收尾（多轨 / 转场 / 字幕样式 / 硬件编码）。
    _stage("finalize", "镜头与旁白已就绪")
    with get_session() as session:
        shots = (session.query(Shot).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        ready = [s for s in shots if s.video_url and not s.disabled]
    if not ready:
        _update(jid, status="failed", error="没有任何镜头生成成功")
        return

    set_job_phase(jid, None)   # 收尾清标签，避免 _JOB_PHASE 无限增长
    _update(jid, status="done", progress=100, result=json.dumps({
        # film 恒为 None：一键成片不再直接产出视频文件。前端据此提示用户导出。
        "film": None,
        "ready_shots": len(ready),
        "next_step": "镜头与旁白已全部就绪，请在桌面端点「导出成片」用本机渲染收尾。",
        "shots": json.loads(sub.result or "{}").get("shots", []),
    }, ensure_ascii=False))


async def run_costume_scan(jid: str) -> None:
    """全剧服装识别 job（**纯文本、不生成任何图片、不花生图的钱**）。

    payload = {"project_id": "...", "model_id": null, "priors": {角色: 描述} | null}

    为什么必须是 job 而不是同步接口：识别要逐集调 LLM（长剧几十集 = 几十次调用，
    分钟级），同步接口会撞 nginx 504；更重要的是它必须**跑在出图之前**——
    「🖼 补齐缺失资产（N）」那个 N 是从 `asset_stages` 数出来的，识别没跑过时
    N 只等于"没有定妆图的角色数"，用户看到的报数就不是真实要出的图数
    （2026-08 用户实测：测试3 从没跑过识别，库里 0 条 asset_stages，
    于是无论剧情里有多少套衣服，按钮永远只显示 8）。
    """
    from fastapi import HTTPException

    from .routes_v2 import run_stages_draft

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    _update(jid, status="running", progress=1)
    set_job_phase(jid, {"key": "costume_scan", "label": "正在识别全剧服装",
                        "done": 0, "total": 0})

    def _progress(pct: int, note: str = "") -> None:
        _update(jid, progress=max(1, min(99, int(pct))))
        set_job_phase(jid, {"key": "costume_scan",
                            "label": note or "正在识别全剧服装",
                            "done": 0, "total": 0})

    try:
        out = await run_stages_draft(project_id, p.get("model_id"),
                                     p.get("priors"), progress_cb=_progress)
    except HTTPException as e:          # 无剧本/项目不存在等，如实回显给前端
        set_job_phase(jid, None)
        _update(jid, status="failed", error=str(e.detail))
        return
    except Exception as e:  # noqa: BLE001
        set_job_phase(jid, None)
        _update(jid, status="failed", error=f"服装识别失败: {e!r}")
        return

    set_job_phase(jid, None)
    _update(jid, status="done", progress=100,
            result=json.dumps(out, ensure_ascii=False))


async def breakdown_by_episode(
    project_id: str,
    raw_script: str,
    model_id: str | None,
    *,
    episodes: list[int] | None = None,
    force: bool = False,
    video_model: str | None = None,
    pregen_prompts: bool = True,
    on_progress=None,
) -> dict:
    """**逐集**拆解一个项目。所有拆解入口的唯一实现。

    返回 {"episodes":[{episode,title,shots|error}...], "skipped":[...], "note":str|None}

    ## 为什么必须共用一份

    这段逻辑此前只存在于 `run_breakdown_all` 里，而 `run_one_click_film` 自己另写了
    一行 `do_breakdown(script, model, project_id)` —— **没传 episode，还把整个多集
    剧本一次性喂了进去**。`do_breakdown` 于是把全部镜头打上 `episode=1`，
    `generate_narration` 按集分组时只取得第 1 集的正文，把它稀释到全部镜头上，
    **第 2 集的旁白从头到尾没有参与**（实测项目 930：画面覆盖两集、旁白只有第 1 集，
    镜 8-15 是"画面在演第 6 集、声音在念第 5 集"）。

    两条路径各写一遍正是事故成因，所以这里合成一份，两边都调它。

    `episodes`：只拆这几集（重拆语义，无视已拆状态）；None = 全部。
    `force`：为 False 时跳过已有镜头的集（增量补拆）。
    `on_progress(done, total)`：每集完成回调，供 job 侧更新进度。
    """
    from .routes_v2 import (do_breakdown, _remap_anchors, narration_max_chars,
                            breakdown_shot_cap)
    from .script_import import smart_split_chapters, too_short_to_break_down
    from .db import Project

    with get_session() as session:
        done_eps = {s.episode for s in session.query(Shot)
                    .filter(Shot.project_id == project_id).all()}
        # 解说剧：把"一镜最多多少字"带进拆解。不带的话 LLM 按"7-15 秒视频"
        # 拆出 116 字/镜，而 720p 海螺 H3 一镜只够读 85 字——旁白读不完，
        # 声音直接盖到下一个镜头上（项目 930 实测）。
        max_chars = narration_max_chars(session.get(Project, project_id),
                                        video_model)
        # 真人剧：把"这个视频模型一镜最多多少秒"带进拆解。不带的话一律按
        # 15 秒级模型拆成 8-12 秒一镜——选了 seedance-2.5（单镜 30s）的项目
        # 会被白白剁成三倍数量的碎镜，钱多花两倍、穿帮机会也多两倍。
        shot_cap = breakdown_shot_cap(session.get(Project, project_id),
                                      video_model)

    chapters = smart_split_chapters(raw_script or "")
    if not chapters:
        raise RuntimeError("剧本解析不出内容")

    wanted = set(episodes or [])
    if wanted:
        # 指定集：只拆这些集（重拆语义，无视已拆状态）
        todo = [c for c in chapters if c["order"] in wanted]
    else:
        todo = [c for c in chapters if force or c["order"] not in done_eps]

    # 前言与过短集一律不送 AI（C1）。
    # LLM 被要求产出镜头时不会因为"没内容"而拒绝，它会照着标题**凭空编**——
    # 实测 8 个字的书名换来一整段虚构剧情与 4 个剧本里不存在的角色，
    # 而这些假镜头/假角色会一路流进资产、首帧、成片，用户无从分辨真假。
    # 跳过的集要如实回报，不能静默丢弃（否则用户只看到集数对不上）。
    skipped = [{"episode": c["order"], "title": c["title"],
                "reason": "前言（非正片）" if c["order"] == 0 else
                          f"正文仅 {c['word_count']} 字，过短"}
               for c in todo if too_short_to_break_down(c)]
    todo = [c for c in todo if not too_short_to_break_down(c)]

    if not todo:
        return {"episodes": [], "skipped": skipped,
                "note": ("全部集已拆解" if not skipped else
                         f"没有可拆解的集（跳过 {len(skipped)} 个前言/过短集）")}

    results: list[dict] = []
    total = len(todo)
    done_count = 0
    rlock = asyncio.Lock()

    # 并发拆解全部集；每集拆完立刻进入本集提示词预生成（不等其他集）。
    # 拆解落库由 routes_v2._BREAKDOWN_DB_LOCK 保证 order/资产不竞态；
    # 提示词只写各自 Shot.gen_prompt（按集隔离），天然并发安全。
    # 并发上限：防几十集同时打爆 LLM 网关（网关限流会放大失败率）。
    sem = asyncio.Semaphore(6)

    async def one(ch: dict) -> None:
        nonlocal done_count
        async with sem:
            try:
                out = await do_breakdown(ch["content"], model_id,
                                         project_id, episode=ch["order"],
                                         max_chars=max_chars,
                                         shot_cap_sec=shot_cap)
                entry = {"episode": ch["order"], "title": ch["title"],
                         "shots": len(out.shots)}
                if pregen_prompts:
                    # 本集拆完 → 立即预生成本集提示词（流水线：不等全部集拆完）
                    fb = await _pregen_prompts(project_id, ch["order"], video_model)
                    # 提示词优化失败的镜头数如实上报（B33）：拆解本身成功，
                    # 但这些镜的 gen_prompt 是未经优化的剧本原文，出片质量会明显偏低。
                    # 不报出来用户根本不知道该重跑「✨ 按资产重写」。
                    if fb:
                        entry["prompt_fallbacks"] = fb
            except Exception as e:  # noqa: BLE001
                entry = {"episode": ch["order"], "title": ch["title"],
                         "error": repr(e)[:200]}
        async with rlock:
            results.append(entry)
            done_count += 1
            results.sort(key=lambda r: r["episode"])
            if on_progress:
                on_progress(done_count, total, results)

    await asyncio.gather(*[one(ch) for ch in todo])

    # 收尾重排：并发下先完成的集先编号，order 会与集序错位（第3集镜头排在第2集前）。
    # 统一按 (episode, 原order) 重排为全项目连续 1..N——镜头轨/导出按 order 消费，
    # 必须与集序一致。ref_overrides/版本等挂在 Shot.id 上不受影响，
    # 但音频/字幕锚点是普通整数 order，必须同步搬迁（见下面 _remap_anchors）。
    with get_session() as session:
        all_shots = (session.query(Shot)
                     .filter(Shot.project_id == project_id)
                     .order_by(Shot.episode, Shot.order).all())
        mapping: dict[int, int] = {}
        for i2, sh in enumerate(all_shots, start=1):
            if sh.order != i2:
                mapping[sh.order] = i2
                sh.order = i2
        # 音频/字幕的 start_shot_order 是普通整数、不是外键，不会跟着走。
        # 不搬的话，增量拆完一集之后所有旁白与字幕整体错位到别的镜头上。
        _remap_anchors(session, project_id, mapping)
        session.commit()

    return {"episodes": results, "skipped": skipped, "note": None}


async def run_breakdown_all(jid: str) -> None:
    """拆解 job（一键全部 / 指定集共用）。

    payload = {"project_id": "...", "model_id": null, "force": false,
               "episodes": [2,5] | null}   # null=全部；指定集时隐含 force
    force=false 时跳过已有镜头的集（增量补拆）；进度按集数推进。
    走 job 而非同步接口的原因：长集分块后要串多次 LLM 调用（可达数分钟），
    同步接口会撞 nginx proxy_read_timeout 504。

    实现全在 `breakdown_by_episode`（与一键成片共用），这里只做 job 的收发。
    """
    from .db import Project

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            _update(jid, status="failed", error=f"项目不存在: {project_id}")
            return
        raw = proj.raw_script
    if not raw:
        _update(jid, status="failed", error="项目没有剧本，请先导入")
        return

    _update(jid, status="running", progress=1)

    def _progress(done: int, total: int, results: list[dict]) -> None:
        _update(jid, progress=max(1, int(done / total * 100)),
                result=json.dumps({"episodes": results}, ensure_ascii=False))

    try:
        out = await breakdown_by_episode(
            project_id, raw, p.get("model_id"),
            episodes=p.get("episodes"), force=bool(p.get("force")),
            video_model=p.get("video_model"), on_progress=_progress)
    except Exception as e:  # noqa: BLE001
        _update(jid, status="failed", error=repr(e)[:300])
        return

    results = out["episodes"]
    failed = [r for r in results if "error" in r]
    _update(jid,
            status="failed" if results and len(failed) == len(results) else "done",
            progress=100,
            # 跳过的前言/过短集随最终结果一起回报（C1）：拆解本身成功，
            # 但用户需要知道"为什么第 N 集没有镜头"，否则只会以为是漏拆了
            result=json.dumps({k: v for k, v in out.items() if v is not None},
                              ensure_ascii=False),
            error=_brief_errors(failed) if failed else None)


async def _collect_briefs(project_id: str, rd: dict,
                          model_id: str | None = None) -> dict[str, dict]:
    """收集本次要出图的角色的人物档案（性别/年龄段/身份），供定妆照提示词使用（Q1）。

    ## 为什么按"角色首次出场集"取

    `character_brief` 是**按集**缓存的，而资产图是**全剧共用**的——同一个角色的
    性别与年龄段不会因集数而变（真会变的"少年→中年"属于不同造型阶段，
    由 stage 的 description 区分）。所以每个角色只需取一次：用它**首次出场的那一集**，
    那一集的剧本片段一定包含足够判定其性别身份的上下文。

    这样 N 个角色最多触发 M 次纯文本调用（M = 涉及的不同集数，且 brief 本身
    还有进程内缓存），不会因为角色多就线性放大开销，也不额外花生图的钱。

    任何一集失败都不阻断——拿不到档案就退回"只有造型描述"的旧行为，
    不能让人物档案的问题挡住整条出图链路。
    """
    from .character_brief import character_brief

    # 角色 → 最小集号（stages_no_image 带 ep_from，chars_no_asset 带 episodes 列表）
    first_ep: dict[str, int] = {}
    for row in rd["assets"].get("stages_no_image", []):
        n = row.get("character_name")
        ep = row.get("ep_from") or 1
        if n and (n not in first_ep or ep < first_ep[n]):
            first_ep[n] = ep
    for row in rd["assets"].get("chars_no_asset", []):
        n = row.get("name")
        eps = row.get("episodes") or [1]
        ep = min(eps) if eps else 1
        if n and (n not in first_ep or ep < first_ep[n]):
            first_ep[n] = ep

    if not first_ep:
        return {}

    merged: dict[str, dict] = {}
    for ep in sorted(set(first_ep.values())):
        try:
            brief = await character_brief(project_id, ep, model_id)
        except Exception as e:  # noqa: BLE001 档案拿不到就退回旧行为
            log.warning("[briefs] 第 %s 集人物档案获取失败，该集角色退回无档案: %r", ep, e)
            continue
        for name, info in (brief or {}).items():
            # 只收本轮真正要出图、且首次出场正是这一集的角色
            if first_ep.get(name) == ep and name not in merged:
                merged[name] = info
    log.info("[briefs] 为 %d/%d 个待出图角色取到人物档案",
             len(merged), len(first_ep))
    return merged


def _look_line(project_id: str) -> str:
    """读该项目影调档案并拼成一句话；没有档案返回空串（= 改动前口径）。

    首帧图与场景基准帧走这条**同步**读取，而不是把 `look` 一路当参数传下来：
    `_gen_first_frame` / `_ensure_scene_anchor` 的调用点有六处（批量首帧、
    run_shot_videos、重生成、锚点预热……），逐个加参数必然漏掉一两处，
    而漏掉的那条路径出的图就是"没影调"的——正是本次要修的病症。
    从库里读则**没有漏的可能**：只要 `_collect_look` 在批次入口写过，
    所有下游都拿到同一份。

    读的是一行 SQLite（项目行的一列），每镜一次的开销可忽略；
    且与 `asset_prompt` 用的是**同一份档案**，资产图与成片影调必然对齐。
    """
    try:
        from . import look_profile as lp
        return lp.phrase(lp.load(project_id))
    except Exception as e:  # noqa: BLE001 影调是增强项，绝不阻断出图
        log.warning("[look] 读取影调档案失败，本图退回无影调提示词: %r", e)
        return ""


def _style_of(project_id: str):
    """读该项目的**画风预设**（`style_preset.Style`）。永不失败，兜底都市档。

    与 `_look_line` 同款的同步读库，理由也相同、且更强烈：画风的注入点比影调
    还多（首帧句、场景基准图句、视频提示词、五处资产图），把 `style` 一路当
    参数传下去必然漏，而漏掉的那条路径出的图就是"画风没生效"的——动漫剧里
    突然冒出一张实拍照，比没影调刺眼得多。

    ⚠️ 画风**不是一个前缀**：`Style` 同时带着与前缀同向的否定项、首帧句、
    基准图句与质感词。只换前缀会与残留的「禁止动漫」自相矛盾，见 style_preset 模块头。
    """
    from . import style_preset as sp
    return sp.load(project_id)


async def _collect_look(project_id: str) -> dict | None:
    """取（必要时生成）全片**影调档案**，供所有资产图/首帧提示词使用。

    与 `_collect_profiles` 同款语义：只补缺的，绝不覆盖已有档案
    （尤其 `status=confirmed` 的——用户手调过的影调比 AI 猜的金贵）。
    失败返回 None，`asset_prompt` 自动不拼影调句 = 改动前行为。

    用户 2026-09-09 反馈「不同图片画面色调不统一」的**主要**修法：
    此前提示词里一个字的影调约束都没有，每张图各自决定一套色温/反差/饱和。
    """
    from . import look_profile as lp
    try:
        return await lp.ensure(project_id)
    except Exception as e:  # noqa: BLE001 影调是增强项，绝不阻断出图
        log.warning("[look] 影调档案获取失败，本轮退回无影调提示词: %r", e)
        return None


def _scene_view_items(session, project_id: str, title: str, names: list[str],
                      look: dict | None) -> list[dict]:
    """把「缺图的场景名」摊成**多视角参考图**的生图条目（8 张/场景）。

    唯一定义处 —— 一键成片与首帧流水线两条入口共用。
    （`asset_prompt` 模块头记过教训：这类拼装散落成两份拷贝，就一定会
    "一键成片修好了、首帧流水线还是老样子"，且两条路产出的图不一致。）

    每个场景补齐 8 行 `SceneView`（`scene_view.ensure_views` 幂等，
    会**认领**老项目已有的那张 `Asset.image_url` 当主视角，不重复花钱），
    只为**没有图的**视角建条目。所以：
    · 全新场景 → 8 条；
    · 老项目已有一张图的场景 → 7 条（主视角被认领）；
    · 已经齐了的场景 → 0 条。

    调用方负责 commit。
    """
    from .scenes import ensure_location_asset
    items: list[dict] = []
    for name in names:
        # run_asset_batch 按 scene_view_id 回写；没有资产行就等于生成了写不进去。
        # 拆解只往 Shot.location 落名字，未必建过资产行，这里补建；
        # 老项目里那行按原名建的资产会被就地改名认领，而不是另起一行。
        a = ensure_location_asset(session, project_id, name)
        session.commit()
        items += scene_view_items_for_asset(session, a, title, look)
        session.commit()
    return items


def scene_view_items_for_asset(session, asset, title: str, look: dict | None,
                               view_keys: list[str] | None = None) -> list[dict]:
    """一个场景资产 → 多视角参考图的生图条目。**提示词只在这里拼**。

    `view_keys`：
      · None/空 → 只补**还没有图**的视角（批量补资产、一键成片走这条）；
      · 给了 key → 无论有没有图都重画这几张（资产弹窗「重画这一张」走这条）。

    调用方负责 commit。`session` 里的 `SceneView` 行会被 `ensure_views` 幂等补齐。
    """
    from . import scene_view as sv
    rows = sv.ensure_views(session, asset)
    if view_keys:
        want = set(view_keys)
        rows = [r for r in rows if r.view_key in want]
    else:
        rows = [r for r in rows if not (r.image_url or "").strip()]
    desc = asset.prompt or None
    # 画风就地读库，不从调用方传：本函数有两个入口（一键成片/批量补资产走
    # `_scene_view_items`，资产弹窗「重画这一张」走 routes_v2），
    # 加参数就得两处都记得传，漏一处那条路径出的图就没画风。
    style = _style_of(asset.project_id)
    out: list[dict] = []
    for row in rows:
        v = sv.BY_KEY[row.view_key]
        out.append({
            "name": f"场景-{asset.name}（{v.label}）",
            "scene_view_id": row.id,
            "scene_asset_id": asset.id,
            "primary": v.primary,
            "prompt": scene_prompt(asset.name, description=desc, title=title,
                                   view=v.phrase, view_label=v.label,
                                   look=look, style=style),
        })
    return out


async def _collect_profiles(project_id: str, rd: dict,
                            model_id: str | None = None) -> dict[str, dict]:
    """收集本次要出图的角色的**形象档案**（骨相/肤色/五官/气质），供定妆照提示词使用。

    与 `_collect_briefs` 的分工见 `character_profile` 模块开头：
    brief 管"人称与年龄"（按集判、进程内缓存），档案管"长什么样"（全剧一份、落库）。

    只补缺的：已有档案的角色一律跳过——档案定下来就等于这张脸定下来了，
    不该被下一次点击悄悄改掉。重生成走用户显式操作。

    失败不阻断：拿不到档案，`character_prompt` 自动退回旧的扁平口径。
    """
    from .character_profile import ensure_profiles

    names: list[str] = []
    for row in rd["assets"].get("stages_no_image", []):
        n = row.get("character_name")
        if n and n not in names:
            names.append(n)
    for row in rd["assets"].get("chars_no_asset", []):
        n = row.get("name")
        if n and n not in names:
            names.append(n)
    if not names:
        return {}
    try:
        profiles = await ensure_profiles(project_id, names, model_id)
    except Exception as e:  # noqa: BLE001 档案是增强项，绝不阻断出图
        log.warning("[profiles] 形象档案获取失败，本轮退回无档案提示词: %r", e)
        return {}
    log.info("[profiles] 为 %d/%d 个待出图角色取到形象档案",
             sum(1 for n in names if n in profiles), len(names))
    return profiles


async def _pregen_prompts(project_id: str, episode: int,
                          video_model: str | None) -> int:
    """拆解后预生成提示词（"拆解镜头并生成提示词"的第二阶段）。

    返回**回退为剧本原文的镜头数**（0 = 全部优化成功）。调用方据此在 job
    result 里如实标注，见下面 except 分支的说明（B33）。

    按项目 production_mode 映射的视频模型选提示词框架；无框架的模型（veo）
    直通=gen_prompt 就是拆解原文。单镜失败不阻塞（生成时可再优化兜底）。

    必须带上**人物档案**（性别/身份）：中文剧本里人名不带性别，逐镜优化时
    优化器只能猜代词——实测 85 镜里 20 镜把女主写成 he/his/him、21 镜写成
    man/male，全能参考路线下参考图被提示词直接顶掉，女主变成男人。
    档案按集缓存，一集只多花一次纯文本调用。
    服装不在这里锚定（此刻资产尚未生成），由出片时的 ctx 负责（见 run_shot_videos）。
    """
    from .character_brief import (brief_context, character_brief,
                                  fix_pronoun_instruction, pronoun_conflict)
    from .config import get_settings
    from .db import Project
    from .prompt_opt import optimize_to_prompt
    from .routes_v2 import PRODUCTION_MODES

    with get_session() as session:
        proj = session.get(Project, project_id)
        mode_model = _resolve_project_video_model(proj)  # 修复：custom 项目此前漏读 default_profile
        model_id = video_model or mode_model or get_settings().video_model
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id, Shot.episode == episode)
                 .order_by(Shot.order).all())
        plan = [(s.id, s.script_ref, s.duration_sec,
                 _effective_characters(s)) for s in shots]

    brief = await character_brief(project_id, episode)
    # 把形象档案的**气质**回灌进逐镜档案（只读已落库的，不在这里触发生成）。
    # 刻意只回灌气质、不回灌五官：逐镜已经带定妆图当参考，提示词里再写
    # 「丹凤眼」只会和参考图打架——那正是本模块开头记录的那类 bug。
    # 气质是表演指导（"隐忍克制"），不描述长相，与参考图不冲突。
    try:
        from .character_profile import load_profiles, merge_into_brief
        brief = merge_into_brief(brief, load_profiles(project_id))
    except Exception as e:  # noqa: BLE001 档案是增强项，不能挡住提示词生成
        log.warning("[profiles] 逐镜档案回灌失败，按无档案继续: %r", e)

    fallbacks = 0
    for sid, ref, dur, chars in plan:
        try:
            parts: list[str] = []
            if dur:
                # 甜点区间：拆解已按 7-15s（目标 8-12s）组织节拍，提示词的
                # 分镜节奏必须按这个时长铺满，不能写成三秒就演完的内容。
                # ⚠️ 铺满要靠**表演**而不是运镜：这里原本写「动作与运镜必须铺满」，
                # 优化器就逐镜加推镜，成片每个镜头都在往人脸上怼（2026-09-02 反馈）。
                parts.append(f"目标时长: {dur:.2f} 秒"
                             f"（提示词的人物动作与表演必须铺满这个时长，"
                             f"可在片段内分 2-3 个连续小节，不要写只够三四秒的内容；"
                             f"机位默认固定，不要用运镜来凑时长）")
            bc = brief_context(brief, chars)
            if bc:
                parts.append(bc)
            # 同场连续戏的空间/走位延续。这一段是**纯剧本推导**（不依赖资产），
            # 所以拆解阶段就能给：本函数按 order 顺序串行跑，段首镜的提示词
            # 已经写好，后续镜头能直接锚到它，草稿阶段就不会一镜一个房间。
            parts.extend(_scene_run_ctx(sid))
            ctx = "; ".join(parts) if parts else None
            prompt = await optimize_to_prompt(ref, video_model_id=model_id,
                                              extra_context=ctx)
            # 确定性人称自检 + 一次重写（生成时还会再查一遍，双保险）
            conflict = pronoun_conflict(prompt, brief, chars) if brief else None
            if conflict:
                log.warning("[pregen %s] 人称冲突，重写：%s", sid, conflict)
                prompt = await optimize_to_prompt(
                    prompt, video_model_id=model_id,
                    extra_context="; ".join(
                        (parts or []) + [fix_pronoun_instruction(conflict)]))
        except Exception as e:  # noqa: BLE001
            # 回退为剧本原文，但**必须留下痕迹**（B33）。
            # 原来是光秃秃的 `except Exception: prompt = ref`：LLM 网关挂掉/
            # 限流时每一镜都静默回退，日志里一个字都没有，而 gen_prompt 照样
            # 写进库、stale=0、prompt_state="draft" —— 与"优化成功"完全无法区分。
            # 用户看到的是"拆解并生成提示词 已完成"，实际拿到的是一整集未经优化的
            # 剧本原文；等到出片才发现镜头质量普遍不对，且不知道该重跑哪一步。
            log.warning("[pregen %s] 提示词优化失败，回退剧本原文: %r", sid, e)
            prompt = ref
            fallbacks += 1
        with get_session() as session:
            shot = session.get(Shot, sid)
            if shot:
                shot.gen_prompt = prompt
                # 刚按当前 script_ref 拆解并写了新提示词 → 提示词与拆解都是最新的，
                # 原因一并清掉（只清 stale=0、留着 stale_reason 会让后续判定
                # 拿一个"没过期但有过期原因"的矛盾状态去分支）。
                stale_mod.clear_stale(shot)
                # 拆解初稿：此刻资产还没生成，服装与人称都只是按剧本猜的。
                # 出片前会按当前资产重新对齐（run_shot_videos / run_reprompt）。
                shot.prompt_state = "draft"
                session.commit()

    if fallbacks:
        log.warning("[pregen] 项目 %s 第 %s 集：%d/%d 镜提示词优化失败，已回退剧本原文",
                    project_id, episode, fallbacks, len(plan))
    return fallbacks


async def run_reprompt(jid: str) -> None:
    """按**当前资产**重新生成镜头提示词（不出图、不出片，只花文本模型的钱）。

    payload = {
      "project_id": "...",          # 必填
      "shot_ids": ["..."] | null,   # 缺省 = 该项目全部待出片镜头
      "episode": null,              # 只重算某一集（与 shot_ids 二选一）
    }

    ## 为什么需要它

    镜头卡上的「✨ 提示词」是**拆解时**写的初稿——那会儿资产一张都还没生成，
    服装只能凭剧本猜、人称只能凭人名猜。真正与资产对齐的改写发生在
    `run_shot_videos` 里、**点了生成之后**。于是用户在卡片上看到的，和视频模型
    实际吃到的，是两份不同的东西；想在出片前先把提示词校对一遍根本无从下手。

    本 job 把出片时那套对齐逻辑（`_build_prompt_ctx` + 优化 + 人称自检）
    单独跑一遍并写回 `gen_prompt`，`prompt_state` 置 `aligned`：
    **先对齐、再审、后出片**，而不是花了视频的钱才发现衣服穿错。

    并发：文本调用走 `settings.default_concurrency`（已有配置，不新增不下调）。
    单镜失败保留原稿并记入 result，不中断整批。
    """
    from .character_brief import fix_pronoun_instruction, pronoun_conflict
    from .config import get_settings
    from .db import Project
    from .prompt_opt import optimize_to_prompt_detailed, optimize_full

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return
    shot_ids = p.get("shot_ids")
    episode = p.get("episode")

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            _update(jid, status="failed", error=f"项目不存在: {project_id}")
            return
        model_id = (_resolve_project_video_model(proj)
                    or get_settings().video_model)
        proj_gen_mode, _ = _resolve_project_gen_settings(proj)
        q = session.query(Shot).filter(Shot.project_id == project_id)
        if shot_ids:
            q = q.filter(Shot.id.in_(list(shot_ids)))
        elif episode is not None:
            q = q.filter(Shot.episode == int(episode))
        rows = q.order_by(Shot.order).all()
        # 外部素材/停用镜头没有提示词可言（与 run_shot_videos 过滤口径一致）
        plan = [(s.id, s.order, s.script_ref, s.gen_prompt, s.duration_sec,
                 json.loads(s.profile_override) if s.profile_override else {})
                for s in rows if not s.disabled and not s.is_special]

    if not plan:
        _update(jid, status="done", progress=100,
                result=json.dumps({"shots": [], "note": "没有需要重算提示词的镜头"},
                                  ensure_ascii=False))
        return

    _update(jid, status="running")
    # 与出片链路同口径：先幂等补齐场景描述，否则"按当前资产重算提示词"
    # 重算出来的提示词依然会各自发明陈设（用户看到的和实际出片一样漂移）。
    # 同样不传本函数的 model_id——那是视频模型，不是文本模型。
    await ensure_scene_descriptions(project_id)
    provider = registry.get_video(model_id)
    results: list[dict] = []
    done_count = 0
    lock = asyncio.Lock()
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))

    async def _report() -> None:
        _update(jid, progress=int(done_count / len(plan) * 100),
                result=json.dumps({"stage": "reprompt", "done": done_count,
                                   "total": len(plan)}, ensure_ascii=False))

    async def _one(sid: str, order: int, script_ref: str, _pregen: str | None,
                   duration: float | None, override: dict) -> None:
        nonlocal done_count
        # 取消检查点：不硬杀协程，但不再为**这一镜**发起上游请求。
        #
        # 这里只查自己的 jid：reprompt 是独立 job，不是一键成片的子任务。
        # （run_asset_batch / run_shot_videos / run_first_frames 才需要
        #  parent_jid 传导父级取消——它们会被一键成片当子任务调起。）
        if is_cancelled(jid):
            return
        async with sem:
            try:
                # 用户手填了提示词 → 一切自动改写让位（与 run_shot_videos 同优先级）
                if override.get("prompt"):
                    with get_session() as session:
                        sh = session.get(Shot, sid)
                        if sh:
                            sh.prompt_state = "manual"
                            session.commit()
                    async with lock:
                        results.append({"order": order, "skipped": "手填提示词"})
                        done_count += 1
                        await _report()
                    return

                shot_mode = override.get("generation_mode") or proj_gen_mode
                explicit = override.get("ref_urls") or []
                # 走首帧路线时按生图侧上限注入，否则按视频模型的参考图能力
                # （与 run_shot_videos 的 inject_cap 同口径，否则预览与实际不符）
                # provider 为 None = 项目存的视频模型已下线/改名。出片会在那一步
                # 明确报错，但**提示词照样该能对齐**（纯文本、不碰模型能力），
                # 所以这里退到"非首帧 + 保守参考图上限"继续跑，不整批失败。
                will_use_ff = (shot_mode == "i2va" and provider is not None
                               and provider.mode_support()
                               .get("i2va", {}).get("available", False))
                if will_use_ff or provider is None:
                    cap = _FRAME_REF_LIMIT
                else:
                    cap = getattr(provider, "max_reference_images", 0)
                labels: list[str] = []
                notes: list[str] = []
                urls: list[str] = explicit
                if not explicit:
                    urls, labels, notes = _auto_inject_refs_detailed(sid, cap)
                # 首帧路线：出片时参考图已固化进首帧，不再下发给视频模型
                ref_count = 0 if will_use_ff else len(urls)
                ctx, brief, chars = await _build_prompt_ctx(
                    sid, project_id, model_id,
                    gen_mode=("i2va" if will_use_ff else None),
                    duration_ms=int(duration * 1000) if duration else None,
                    used_first_frame=will_use_ff,
                    ref_count=ref_count,
                    injected_labels=labels, injected_notes=notes,
                    explicit_refs=bool(explicit))
                # ⚠️ 必须用 script_ref 而不是 pregen：
                # 原先写的是 `pregen or script_ref`，于是只要这镜已经有过
                # gen_prompt，重算就永远拿旧提示词当输入——用户改了 script_ref
                # （比如把触发内容审核的词换掉）点「重新生成提示词」，
                # 结果一字未变，因为新的 script_ref 压根没进优化器。
                # reprompt 的语义就是"按当前拆解重写"，输入只能是拆解真值。
                prompt, fb, blocking = await optimize_full(
                    script_ref, video_model_id=model_id,
                    extra_context="; ".join(ctx))
                # 3.9：重出提示词同样刷新走位台账 —— 不刷的话，用户改完拆解
                # 重算一遍，本镜的画面变了、下一镜却还按旧台账接位置。
                _save_blocking(sid, blocking)
                if fb:
                    log.warning("[reprompt %s] 提示词优化降级：%s", order, fb)
                conflict = pronoun_conflict(prompt, brief, chars) if brief else None
                if conflict:
                    log.warning("[reprompt %s] 人称冲突，重写：%s", order, conflict)
                    prompt, _ = await optimize_to_prompt_detailed(
                        prompt, video_model_id=model_id,
                        extra_context="; ".join(
                            ctx + [fix_pronoun_instruction(conflict)]))
                with get_session() as session:
                    sh = session.get(Shot, sid)
                    if sh:
                        sh.gen_prompt = prompt
                        sh.prompt_state = "aligned"
                        # 提示词已按当前 script_ref 重写 → reprompt 的诉求已满足，
                        # 降到 regen（"片子还是旧的"）。rebreak 不动：切分仍是错的。
                        if sh.stale:
                            sh.stale_reason = stale_mod.after_reprompt(sh.stale_reason)
                        session.commit()
                publish(project_id, "shot",
                        {"id": sid, "gen_prompt": prompt, "prompt_state": "aligned"})
                async with lock:
                    results.append({"order": order, "ok": True,
                                    "fallback": fb, "refs": len(urls)})
            except Exception as e:  # noqa: BLE001 单镜失败保留原稿，不拖垮整批
                log.warning("[reprompt %s] 失败：%r", order, e)
                async with lock:
                    results.append({"order": order, "ok": False,
                                    "error": f"{type(e).__name__}: {str(e)[:160]}"})
            async with lock:
                done_count += 1
                await _report()

    await asyncio.gather(*(_one(*item) for item in plan))
    ok = sum(1 for r in results if r.get("ok"))
    _update(jid, status="done", progress=100,
            result=json.dumps({"shots": sorted(results, key=lambda r: r["order"]),
                               "ok": ok, "total": len(plan)}, ensure_ascii=False))


#: 中文 TTS 的语速上限（字/秒）。实测同批 78 段旁白：中位 5.78、最高 6.7；
#: 人声播报的物理极限约 10-12。取 15 是为了**只抓不可能的值**，
#: 不误伤"这段念得比较快"。
_TTS_MAX_CPS = 15.0
#: 太短的文本比值噪声大（2 个字 0.2s 完全正常），不参与判定
_TTS_MIN_CHARS = 8


def _tts_truncated(text: str, dur: float) -> bool:
    """TTS 返回的音频是不是被截断了。

    ⚠️ 这一层此前**不存在**：provider 返回什么就落什么，`status` 直接写 `done`。
    实测出现过 **87 字 / 1.056s（82.4 字每秒）** 的返回——文件真的只有 12KB，
    里面只念了开头一两个字。

    它的破坏力不止于旁白本身：紧接着 `_sync_shot_duration` 会拿这个时长去改
    `Shot.duration_sec`，于是**画面也被缩成 1.5s**，再照这个长度把视频生成出来。
    等能看出不对的时候，错的已经是成片，而且全程没有任何报错——
    旁白是 `done`、镜头是 `adopted`。

    只判"短得不可能"这一侧：长得离谱通常是 provider 补了静音尾巴，
    有 `shot_seconds_cap` 钳着，危害小得多。
    """
    t = (text or "").strip()
    if len(t) < _TTS_MIN_CHARS or dur <= 0:
        return False
    return len(t) / dur > _TTS_MAX_CPS


async def run_tts_batch(jid: str) -> None:
    """P2-4 TTS 批量合成：payload={"project_id", "clip_ids":[...]}。

    串行逐段合成（单段约 60-70s；RunningHub 单 KEY 串行最稳），每段完成即落库
    url/duration/status，前端轮询 audio-clips 逐段点亮。参考音色同批只上传一次
    （按 voice_ref_url 分组缓存 fileName）。
    """
    from .db import AudioClip
    from .media import probe_duration_local
    from .providers.tts import TTSProvider

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    clip_ids = p.get("clip_ids") or []

    provider = TTSProvider()
    if not provider.available:
        _update(jid, status="failed", error="TTS 未配置（缺 RunningHub key/工作流）")
        return

    with get_session() as session:
        q = (session.query(AudioClip)
             .filter(AudioClip.project_id == project_id,
                     # narration = 解说剧按剧本切出来的旁白，与手工 tts 走同一条合成链
                     AudioClip.kind.in_(("tts", "narration"))))
        if clip_ids:
            q = q.filter(AudioClip.id.in_(clip_ids))
        else:
            q = q.filter(AudioClip.status.in_(("pending", "failed")))
        plan = [(a.id, a.text or "", a.voice_ref_url or "") for a in q.all()]

    if not plan:
        _update(jid, status="done", progress=100,
                result=json.dumps({"clips": [], "note": "没有待合成的旁白"},
                                  ensure_ascii=False))
        return

    _update(jid, status="running")
    # 参考音色缓存：同一素材同批只上传一次
    ref_cache: dict[str, str] = {}
    results: list[dict] = []

    def _set(cid: str, **fields) -> None:
        with get_session() as session:
            a = session.get(AudioClip, cid)
            if a:
                for k, v in fields.items():
                    setattr(a, k, v)
                session.commit()
                # P2-5 SSE：旁白段状态（generating/done/failed）实时点亮
                publish(a.project_id, "audio", {"id": cid, "status": a.status})

    def _sync_shot_duration(cid: str, dur: float) -> str | None:
        """解说剧：用旁白实际时长驱动镜头时长，声画才能同步。

        只对 kind="narration" 生效——那是照剧本切出来的解说词，
        画面本来就是给旁白配的，旁白多长画面就该多长。
        手工加的 tts 旁白不动镜头（用户是往既有画面上叠旁白，不是反过来）。

        写的是 Shot.duration_sec（AI 拆镜判定的时长），视频生成时以它为目标。
        已经出过片的镜头会被标 stale——时长变了，旧视频对不上新旁白，需重出。

        ⚠️ 必须钳上限：切分阶段已按估算控过长度，但估算会偏
        （语速受标点/数字/语气词影响）。不钳的话一段估错的旁白就能写出
        35s 的镜头，视频生成必爆显存——实测已发生。
        钳掉的部分旁白会比画面长，导出时尾部旁白盖在下一镜上，
        比整批生成失败可接受得多。

        返回被改动的镜头 id，未改动返回 None。
        """
        from .db import Shot, Project
        from .routes_v2 import shot_seconds_cap, profile_of
        if dur <= 0:
            return None
        with get_session() as session:
            a = session.get(AudioClip, cid)
            if not a or a.kind != "narration" or not a.source_shot_id:
                return None
            shot = session.get(Shot, a.source_shot_id)
            if not shot:
                return None
            # 上限跟着**项目分辨率 + 视频模型**走，与拆镜阶段同源（同一个函数）：
            # 0.5MP 允许 38s 的长镜，若这里仍按固定 12s 钳，
            # 拆镜精心留出的长镜会被硬砍成 12s，旁白大段盖到下一镜。
            proj = session.get(Project, shot.project_id)
            cap, _mp = shot_seconds_cap(profile_of(proj))
            # 留 0.4s 尾巴：旁白结束瞬间就切镜听感太赶
            target = round(min(dur + 0.4, cap), 2)
            if abs((shot.duration_sec or 0) - target) < 0.05:
                return None            # 已经对上了，别白标 stale
            shot.duration_sec = target
            if shot.video_url:
                # 时长变了，已有视频与新旁白对不上，标记待重生成。
                # regen = 最轻一档：画面依据（script_ref）一个字没变，
                # 提示词照用，重出片即可。mark_stale 只升不降，所以如果这镜
                # 本来因改剧本挂着 rebreak/reprompt，不会被这一下悄悄降级。
                stale_mod.mark_stale(shot, stale_mod.REGEN)
            session.commit()
            return shot.id

    retimed: list[str] = []
    done_n = 0
    # 参考音色上传要串行化：多个任务同时发现"缓存里没有"会各传一遍同一个文件，
    # 白白多花几十秒还可能拿到不同的 fileName。用锁把首次上传收敛成一次。
    ref_lock = asyncio.Lock()

    async def _ensure_ref(ref_url: str) -> str:
        if ref_url in ref_cache:
            return ref_cache[ref_url]
        async with ref_lock:
            if ref_url in ref_cache:      # 等锁期间别人可能已经传好了
                return ref_cache[ref_url]
            local = await _resolve_media_local(ref_url)
            if local is None:
                raise RuntimeError(f"参考音色不在本地: {ref_url}")
            ref_cache[ref_url] = await provider.upload_ref_voice(local)
            return ref_cache[ref_url]

    async def _one(cid: str, text: str, ref_url: str) -> None:
        nonlocal done_n
        try:
            if not ref_url:
                raise RuntimeError("未选择参考音色（先在素材池上传一段人声）")
            name = await _ensure_ref(ref_url)
            _set(cid, status="generating", error=None)
            # 闸门只圈住真正打远端的那一段；落库/探时长不占并发额度
            async with _tts_gate():
                url = await provider.synth(name, text)
            dur = await probe_duration_local(url)
            # 截断兜底（见 _tts_truncated）：重合成一次，仍然截断就当失败。
            # 宁可这一段留 failed 让用户看见并重试，也不能把 1 秒的旁白
            # 当成 done —— 那会顺手把镜头时长也改错，然后照错的长度出片。
            if _tts_truncated(text, dur):
                async with _tts_gate():
                    url2 = await provider.synth(name, text)
                dur2 = await probe_duration_local(url2)
                if _tts_truncated(text, dur2):
                    raise RuntimeError(
                        f"TTS 返回的音频明显短于文本（{len(text.strip())} 字 / "
                        f"{dur2:.2f}s = {len(text.strip()) / max(dur2, 1e-6):.1f} 字每秒，"
                        f"上限 {_TTS_MAX_CPS}），重合成一次后仍然如此")
                url, dur = url2, dur2
            # 6.9：重新合成 = **换素材**，修剪窗口必须一起清掉。
            # 窗口 [clip_in_sec, +clip_dur_sec) 是相对某一个具体 url 的坐标，
            # 新旁白长度不同，旧坐标就指向了另一段内容 —— 用户把旁白剪成
            # "第 2.4s 起的 3s"、改了文本重合成、新音频只有 2.6s，导出就
            # `-ss 2.4 -t 3` 取到一段空白，而时间轴上仍然显示 3s。
            # 与 db.py `reset_clip_window` 是同一个道理、同一类静默损坏。
            _set(cid, url=url, duration=dur, status="done",
                 clip_in_sec=None, clip_dur_sec=None)
            changed = _sync_shot_duration(cid, dur)
            if changed:
                retimed.append(changed)
            results.append({"id": cid, "url": url, "duration": dur})
        except Exception as e:  # noqa: BLE001
            _set(cid, status="failed", error=repr(e)[:300])
            results.append({"id": cid, "error": repr(e)[:300]})
        finally:
            done_n += 1
            _update(jid, progress=int(done_n / len(plan) * 100),
                    result=json.dumps({"clips": results}, ensure_ascii=False))

    # 并发合成：各段互不依赖，串行只是白等（一集几十段 × 60s 就是一小时）。
    # 单段失败不牵连其他段——_one 内部已吞异常并落 failed 状态。
    await asyncio.gather(*(_one(cid, text, ref) for cid, text, ref in plan))

    failed = [r for r in results if "error" in r]
    _update(jid,
            status="failed" if len(failed) == len(plan) else "done",
            result=json.dumps({"clips": results, "retimed_shots": retimed},
                              ensure_ascii=False),
            error=_brief_errors(failed) if failed else None)


async def _resolve_media_local(url: str):
    """/fw/media/... → 本地 Path；参考音色是视频时抽音轨转 wav 再上传。

    ## 为什么必须是 async（2026-09-11 修 B1）

    这里原来用的是同步 `subprocess.run(ffmpeg, timeout=120)`。它跑在
    `_ensure_ref` 里，而 `_ensure_ref` 是 async ——**同步 subprocess 会把整个
    事件循环钉住**。后端是单进程 asyncio，那 120 秒里：所有 HTTP 请求排队、
    SSE 全部静默、其他并发任务集体暂停。用户看到的是"第一次用某段视频当参考
    音色，整个网站卡死两分钟"，而且因为没有任何报错，只会以为是网络问题。

    改用 `media._run`（`asyncio.create_subprocess_exec` + `wait_for`）：
    同样带超时、超时同样 kill 子进程，但等待期间事件循环照常跑。

    ## 派生 wav 落 generated/ 而不是源文件旁边（N2）

    原来是 `p.with_suffix(".refvoice.wav")` —— 落在 `uploads/`、且是**后缀**。
    两个后果：
      · `_scan_generated_orphans` 只扫 `GENERATED_DIR`，所以它**永远回收不掉**；
      · 就算去扫 uploads，那里放的是用户上传的原件，误删代价完全不同。
    改落 `generated/refvoice_<源文件 id>.wav` 后，它变成一个和缩略图同性质的
    **可重建派生缓存**：不落任何库、必然被认成孤儿、24h 后自动回收，
    下次要用再花几秒重抽。文件名带源 id 是为了排障时能一眼看出它来自谁。
    """
    from .media import GENERATED_DIR, _resolve_local, _run
    p = _resolve_local(url)
    if p is None or not p.is_file():
        return None
    if p.suffix.lower() in (".mp4", ".mov", ".mkv", ".webm"):
        # 视频素材：抽前 15s 音轨为 wav（IndexTTS 参考音色 15s 内即可）
        wav = GENERATED_DIR / f"refvoice_{p.stem}.wav"
        if not wav.is_file():
            code, out = await _run(
                ["ffmpeg", "-y", "-v", "error", "-i", str(p), "-t", "15",
                 "-vn", "-ar", "44100", "-ac", "1", str(wav)], timeout=120.0)
            if code != 0 or not wav.is_file():
                log.warning("[tts] 参考音色抽音轨失败 code=%s: %s", code, out[-300:])
                return None
        return wav
    return p


async def run_first_frames(jid: str, progress_cb=None, phase_jid: str | None = None,
                           parent_jid: str | None = None) -> None:
    """批量生成镜头首帧图（「🎬 一键生成全部镜头首帧」）。

    payload = {
      "project_id": "...",          # 必填
      "shot_ids": ["..."] | null,   # 缺省 = 就绪度体检算出的「缺首帧」集合
      "image_model": null,          # 覆盖项目预设的生图模型
      "force": false                # true = 已有首帧也重生（选中集合内全量）
    }

    为什么单独成 job 而不是复用 run_shot_videos 的内联补帧：
    首帧几毛、视频几块。先把全片首帧铺出来人工过一遍，再决定哪些去出片，
    比"边生成边发现场景偏移"省得多，也是本模块存在的全部意义。

    并发：用**已有**的 `settings.default_concurrency`（生图侧），
    视频池 `video_concurrency` 完全不受影响（遵并发铁律，不新增也不下调任何并发数）。
    场景锚点竞态由现成的 `_anchor_lock` 处理（同场景只出一张基准帧，不重复烧钱）。
    单镜失败记入 result 不中断整批（与 run_asset_batch 同语义）。
    """
    from .config import get_settings
    from .db import Project
    from .readiness import compute_readiness

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    force = bool(p.get("force"))
    shot_ids = p.get("shot_ids")
    if not shot_ids:
        rd = compute_readiness(project_id)
        if rd.get("error"):
            _update(jid, status="failed", error=f"项目不存在: {project_id}")
            return
        if force:
            # 全量重生：本轮待出片且走 i2va 的镜头全部重画首帧
            with get_session() as session:
                rows = (session.query(Shot).filter(Shot.project_id == project_id)
                        .order_by(Shot.order).all())
                proj = session.get(Project, project_id)
                proj_gen_mode, _ = _resolve_project_gen_settings(proj)
                shot_ids = [
                    s.id for s in rows
                    if not s.disabled and not s.is_special and not s.video_url
                    and ((json.loads(s.profile_override).get("generation_mode")
                          if s.profile_override else None) or proj_gen_mode) == "i2va"
                ]
        else:
            shot_ids = [m["id"] for m in rd["first_frames"]["missing"]]

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            _update(jid, status="failed", error=f"项目不存在: {project_id}")
            return
        proj_aspect = proj.base_aspect or "9:16"
        _, proj_image_model = _resolve_project_gen_settings(proj)
        rows = (session.query(Shot)
                .filter(Shot.project_id == project_id, Shot.id.in_(list(shot_ids)))
                .order_by(Shot.order).all())
        # 外部素材/停用镜头不生首帧（与 run_shot_videos 的过滤口径一致）
        plan = [(s.id, s.order, s.episode, s.location, s.script_ref, s.gen_prompt,
                 json.loads(s.profile_override) if s.profile_override else {})
                for s in rows if not s.disabled and not s.is_special]

    if not plan:
        _update(jid, status="done", progress=100,
                result=json.dumps({"frames": [], "note": "没有需要生成首帧的镜头"},
                                  ensure_ascii=False))
        return

    _update(jid, status="running")
    results: list[dict] = []
    done_count = 0
    lock = asyncio.Lock()
    gate = _image_gate()
    ph_jid = phase_jid or jid

    # ---- ① 场景基准帧预热（避免并发槽被锚点锁占死）----
    # plan 按 order 排，相邻镜头几乎都属同一场景。若不预热，前 N 个槽会被同场景
    # 镜头占满，其中 1 个去建锚点、其余 N-1 个**占着并发槽干等 _anchor_lock**，
    # 整池吞吐塌成 1；每换一个场景塌一次，K 个场景 = K 次串行等待。这就是
    # "明明 gather 了却一张一张出"的真正原因。先并发把锚点铺好，阶段②才是真并发。
    #
    # 代表镜取该场景 order 最小的一镜（plan 已排序）：其参考图即今天竞态胜者
    # 实际会取到的那份，行为不变，只是从"看谁抢到"变成确定性的。
    #
    # 去重按**归一场景名**：同一个房间在不同集里写法不同（实测跨集复用率 0），
    # 按原名去重会给同一个房间预热 N 张锚点——既多烧 N-1 次生图钱，又在
    # `_ensure_scene_anchor` 的归一锁上互相干等，白白抵消预热的意义。
    from .scenes import canonical_map as _canon_map
    with get_session() as _s:
        _canon = _canon_map(_s, project_id)

    def _canon_of(loc: str) -> str:
        return _canon.get(loc) or loc

    scene_rep: dict[str, tuple[str, dict, int, str]] = {}
    for sid, _order, episode, location, _sref, _pregen, override in plan:
        if location:
            scene_rep.setdefault(_canon_of(location),
                                 (sid, override, episode, location))
    anchors: dict[str, str | None] = {}
    anchor_done = 0
    # 锚点阶段占进度前 15%（K 张锚点相对 N 张首帧通常是小头）
    anchor_pct = 15 if scene_rep else 0

    async def _warmup(canon: str, sid: str, override: dict,
                      episode: int, location: str) -> None:
        nonlocal anchor_done
        async with gate:                     # 默认无上限（见 _image_gate）
            try:
                refs = override.get("ref_urls") or []
                labels: list[str] = []
                if not refs:
                    refs, labels = _auto_inject_refs(sid, _FRAME_REF_LIMIT)
                anchors[canon] = await _ensure_scene_anchor(
                    project_id, episode, location, refs, labels,
                    override.get("aspect_ratio") or proj_aspect,
                    p.get("image_model") or override.get("image_model")
                    or proj_image_model, canonical=canon)
            except Exception:                # noqa: BLE001 锚点失败不阻断首帧
                anchors[canon] = None
        async with lock:
            anchor_done += 1
            pct = int(anchor_done / len(scene_rep) * anchor_pct)
            set_job_phase(ph_jid, {
                "key": "anchors", "label": "正在出场景基准帧",
                "done": anchor_done, "total": len(scene_rep),
                "frames_done": 0, "frames_total": len(plan)})
            _update(jid, progress=pct, result=json.dumps(
                {"stage": "anchors",
                 "note": f"场景基准帧 {anchor_done}/{len(scene_rep)}"},
                ensure_ascii=False))
            if progress_cb:
                progress_cb(pct)

    if scene_rep:
        await asyncio.gather(*(_warmup(k, sid, ov, ep, loc)
                               for k, (sid, ov, ep, loc) in scene_rep.items()))

    # ---- ② 全量并发出首帧（锚点已就绪，不再有锁等待）----
    async def _report() -> None:
        pct = anchor_pct + int(done_count / len(plan) * (100 - anchor_pct))
        set_job_phase(ph_jid, {
            "key": "frames", "label": "正在出首帧",
            "done": done_count, "total": len(plan),
            "frames_done": done_count, "frames_total": len(plan)})
        _update(jid, progress=pct,
                result=json.dumps({"frames": sorted(results, key=lambda r: r["order"])},
                                  ensure_ascii=False))
        if progress_cb:
            progress_cb(pct)

    async def _one(sid: str, order: int, episode: int, location: str | None,
                   script_ref: str, gen_prompt: str | None, override: dict) -> None:
        nonlocal done_count
        # 取消检查点：不硬杀协程，但不再为**这一镜**发起上游请求。
        # gather 已把所有镜头派发出去了，逐个在入口自行退出是唯一能省钱的粒度。
        #
        # 必须同时看 parent_jid：一键成片为每段新建独立子 job，
        # 用户在 UI 上取消的是**父** job，只查 jid 的话取消传不到正在跑的子任务，
        # 170 个镜头会照样烧完。
        if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
            return
        n_refs = 0
        reason = "other"      # moderation | channel | other，前端据此给不同建议
        err: str | None = None
        async with gate:
            try:
                refs = override.get("ref_urls") or []
                labels: list[str] = []
                if not refs:
                    refs, labels = _auto_inject_refs(sid, _FRAME_REF_LIMIT)
                n_refs = len(refs)
                # 锚点从预热字典取（按归一场景），显式传入 → _gen_first_frame 不会再持锁排队
                anchor = anchors.get(_canon_of(location)) if location else None
                # strict=True：要拿到真实失败原因（审核拒绝 vs 渠道故障），
                # 否则只能报"未知原因"，用户无从判断该改提示词还是等渠道恢复
                url = await _gen_first_frame(
                    project_id, episode, location,
                    override.get("prompt") or script_ref, refs, labels,
                    override.get("aspect_ratio") or proj_aspect,
                    p.get("image_model") or override.get("image_model")
                    or proj_image_model,
                    gen_prompt=gen_prompt, anchor=anchor, strict=True)
                if url is None:
                    err = "图像模型未返回图片"
            except ContentRejected as e:      # noqa: BLE001 内容审核拒绝
                url = None
                reason = "moderation"
                cats = "、".join(e.categories) if e.categories else ""
                err = (f"提示词被内容审核判定违规{('（' + cats + '）') if cats else ''}"
                       "——重试无效，请改写该镜提示词或换用其他生图模型")
            except Exception as e:  # noqa: BLE001 单镜异常不拖垮整批
                url = None
                msg = str(e) or repr(e)
                if "渠道" in msg or "HTTP" in msg or "网络异常" in msg:
                    reason = "channel"
                err = msg[:300]
        if url:
            _set_shot_first_frame(sid, url)   # 落库 + SSE，镜头卡逐张点亮
        async with lock:
            if url:
                # refs=0 即"无参考裸生"：场景锚点还在（场景一致），但人物由模型
                # 自由发挥，一致性无保障。记进 result 供事后排查"哪几镜是裸生的"。
                results.append({"order": order, "shot_id": sid,
                                "first_frame_url": url, "refs": n_refs})
            else:
                results.append({"order": order, "shot_id": sid,
                                "reason": reason,
                                "error": err or "首帧生成失败（原因未知）"})
            done_count += 1
            await _report()

    await asyncio.gather(*(_one(*item) for item in plan))

    failed = [r for r in results if "error" in r]
    # 裸生清单（refs=0）：这些镜的人物长相由模型自由发挥，跨镜必然漂移。
    # 写进 result 让"为什么这几镜人不像"事后可查，前端也能据此提示补定妆图。
    bare = [r["order"] for r in results if r.get("refs") == 0]
    # 审核拒绝单列：这批**重试多少次都一样**，前端要引导用户改提示词/换模型，
    # 而不是像渠道故障那样提示"稍后重试"。
    blocked = sorted(r["order"] for r in failed if r.get("reason") == "moderation")
    # 与 run_shot_videos 同口径：取消检查点是裸 return，被取消的镜头不进 results，
    # 不查状态位的话用户取消完会看到一个"已完成"。
    if is_cancelled(jid) or (parent_jid and is_cancelled(parent_jid)):
        skipped = len(plan) - len(results)
        _update(jid, status="cancelled", progress=100,
                error=f"已取消（{skipped} 镜未出首帧）" if skipped else "已取消")
        return
    _update(jid,
            status="failed" if len(failed) == len(plan) else "done",
            progress=100,
            result=json.dumps({"frames": sorted(results, key=lambda r: r["order"]),
                               "bare_shots": sorted(bare),
                               "blocked_shots": blocked}, ensure_ascii=False),
            error=_brief_errors(failed) if failed else None)


async def run_first_frame_pipeline(jid: str) -> None:
    """首帧精控一条龙：资产 → 全部首帧 → 全部片段（「🚀 一条龙」）。

    payload = {
      "project_id": "...",
      "gen_assets": false,      # true = 先把缺图的定妆图/场景图补出来
      "force_frames": false,    # true = 已有首帧也重生
      "stop_after": null,       # "assets" = 只补资产就收工（弹窗「🖼 先补齐资产图」）
                                # "frames" = 补完资产和首帧就收工，不出片
      "model_id": null          # 覆盖视频模型
    }
    进度分配：资产 0-30，首帧 30-70，片段 70-100。
    stop_after 存在的理由：人物一致性靠定妆图注入，没资产就出首帧等于纯文生图
    （场景锚点只保场景不保人）。弹窗发现"角色无定妆图"时要能先只补资产，
    补完再让用户决定是否继续，而不是硬着头皮把一整批不一致的首帧烧出来。
    任一段整体失败即置 failed 并带上失败段落名，不静默往下走
    （半成品继续跑只会烧钱产出废片）。
    """
    from .db import Asset, AssetStage, Project
    from .readiness import compute_readiness

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return
    rd = compute_readiness(project_id)
    if rd.get("error"):
        _update(jid, status="failed", error=f"项目不存在: {project_id}")
        return

    _update(jid, status="running", progress=1)

    # ---- ① 资产（0-30）----
    # 注：不再有"确认定妆图"这一步——_auto_inject_refs 只看有没有图，
    # 生成出来即视为选定（见该函数文档）。
    if p.get("gen_assets"):
        # ①-0 先让 AI 把造型阶段（含剧本明写的服装变体）识别出来，再统计缺口。
        # 否则「🖼 先补齐资产图」只会把**已存在**的阶段补上图，而"剧本里写了
        # 丝绸睡裙/浴袍却从没建过阶段"这类缺口永远看不见——用户在资产页看到的
        # 就是"每个角色只有一张图"。stages_draft 已幂等：已出图的阶段不删不改，
        # 只在没覆盖的集/镜头上做增量（见其文档）。
        try:
            from .routes_v2 import StageDraftIn, stages_draft
            r = await stages_draft(StageDraftIn(project_id=project_id,
                                                model_id=p.get("model_id")))
            log.info("[first_frame_pipeline %s] 造型阶段规划：新增 %s 个"
                     "（服装变体 %s，复用已有定妆图 %s）",
                     jid, r.get("created"), r.get("variants"), r.get("reused_images"))
            rd = compute_readiness(project_id)   # 规划后缺口变了，重新统计
        except Exception as e:  # noqa: BLE001 识别失败不阻断，按现有阶段补图
            log.warning("[first_frame_pipeline %s] 造型阶段识别失败，"
                        "按现有阶段补图: %r", jid, e)
        # Q1：先取人物档案（性别/年龄段/身份），供定妆照提示词使用。
        # 必须在 session 块**之前** await —— 同步 session 里不能跑协程，
        # 且 character_brief 会调 LLM，占着 DB 连接等网络是明确的反模式。
        _briefs = await _collect_briefs(project_id, rd, p.get("model_id"))
        # 形象档案（骨相/五官/气质）：同理必须在 session 块前 await。
        # 用户 2026-09-09 决策：一键成片里自动跑，不需要单独点一次。
        _profiles = await _collect_profiles(project_id, rd, p.get("model_id"))
        # 影调档案（全片一套调色基调）：同理必须在 session 块前 await。
        # 它拼进下面所有 character_prompt / scene_prompt，是"不同图色调不统一"的主要修法。
        _look = await _collect_look(project_id)
        # 画风预设（都市/古风/国漫…）：读一行库，不 await。它同时决定前缀、
        # 否定项与质感词——只换前缀会与残留的「禁止动漫」自相矛盾，
        # 见 style_preset 模块头。
        _style = _style_of(project_id)
        # Q3：场景描述就地补齐。没有它 scene_prompt 只报一个场景名，
        # 出来的参考图是"某个高档餐厅"而不是**这一个**餐厅；
        # 更要紧的是镜头提示词也拿不到陈设依据（见 ensure_scene_descriptions）。
        # 不透传 p["model_id"]：本 job 的 model_id 语义是**视频**模型覆盖值。
        await ensure_scene_descriptions(project_id)
        items: list[dict] = []
        with get_session() as session:
            proj = session.get(Project, project_id)
            title = proj.title if proj else ""
            # 🐛 资产生图此前**不传 model_id**，于是 ImageProvider(model_id=None)
            # 恒取 settings.image_model（全局默认），而镜头图走的是项目自己的
            # image_model。两者是同一型号时看不出问题，用户一改项目模型，
            # 资产图和成片立刻两种质感——这是"色调不统一"的成因之二。
            _asset_image_model = _resolve_project_gen_settings(proj)[1]
            for row in rd["assets"]["stages_no_image"]:
                st = session.get(AssetStage, row["id"])
                if st is None:
                    continue
                items.append({
                    "name": f"角色-{st.character_name}",
                    "stage_id": st.id,
                    "prompt": character_prompt(
                        title, st.character_name,
                        stage_name=st.stage_name,
                        description=st.description,
                        brief=brief_for_image(_briefs, st.character_name),
                        profile=_profiles.get(st.character_name),
                        look=_look, style=_style),
                })
            # 角色完全没有可注入定妆图：先按其出场集补建造型阶段再生图。
            # 只建阶段不建 Asset 行——_auto_inject_refs 认的是 AssetStage，
            # 光有 Asset(kind=character).image_url 一张也注入不进去。
            for row in rd["assets"]["chars_no_asset"]:
                cname, eps = row["name"], row["episodes"]
                runs = _plan_default_stages(session, project_id, cname, eps)
                if not runs:
                    continue
                ca = (session.query(Asset)
                      .filter(Asset.project_id == project_id,
                              Asset.kind == "character", Asset.name == cname).first())
                desc = (ca.prompt if ca and ca.prompt else "") or ""
                for ep_from, ep_to in runs:
                    st = AssetStage(id=uuid.uuid4().hex[:12], project_id=project_id,
                                    character_name=cname, stage_name="默认造型",
                                    ep_from=ep_from, ep_to=ep_to, description=desc)
                    session.add(st)
                    session.commit()
                    items.append({
                        "name": f"角色-{cname}",
                        "stage_id": st.id,
                        "prompt": character_prompt(
                            title, cname, description=desc,
                            brief=brief_for_image(_briefs, cname),
                            profile=_profiles.get(cname),
                            look=_look, style=_style),
                    })
            # 场景多视角参考图（8 张/场景：方位 4 + 景别 4）。
            # 一张图不够的理由见 scene_view 模块头：镜头一换机位，模型手里只有
            # 一个方向的照片，只能现编这个房间的其它面——同一个客厅会不是同一个客厅。
            items += _scene_view_items(session, project_id, title,
                                       rd["assets"]["locations_no_image"], _look)
        if items:
            # 同 run_one_click_film：用户已取消时不再建子 job，
            # 否则会在取消之后再抛一张「生成失败」卡片（2026-09-01 生产报障）。
            if is_cancelled(jid):
                set_job_phase(jid, None)
                return
            set_job_phase(jid, {"key": "assets", "label": "正在补资产图",
                                "done": 0, "total": len(items)})
            sub = create_job("asset_batch", {"project_id": project_id,
                                             "items": items, "size": "1024x1024",
                                             "model_id": _asset_image_model})
            await run_asset_batch(sub, parent_jid=jid)
            sj = get_job(sub)
            if sj is not None and sj.status == "cancelled":
                set_job_phase(jid, None)
                return
            if sj is None or sj.status == "failed":
                _update(jid, status="failed",
                        error=f"资产生成失败: {sj.error if sj else 'job 丢失'}")
                return
    _update(jid, progress=30)
    if p.get("stop_after") == "assets":
        _update(jid, status="done", progress=100,
                result=json.dumps({"stage": "assets", "note": "资产已补齐"},
                                  ensure_ascii=False))
        return

    # ---- ② 全部首帧（30-70）----
    sub_ff = create_job("first_frames", {"project_id": project_id,
                                         "force": bool(p.get("force_frames"))})
    await run_first_frames(
        sub_ff, progress_cb=lambda pct: _update(jid, progress=30 + int(pct * 0.4)),
        phase_jid=jid, parent_jid=jid)
    ff = get_job(sub_ff)
    if ff is None or ff.status == "failed":
        _update(jid, status="failed",
                error=f"首帧生成全部失败: {ff.error if ff else 'job 丢失'}")
        return
    _update(jid, progress=70)
    if p.get("stop_after") == "frames":
        _update(jid, status="done", progress=100,
                result=json.dumps({"stage": "frames", "note": "资产与首帧已就绪"},
                                  ensure_ascii=False))
        return

    # ---- ③ 全部片段（70-100）----
    # shot_ids 留空 → run_shot_videos 默认"只补未生成的"（jobs.py 内 plan 选择），
    # 正好对上"用全部首帧生成全部片段"。
    sub_v = create_job("shot_videos", {"project_id": project_id,
                                       "model_id": p.get("model_id"),
                                       # 同 run_one_click_film：本次覆写要透传
                                       "resolution": p.get("resolution"),
                                       "aspect_ratio": p.get("aspect_ratio")})
    await run_shot_videos(
        sub_v, progress_cb=lambda pct: _update(jid, progress=70 + int(pct * 0.3)),
        phase_jid=jid, parent_jid=jid)
    vj = get_job(sub_v)
    if vj is not None and vj.status == "cancelled":
        set_job_phase(jid, None)
        return
    if vj is None or vj.status == "failed":
        _update(jid, status="failed",
                error=f"镜头生成全部失败: {vj.error if vj else 'job 丢失'}")
        return

    _update(jid, status="done", progress=100, result=json.dumps({
        "frames": json.loads(ff.result or "{}").get("frames", []),
        "shots": json.loads(vj.result or "{}").get("shots", []),
        # ⚠️ 这里**不能** json.loads(vj.error)：子 job 的 error 现在是给用户看的
        # 摘要字符串（见 _brief_errors），解析会抛 JSONDecodeError，
        # 而且是抛在"一条龙全部跑完、正要标记成功"这一步——用户会看到整条
        # 流水线在最后一秒莫名失败。逐镜明细本就在 vj.result 里。
        "video_error": vj.error or None,
    }, ensure_ascii=False))


async def run_asset_candidates(jid: str) -> None:
    """资产候选图生成（资产弹窗「✨ 生成」）：payload=
    {"project_id","kind","name","stage_id"?,"prompt","model_id","size","n",
     "ref_urls"?,"use_char_ref","exclude_url"?}

    为什么是 job 而不是同步接口：候选图要生 1-4 张、几十秒到一分多钟，
    而弹窗点一下外面就关了。原来的同步实现里候选只活在组件 state 里——
    窗一关，图已经落盘、钱已经花了，UI 却再也找不回来（用户实测反馈）。
    走 job 后进度与结果都在库里，关窗再开照样能挑。

    **不落库到资产上**：候选就是候选，只有用户点选那一张才写
    AssetStage.image_url / Asset.image_url（走既有的 PATCH 接口）。
    """
    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload)
    project_id = p.get("project_id")
    prompt = (p.get("prompt") or "").strip()
    if not prompt:
        _update(jid, status="failed", error="缺少提示词")
        return

    # 参考图：显式传的优先；否则按角色自动找已有定妆图（同一张脸）。
    # 与 run_asset_batch / POST /v2/assets/generate 共用 character_base_ref。
    refs = list(p.get("ref_urls") or [])
    if not refs and p.get("use_char_ref", True) and p.get("kind") == "character" and project_id:
        from .asset_ref import character_base_ref
        with get_session() as session:
            base = character_base_ref(
                session, project_id, p.get("name") or "",
                exclude_stage_ids={p["stage_id"]} if p.get("stage_id") else None,
                exclude_url=p.get("exclude_url"))
        if base:
            refs = [base]

    _update(jid, status="running", progress=5)
    provider = ImageProvider(model_id=p.get("model_id"))
    try:
        urls = await provider.generate(prompt, size=p.get("size") or "1024x1024",
                                       n=max(1, min(int(p.get("n") or 1), 4)),
                                       ref_urls=refs or None)
    except Exception as e:  # noqa: BLE001
        # 审核拒绝要能被前端识别（重试无用，得改词/换模型），与同步接口同口径
        from .providers.image import ContentRejected
        reason = "moderation" if isinstance(e, ContentRejected) else "channel"
        _update(jid, status="failed",
                error=json.dumps({"reason": reason, "message": str(e)[:300]},
                                 ensure_ascii=False))
        return

    if not urls:
        _update(jid, status="failed", error=json.dumps(
            {"reason": "empty", "message": "模型未返回图片"}, ensure_ascii=False))
        return

    _update(jid, status="done", progress=100, result=json.dumps({
        "urls": urls,
        "ref_used": refs[0] if refs else None,
        # 目标身份：重开弹窗时据此判断"这批候选是不是这张资产的"
        "target": {"kind": p.get("kind"), "name": p.get("name"),
                   "stage_id": p.get("stage_id")},
        "prompt": prompt,
    }, ensure_ascii=False))


# kind -> 执行协程
RUNNERS = {
    "asset_candidates": run_asset_candidates,
    "asset_batch": run_asset_batch,
    "costume_scan": run_costume_scan,
    "shot_videos": run_shot_videos,
    "one_click_film": run_one_click_film,
    "first_frames": run_first_frames,
    "first_frame_pipeline": run_first_frame_pipeline,
    # ⚠️ 不要再加回 "compose"。服务端拼接已于 2026-08-30 整体下线：
    # 它只做单轨顺序拼接（无转场/无叠加层/字幕写死 FontSize=18），
    # 产物与桌面端本机渲染差距太大却同样叫"成片"。合成统一走桌面端 ffmpeg。
    "breakdown_all": run_breakdown_all,
    "tts_batch": run_tts_batch,
    "reprompt": run_reprompt,
}

#: 一条字幕最多放几个字。竖屏 1080 宽、默认字号 48（TextPanel 的 BASE_STYLE）
#: 一行约装 20 个汉字；再长 libass 会折行或顶出安全区。
_CUE_MAX_CHARS = 20
#: 一条字幕最短显示多久。低于这个数眼睛来不及扫到。
_CUE_MIN_SEC = 0.5
#: 断句点。**空格也算**：Whisper 中文分段的 text 常用空格分隔小句
#: （实测 "林小姐 我知道你不想嫁 但我有两个条件"），不认它就切不开。
_CUE_BREAKS = "，。！？；：、,.!?;: …—\n\t "
#: 出字幕前要洗掉的符号。**烧进画面的字幕不带标点**是短剧字幕的通行做法：
#: 一行只有十几个字、停顿由分条本身表达，标点只是占位置的噪点。
#: 想要标点的用户可以在文本面板里自己加（手动添加的字幕一个字都不动）。
#:
#: 只洗"断句/引述"这一类。**刻意保留** `·`（人名里的间隔号，「阿·晨」）、
#: `%`、`+`、`-`、`&`、`#`、`/`、字母与数字 —— 那些是内容，不是标点。
_CUE_DROP_PUNCT = (
    "，。！？；：、…‥—～﹏"                        # 中文断句
    "\"'“”‘’「」『』《》〈〉【】〔〕（）()[]{}"      # 引号与括号
    ",.!?;:"                                       # 半角断句
)


def _wash_punct(s: str) -> str:
    """洗掉标点，只留能读的内容。

    标点位置换成一个空格而不是直接删：句中的停顿（「朋友啊，快坐」）删掉逗号后
    要是粘成「朋友啊快坐」就读不出那个停顿了，留个空格正好是字幕里表达停顿的写法。
    首尾的空格随后被 strip 掉，所以「你就不再是我爹了。」出来就是干净一句。
    """
    out = "".join(" " if ch in _CUE_DROP_PUNCT else ch for ch in s)
    return " ".join(out.split())


def _split_cue(text: str, start: float, span: float) -> list[tuple[str, float, float]]:
    """把 ASR 的一条分段切成若干条**能读完**的字幕。

    返回 [(文本, 起点秒, 时长秒)]，起点相对于传入的 start。

    为什么必须有这一步：ASR 的分段边界是**声学**的（一口气说到哪算一段），
    不是阅读单位。实测 whisper 会把 26 秒 55 个字回成一条
    （「小雨你认识阿晨多久了也不算久那孩子是不是很闷…」），烧进画面就是
    满屏文字糊一片；反过来若那条的 end 缺失，又会变成 0.3 秒一闪而过。
    两种都不是"时间算错了"，是"一条字幕装了不该装的量"。

    切法：按标点/空格切成小句 → 贪心装箱到 ≤ _CUE_MAX_CHARS →
    **洗掉标点** → 时长**按字数比例**分摊。比例分摊只在一条分段内部做，
    跨分段不动，所以整体时间轴仍然锚在 ASR 测出来的声学位置上，不会累积漂移。

    ⚠️ 洗标点必须排在**装箱之后**：标点正是切分的依据（whisper 的标点是
    这里唯一可靠的断句信号，见 asr.py 的实测表），先洗就没得切了；
    也必须排在**分摊时长之前**，否则按洗前的字数分摊、按洗后的字数显示，
    两边不是同一个权重，时长和会对不上原分段跨度。
    """
    text = text.strip()
    if not text:
        return []
    span = max(span, _CUE_MIN_SEC)
    # 短句直接洗完出。注意长度判断用**洗后**的字数：「你就不再是我爹了。」
    # 这种一逗一句的短句洗完更短，没有理由因为标点占了名额而被切开。
    washed = _wash_punct(text)
    if not washed:
        return []                      # 整段只有标点（ASR 偶尔回 "。"）
    if len(washed) <= _CUE_MAX_CHARS:
        return [(washed, start, span)]

    # ① 切小句：断句符跟在前一句尾部（读起来才完整），空格丢掉
    pieces: list[str] = []
    buf = ""
    for ch in text:
        if ch in _CUE_BREAKS:
            if ch.strip():
                buf += ch
            if buf.strip():
                pieces.append(buf.strip())
            buf = ""
        else:
            buf += ch
    if buf.strip():
        pieces.append(buf.strip())

    # ② 没有任何标点的长句（AI 语音常见）只能硬切，否则整条塞不进画面
    flat: list[str] = []
    for pc in pieces:
        while len(pc) > _CUE_MAX_CHARS:
            flat.append(pc[:_CUE_MAX_CHARS])
            pc = pc[_CUE_MAX_CHARS:]
        if pc:
            flat.append(pc)

    # ③ 贪心装箱：能并进一条就并，避免切得过碎（碎字幕比长字幕更难读）。
    #    并的时候若上一句尾部**没有标点**，补一个空格 —— 小句边界原本是空格
    #    （whisper 中文常用空格分句），直接粘起来会变成
    #    「林小姐我知道你不想嫁但我有两个条件」，读起来比切碎更糟。
    chunks: list[str] = []
    for pc in flat:
        if chunks:
            glue = "" if chunks[-1][-1] in _CUE_BREAKS else " "
            if len(chunks[-1]) + len(glue) + len(pc) <= _CUE_MAX_CHARS:
                chunks[-1] += glue + pc
                continue
        chunks.append(pc)
    if not chunks:
        return [(washed, start, span)]

    # ④ 洗标点。装箱已经完成，标点的活儿（提供切分点、保证并句可读）干完了，
    #    留在画面上只是噪点。洗完可能有整条化为空（如小句就是一个 "。"），
    #    直接丢掉；剩下的时长照新字数重新分摊，所以丢掉的那条不会留下空洞。
    chunks = [w for w in (_wash_punct(c) for c in chunks) if w]
    if not chunks:
        return []

    # ⑤ 时长按字数比例分摊
    total = sum(len(c) for c in chunks)
    out: list[tuple[str, float, float]] = []
    t = start
    for c in chunks:
        d = span * len(c) / total
        out.append((c, t, d))
        t += d
    return out


def _pick_asr_source(
    mode: str,
    narration: list[tuple],
    videos: list[tuple],
) -> tuple[list[tuple], bool, str]:
    """选转写音源，返回 (targets, from_video, 人话标签)。

    抽成纯函数是因为**这段判断错过一次，代价是整个模式没有字幕功能**
    （见 run_auto_subtitles 的文档）。它没有 IO，可以直接表驱动验证，
    不必起后端、不必花 ASR 的钱。
    """
    if mode == "drama" or not narration:
        return videos, True, "镜头原声"
    return narration, False, "旁白"


async def _extract_asr_audio(video):
    """把镜头视频的声音剥成 ASR 用的临时文件。

    返回临时文件路径；**该镜头没有音轨时返回 None**（不是故障，是这一镜本来
    就没人说话）；提取失败抛异常（那才是故障，要计入失败数）。

    为什么不把 mp4 原样交给 Whisper（ASRProvider 的 mime 表本来就认 video/mp4）：
      · 一个 720p 镜头几 MB，几百镜就是几 GB 的上传，慢且贵；16kHz 单声道
        mp3 只有几十 KB，对 Whisper 的识别质量没有差别。
      · 25MB 是 provider 会直接抛的硬墙，长镜头撞得到。
      · 先 ffprobe 一次就能筛掉**无音轨**的镜头（AI 生成的视频很常见），
        那些镜头连一次 API 调用都不该花。
    """
    import os
    import tempfile
    from pathlib import Path

    from .media import _has_audio, _run

    if not await _has_audio(video):
        return None
    fd, tmp = tempfile.mkstemp(suffix=".mp3", prefix="fw_asr_")
    os.close(fd)
    out = Path(tmp)
    code, msg = await _run([
        "ffmpeg", "-y", "-i", str(video),
        "-vn", "-ac", "1", "-ar", "16000", "-b:a", "32k", str(out),
    ], timeout=180.0)
    if code != 0 or not out.exists() or out.stat().st_size == 0:
        out.unlink(missing_ok=True)
        raise RuntimeError(f"提取音轨失败：{(msg or '')[-160:]}")
    return out


async def run_auto_subtitles(jid: str) -> None:
    """TB-08 自动字幕：把**实际发声的那条音轨**转写成字幕段落。

    payload = {"project_id": "...", "replace": false}

    为什么走 job：Whisper 单段几秒到几十秒，一个项目几十条旁白就是分钟级，
    同步接口必撞 nginx 504。

    ## 音源按生产模式选（6.0 修「真人剧几乎没有字幕 / 字幕与音频不匹配」）

    | 模式 | 声音在哪 | 转写对象 |
    |---|---|---|
    | 解说剧 narration | TTS 旁白（audio_clips） | 旁白音频 |
    | **真人剧 drama** | **镜头视频自带的音轨**（seedance 音画一体） | **镜头视频** |

    原实现只转写 audio_clips，且注释把理由写成"AI 生成的镜头视频大多无人声
    （有的连音轨都没有），逐个下载转写既慢又白花钱"。**那个判断只对解说剧成立**
    ——解说剧的镜头视频是无声 b-roll，声音全在 TTS 旁白里。真人剧恰好相反：
    音画由视频模型一体生成，**台词只存在于镜头视频的音轨里，且 audio_clips
    恒为空**。于是真人剧项目走到这里永远是
    「没有可识别的旁白音频。请先在「音频」面板合成 AI 配音。」——
    一句对真人剧根本无法执行的建议（真人剧没有那一步）。

    结果是**真人剧在产品里压根没有字幕生成路径**。用户看到的字幕问题因此都是
    "字幕不是从声音来的"派生出来的：
      · 台词与音频不同步 —— 时间码是按字数估的，不是从声音测的；
      · 明显不是台词的文本成了字幕（如「林语眼神透着轻蔑」）——
        那是剧本里的舞台指示，**从来没有被念出来**；
      · 小说体那几集几乎没有字幕 —— 那种写法里一条 `角色：` 都没有，
        按剧本解析必然什么也解析不出来。

    转写镜头原声一次解决三者：字幕**就是**音频的转写，时间码来自声音本身，
    没被念出来的东西不可能出现在里面，剧本用什么格式写都无所谓。

    时间换算：ASR 给的是"音频内相对秒"，字幕要的是"锚定镜头 + 镜内偏移"。
    旁白自身就锚在某个镜头上，所以直接把 ASR 的相对秒加到旁白的镜内偏移上即可；
    镜头原声的锚点就是该镜头自己，偏移直接用 ASR 的相对秒（**相对**锚定，
    所以按集导出不会整体漂掉前面所有集的时长）。
    """
    from datetime import datetime, timezone

    from .config import get_settings
    from .db import AudioClip, Project, SubtitleClip
    from .media import _probe_duration, _resolve_local
    from .providers.asr import SIMPLIFIED_ZH_PROMPT, ASRProvider

    job = get_job(jid)
    if not job:
        return
    p = json.loads(job.payload or "{}")
    project_id = p.get("project_id")
    if not project_id:
        _update(jid, status="failed", error="缺少 project_id")
        return

    asr = ASRProvider()
    if not asr.available:
        _update(jid, status="failed",
                error="未配置语音识别通道，无法自动生成字幕")
        return

    _update(jid, status="running", progress=1)

    # ---- 选音源 ----
    with get_session() as session:
        proj = session.get(Project, project_id)
        mode = (proj.production_mode or "") if proj else ""
        clips = (session.query(AudioClip)
                 .filter(AudioClip.project_id == project_id,
                         # ⚠️ 原来只认 kind=="tts"。但解说剧的旁白落库用的是
                         # kind="narration"（routes_v2.generate_narration 写入），
                         # 而 kind=="tts" 只有用户在音频面板手工建的那种。
                         # 于是解说剧项目里 targets 恒为空，自动字幕**从未成功过**
                         # ——报的还是"没有可识别的旁白音频，请先合成 AI 配音"，
                         # 用户明明已经合成了，只能反复重试。
                         # 与 run_tts_batch(见 ~2508 行)保持同一套 kind 判定。
                         AudioClip.kind.in_(("tts", "narration")),
                         AudioClip.url.isnot(None),
                         AudioClip.status == "done")
                 .order_by(AudioClip.start_shot_order,
                           AudioClip.start_offset_sec).all())
        narration = [(c.url, c.start_shot_order, float(c.start_offset_sec or 0.0))
                     for c in clips]
        shots = (session.query(Shot)
                 .filter(Shot.project_id == project_id,
                         Shot.video_url.isnot(None))
                 .order_by(Shot.order).all())
        # 停用的镜头不进成片，也就不该有字幕
        videos = [(s.video_url, s.order, 0.0) for s in shots if not s.disabled]

    # 真人剧一律转写镜头原声：台词只在那里。其余模式优先用旁白，
    # 没有旁白时也退到镜头原声——比报一句"请先合成配音"有用。
    targets, from_video, src_label = _pick_asr_source(mode, narration, videos)

    if not targets:
        set_job_phase(jid, None)
        _update(jid, status="failed",
                error=("没有可识别的镜头视频。请先生成镜头视频后再自动生成字幕。"
                       if from_video else
                       "没有可识别的旁白音频。请先在「音频」面板合成 AI 配音。"))
        return

    if p.get("replace"):
        # 重跑时先清掉上一轮自动生成的（手工加的字幕不动——它们 kind=normal/title）
        with get_session() as session:
            for old in (session.query(SubtitleClip)
                        .filter(SubtitleClip.project_id == project_id,
                                SubtitleClip.kind == "subtitle").all()):
                session.delete(old)
            session.commit()

    total = len(targets)
    phase_label = f"正在识别{src_label}"
    set_job_phase(jid, {"key": "asr", "label": phase_label, "done": 0, "total": total})

    # 并发：用**已有**的 settings.default_concurrency（与 ~2900 / ~3252 行同一
    # 口径），不新增开关也不下调任何并发数。原实现是**完全串行**的，真人剧一集
    # 30 镜就要串几分钟；镜头数上百时串行根本跑不完。
    # ⚠️ 若这里成为瓶颈（429/限流），正确解法是加 API KEY / 提配额，不是降并发。
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    rows: list[tuple[str, int, float, float]] = []   # (text, order, offset, dur)
    lock = asyncio.Lock()
    done = failed = silent = 0

    async def one(url: str | None, order: int, offset: float) -> None:
        nonlocal done, failed, silent
        try:
            async with sem:
                path = _resolve_local(url or "")
                if path is None or not path.exists():
                    failed += 1
                    return
                tmp = None
                try:
                    if from_video:
                        tmp = await _extract_asr_audio(path)
                        if tmp is None:
                            # 无音轨 ≠ 失败：这一镜本来就没人说话（空镜/环境镜）。
                            # 计进 failed 会让"全片只有几个镜有台词"误报成故障。
                            silent += 1
                            return
                    segs = await asr.transcribe(
                        tmp or path, prompt=SIMPLIFIED_ZH_PROMPT)
                finally:
                    if tmp is not None:
                        tmp.unlink(missing_ok=True)

                # 时长兜底：某些返回体既无 segments 也无 duration，end 会是 0。
                # 直接 max(0.3, 0-0) 就是"50 个字闪 0.3 秒"——比没有字幕更糟。
                # 这种情况用素材自身的时长兜住（只在真需要时才 ffprobe）。
                media_sec: float | None = None
                async with lock:
                    for sg in segs:
                        text = (sg.get("text") or "").strip()
                        if not text:
                            continue
                        s0 = float(sg.get("start") or 0.0)
                        span = float(sg.get("end") or 0.0) - s0
                        if span <= 0:
                            if media_sec is None:
                                media_sec = await _probe_duration(path)
                            span = max(0.0, (media_sec or 0.0) - s0)
                        for txt, st, dur in _split_cue(text, offset + s0, span):
                            rows.append((txt, order, st, dur))
        except Exception as e:                      # noqa: BLE001
            log.warning("ASR 失败 %s: %s", url, e)
            failed += 1
        finally:
            done += 1
            set_job_phase(jid, {"key": "asr", "label": phase_label,
                                "done": done, "total": total})
            _update(jid, progress=max(1, min(98, int((done / total) * 100))))

    await asyncio.gather(*(one(u, o, off) for u, o, off in targets))

    made = 0
    if rows:
        # 一次事务写完：并发任务各自开 session 写 SQLite 会撞 database is locked。
        with get_session() as session:
            for text, order, offset, dur in sorted(rows, key=lambda r: (r[1], r[2])):
                session.add(SubtitleClip(
                    id=uuid.uuid4().hex[:12], project_id=project_id,
                    text=text, kind="subtitle",
                    start_shot_order=order, start_offset_sec=offset,
                    duration=dur, style=None,
                    created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
                ))
                made += 1
            session.commit()

    set_job_phase(jid, None)

    # 全军覆没要报失败，不能报 done。
    # 原来无论如何都 status="done"：ASR 服务挂了、密钥过期、所有音频都识别失败，
    # 用户看到的仍是一个绿色的"已完成"，字幕轨空空如也 ——
    # 既不知道失败了，也不知道该重试。
    if total and made == 0:
        # 三种"没产出"要分开说，因为处置办法完全不同：
        #   · 全都没音轨 → 这些镜头本来就没有声音，该去看视频模型是否出了音；
        #   · 有失败 → 服务/密钥/网络，重试或查配置；
        #   · 都成功却一个字都没识别出 → 音轨里确实没有人声。
        if silent == total:
            err = (f"自动字幕失败：{total} 个镜头的视频都没有音轨，无法识别台词。"
                   "真人剧的台词来自视频模型生成的原声，请确认生成时开启了音频。")
        elif failed:
            err = (f"自动字幕失败：{failed}/{total} 段{src_label}识别失败，未生成任何字幕。"
                   "请检查 ASR 服务配置后重试")
        else:
            err = f"自动字幕失败：{total} 段{src_label}里没有识别到任何语音"
        _update(jid, status="failed", progress=100, error=err,
                result=json.dumps({"created": 0, "failed": failed, "total": total,
                                   "silent": silent, "source": src_label},
                                  ensure_ascii=False))
        return

    # 部分失败也要让用户知道（成功但不完整），前端据此提示。
    # 无音轨的镜头单独说：它不是故障，但"少了几镜的字幕"用户是要知道的。
    warn = []
    if failed:
        warn.append(f"{failed}/{total} 段{src_label}识别失败")
    if silent:
        warn.append(f"{silent} 个镜头无音轨（无台词）")
    _update(jid, status="done", progress=100,
            error=("；".join(warn) + "，其余已生成" if warn else None),
            result=json.dumps({"created": made, "failed": failed, "total": total,
                               "silent": silent, "source": src_label},
                              ensure_ascii=False))


RUNNERS["auto_subtitles"] = run_auto_subtitles
