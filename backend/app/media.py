"""媒体模块：素材上传、静态访问、时间轴拼接（ffmpeg concat）、客户端版本检查。

MVP 取舍：素材与成片都落服务器本地磁盘（/root/filmweaver-data），
静态访问走 FastAPI StaticFiles（经 nginx /fw 反代对外）；
拼接用 ffmpeg concat + 统一转码（不同来源分辨率/编码不一致时 concat demuxer 会花屏，
故先逐段归一化再拼，稳字当头）。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from pathlib import Path

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .config import get_settings

#: 数据根目录。**必须可配置**：prod 与 dev 跑在同一台机器上，
#: 若共用一个目录，两边的上传/生成/导出会互相覆盖，prod 用户能看到 dev 的素材。
#: 由 FW_DATA_DIR 指定（dev 默认 filmweaver-data，prod 为 filmweaver-prod-data）。
#:
#: ⚠️ **其它模块一律从这里 import，不许自己拼 Path 字面量**——
#: 见 2026-09-01：providers/image.py 与 providers/video.py 各写了一份
#: 硬编码的 filmweaver-data/generated，于是生产环境生成的图全部落进 dev 目录。
DATA_DIR = Path(get_settings().data_dir)
UPLOAD_DIR = DATA_DIR / "uploads"
OUTPUT_DIR = DATA_DIR / "outputs"
GENERATED_DIR = DATA_DIR / "generated"   # AI 生成的图片/镜头视频落盘处
# 导出中间产物。**必须在 OUTPUT_DIR 之外**：
# cache_clear 是 OUTPUT_DIR.rglob("*") 无差别删除，work 目录放在里面的话，
# 用户在导出进行中点一下「清理缓存」，正在写的 norm_00x.mp4 / list.txt
# 会被删掉，导出直接失败报「拼接失败」。
WORK_DIR = DATA_DIR / "work"
for d in (UPLOAD_DIR, OUTPUT_DIR, GENERATED_DIR, WORK_DIR):
    d.mkdir(parents=True, exist_ok=True)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/v2", tags=["media"])

# ---- 客户端版本（检查更新用；发新版时改这里） ----
#
# ⚠️ 这份数据长期与实际发布脱节（曾停在 0.7.0，而已发到 0.7.5；
# download_url 的主机还是另一台机器 120.26.143.129）。
# 真正的更新源是 Tauri updater 读的 appcast/latest.json，由 publish-update.py
# 在发布时写入 —— 这个接口只是个旁路，目前前端没有消费方（api.ts 定义了
# appLatest 但无人调用）。这里改为直接读 appcast，避免再出现两处版本打架。
_APPCAST = DATA_DIR / "appcast" / "latest.json"


@router.get("/app/latest")
def app_latest() -> dict:
    """返回当前发布版本。以 appcast/latest.json 为准，不再手工维护常量。"""
    try:
        d = json.loads(_APPCAST.read_text(encoding="utf-8"))
        plat = (d.get("platforms") or {}).get("windows-x86_64") or {}
        return {
            "version": d.get("version", ""),
            "notes": d.get("notes", ""),
            "download_url": plat.get("url", ""),
        }
    except Exception:  # noqa: BLE001 读不到就说"未知"，不要编一个假版本号出来
        return {"version": "", "notes": "暂无发布信息", "download_url": ""}


# ---- 素材上传 ----
ALLOWED_EXT = {".mp4", ".mov", ".mkv", ".webm", ".mp3", ".wav", ".aac", ".m4a",
               ".png", ".jpg", ".jpeg", ".webp", ".txt", ".md", ".srt",
               # .cube = 3D LUT。滤镜面板的 LUT 导入 accept=".cube"，
               # 白名单漏了它，导致上传必然 400、lut3d 那条渲染路径从未被走到过。
               ".cube"}

# 单文件上限。定 2GB 的依据：素材以短剧片段为主，2GB 已覆盖 4K 长片段；
# 更大的文件在这条链路（整段读进来再落盘）上本来也不合适。
# 没有上限的话，一次上传就能把数据盘填满 —— 现有数据盘 94G 可用。
MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024
_UPLOAD_CHUNK = 1024 * 1024        # 1MB/块


@router.post("/media/upload")
async def media_upload(file: UploadFile = File(...),
                       project_id: str | None = Form(None),
                       duration: float = Form(0.0)) -> dict:
    """上传素材。P1-3：带 project_id 时元数据落库（media_clips），刷新/换设备不丢。

    duration 由前端 probeDuration 探测后随表单带上（服务端 ffprobe 会拖慢上传，
    且时长仅做展示/插轨默认值，客户端探测精度足够）。

    ⚠️ 必须分块 await 写入，不能用 shutil.copyfileobj：
    那是**同步阻塞**调用，放在 async def 里会独占事件循环 ——
    传一个 500MB 的片段期间，SSE 停推、任务进度不动、所有其他请求全部挂起。
    """
    ext = Path(file.filename or "f.bin").suffix.lower()
    if ext not in ALLOWED_EXT:
        raise HTTPException(400, f"不支持的文件类型 {ext}")
    fid = uuid.uuid4().hex[:12]
    dest = UPLOAD_DIR / f"{fid}{ext}"

    written = 0
    try:
        with dest.open("wb") as w:
            while True:
                chunk = await file.read(_UPLOAD_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > MAX_UPLOAD_BYTES:
                    raise HTTPException(
                        413,
                        f"文件超过上限 {MAX_UPLOAD_BYTES // (1024 * 1024)}MB，"
                        "请先压缩或分段后再上传")
                w.write(chunk)
    except Exception:
        # 半截文件必须删掉：留在盘上既占空间，又会被当成一个"可用素材"
        dest.unlink(missing_ok=True)
        raise
    if written == 0:
        dest.unlink(missing_ok=True)
        raise HTTPException(400, "上传内容为空")

    url = f"/fw/media/uploads/{dest.name}"
    kind = ("video" if ext in {".mp4", ".mov", ".mkv", ".webm"}
            else "audio" if ext in {".mp3", ".wav", ".aac", ".m4a"}
            else "image" if ext in _IMAGE_EXT else "other")
    if project_id:
        from datetime import datetime, timezone
        from .db import MediaClip, get_session
        with get_session() as session:
            session.add(MediaClip(
                id=fid, project_id=project_id, name=file.filename or dest.name,
                url=url, size=dest.stat().st_size, kind=kind,
                duration=max(0.0, float(duration or 0.0)),
                created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
            ))
            session.commit()
    return {
        "file_id": fid,
        "name": file.filename,
        "url": url,
        "size": dest.stat().st_size,
        "kind": kind,
    }


@router.get("/projects/{project_id}/clips")
def list_clips(project_id: str) -> dict:
    """P1-3 项目素材池：上传素材元数据（左栏「素材」分组消费）。"""
    from .db import MediaClip, get_session
    with get_session() as session:
        rows = (session.query(MediaClip)
                .filter(MediaClip.project_id == project_id)
                .order_by(MediaClip.created_at).all())
        return {"clips": [
            {"id": c.id, "name": c.name, "url": c.url, "size": c.size,
             "kind": c.kind, "duration": c.duration}
            for c in rows
        ]}


class ClipPatchIn(BaseModel):
    #: 展示名。空白字符串会被拒绝（改成空名字等于让素材在面板里消失）
    name: str


@router.patch("/clips/{clip_id}")
def patch_clip(clip_id: str, body: ClipPatchIn) -> dict:
    """重命名素材池里的素材（R2）。

    用户上传的素材此前只能用原始文件名（`IMG_20260828_143022.mp4` 这种），
    在素材面板里根本认不出哪个是哪个。

    与角色/场景资产改名（R1）不同，这里**没有连接键风险**：
    `MediaClip.name` 纯粹用于展示，镜头与素材的关联走 `url`
    （已核对：全库无 `MediaClip.name ==` 的查询）。所以改名不会让任何
    已插入镜头的素材失联，也不需要同步迁移别的表。
    """
    from .db import MediaClip, get_session
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(422, "素材名不能为空")
    with get_session() as session:
        c = session.get(MediaClip, clip_id)
        if not c:
            raise HTTPException(404, "clip not found")
        c.name = name[:255]
        session.commit()
        return {"ok": True, "id": c.id, "name": c.name}


def _find_references(session, url: str, *,
                     exclude: tuple[str, str] | None = None) -> list[dict]:
    """列出仍在引用该素材 URL 的对象（B23）。

    素材文件被别处引用时删掉文件，那些引用就变成**指向不存在文件的死链**：
    镜头轨上的外部素材放不出画面、导出时 ffmpeg 直接报"找不到输入"、
    TTS 的参考音色消失导致整批旁白合成失败。而这些都要等到用户点导出/生成
    才炸，且报错里只有一个文件路径，根本联系不到"我上周删过一个素材"。

    这里把引用**先查出来告诉用户**，而不是删完等他自己踩。

    ⚠️ 列清单在 `media_refs.URL_COLUMNS`，**不要在这里硬写列名**。
    本函数 2026-09-11 前自己维护了一份 6 列的清单，漏掉 `AssetStage.image_url`
    / `SceneView.image_url` / `Shot.tail_frame_url` 与 LUT —— 用户刚上线的
    "自己上传资产图"正好写进 `AssetStage.image_url`，在素材库删那段素材时
    **不会被 409 拦住**，资产图静默变死链。三处清单合并到一处后本条自动修掉。
    """
    from .media_refs import find_references
    return find_references(session, url, exclude=exclude)


@router.delete("/clips/{clip_id}")
def delete_clip(clip_id: str, force: bool = False) -> dict:
    """从素材池移除（删登记 + 文件本体）。

    ⚠️ 有对象仍在引用这个文件时**默认拒绝**（409），把引用清单回给前端让用户
    自己决定（B23）。原来是无条件 unlink：镜头轨上正用着这段素材、或它是某批
    旁白的参考音色，删完全无提示，等到导出/合成时才报一个只有文件路径的错。
    确需删除时前端带 `force=true` 再来一次（此时登记与文件都删，引用变死链，
    但那是用户在看到清单后做出的选择）。
    """
    from .db import MediaClip, get_session
    with get_session() as session:
        c = session.get(MediaClip, clip_id)
        if not c:
            raise HTTPException(404, "clip not found")
        url = c.url
        name = c.name
        refs = _find_references(session, url, exclude=("media_clips", clip_id))
        if refs and not force:
            raise HTTPException(409, {
                "message": f"素材「{name}」仍被 {len(refs)} 处引用，删除会造成死链",
                "references": refs[:20],
                "total": len(refs),
            })
        session.delete(c)
        session.commit()
    f = _resolve_local(url)
    if f and f.is_file():
        f.unlink(missing_ok=True)
    return {"ok": True, "forced": bool(refs) and force,
            "broken_references": len(refs) if force else 0}


def _resolve_local(url: str) -> Path | None:
    """把 /fw/media/uploads/x.mp4 之类映射回本地路径；http 外链返回 None（下载处理）。

    ⚠️ 必须做包含检查。这里的 url 是**用户可控**的：
    Shot.video_url 由 /v2/shots/special 原样写入，transform_meta.lut 也是
    前端传什么存什么。形如 `/fw/media/uploads/../../../etc/passwd` 的值
    解析出来会落在 UPLOAD_DIR 之外，而结果会直接交给 ffmpeg 当输入
    （或拼进 lut3d=file='...'）。
    """
    for marker, base in (("/media/uploads/", UPLOAD_DIR),
                         ("/media/outputs/", OUTPUT_DIR),
                         ("/media/generated/", GENERATED_DIR)):
        if marker in url:
            rel = url.split(marker, 1)[1]
            # 去掉 query/fragment，否则 ?t=123 会被当成文件名的一部分
            rel = rel.split("?", 1)[0].split("#", 1)[0]
            try:
                p = (base / rel).resolve()
                if not p.is_relative_to(base.resolve()):
                    logger.warning("[media] 越界路径被拒: %r", url[:200])
                    return None
                return p
            except (OSError, ValueError):
                return None
    return None


_IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp"}


async def _run(cmd: list[str], timeout: float = 1800.0) -> tuple[int, str]:
    """跑 ffmpeg/ffprobe，**必须**带超时。

    没有超时的后果是连锁的：一个损坏/截断的源文件能让 ffmpeg 永远挂住，
    那个 job 就永远停在 running；而 find_active_job 把 running 当"正在跑"，
    该项目之后**再也提交不了**同类任务，只能重启后端才能恢复。

    默认 30 分钟：长片拼接确实可能跑很久，设太短会误杀正常任务。
    探测类调用（ffprobe）应显式传更小的值。
    """
    proc = await asyncio.create_subprocess_exec(
        *cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT)
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        # 必须真的把子进程杀掉并回收，否则它会继续占着 CPU/磁盘直到进程退出
        try:
            proc.kill()
            await proc.wait()
        except Exception:  # noqa: BLE001
            pass
        return 124, f"ffmpeg 执行超时（>{timeout:.0f}s），已终止：{' '.join(cmd[:3])}…"
    return proc.returncode or 0, out.decode(errors="replace")[-2000:]


async def probe_duration_local(url: str) -> float:
    """P2-4：ffprobe 探测本地媒体时长（秒）；失败返回 0（前端有兜底展示）。"""
    p = _resolve_local(url)
    if p is None or not p.is_file():
        return 0.0
    code, out = await _run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1", str(p)], timeout=60.0)
    if code != 0:
        return 0.0
    try:
        return max(0.0, float(out.strip().splitlines()[-1]))
    except (ValueError, IndexError):
        return 0.0


# ---- 缩略图抽帧（P1-1 性能前置） ----
# 轨道/列表原先每镜挂一个 <video preload="metadata">，几百镜同屏时浏览器要为每个元素
# 建解码器 + 发 range 请求，是当前最大的性能隐患。改为生成时抽首帧存 jpg，前端只挂 <img>。
THUMB_WIDTH = 160  # 轨道槽位最宽 ~15s*40px=600px，160 宽在 2x 屏下仍清晰，单张约 5-10KB


async def make_thumb(video_url: str, *, at_sec: float = 0.5) -> str | None:
    """从视频抽一帧存为 jpg，返回 /fw/media/generated/thumb_*.jpg；失败返回 None。

    设计取舍：
      - 只处理已落盘的本地视频（provider 已统一落盘到 generated/）；外链不为抽帧而下载，
        避免把生成链路耗时和失败率绑到缩略图这个非关键功能上。
      - 抽 0.5s 而非第 0 帧：不少 AI 生成视频首帧是纯黑淡入，抽出来一片黑没有辨识度；
        视频短于 0.5s 时 ffmpeg 取不到帧，回退到第 0 帧再试一次。
      - 任何失败都返回 None 而非抛错——缩略图缺失只是前端退回占位图标，绝不能让它
        导致一条已经出片的镜头被判为生成失败。
    """
    src = _resolve_local(video_url)
    if src is None or not src.exists():
        return None
    name = f"thumb_{uuid.uuid4().hex[:12]}.jpg"
    dest = GENERATED_DIR / name
    for seek in ([at_sec, 0.0] if at_sec > 0 else [0.0]):
        # -ss 放在 -i 前 = 关键帧快速定位（几毫秒），缩略图不需要精确帧
        code, _ = await _run([
            "ffmpeg", "-y", "-ss", f"{seek:.2f}", "-i", str(src),
            "-frames:v", "1", "-vf", f"scale={THUMB_WIDTH}:-2",
            "-q:v", "4", str(dest),
        ])
        if code == 0 and dest.exists() and dest.stat().st_size > 0:
            return f"/fw/media/generated/{name}"
    dest.unlink(missing_ok=True)
    return None


async def _has_audio(path: Path) -> bool:
    """探测文件是否含音轨。AI 生成的视频常无音轨，直接 -map 0:a 会报错。"""
    code, out = await _run([
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=index", "-of", "csv=p=0", str(path),
    ])
    return code == 0 and out.strip() != ""


async def _probe_duration(path: Path) -> float:
    """读时长（秒）；失败返回 0。"""
    code, out = await _run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "csv=p=0", str(path),
    ], timeout=60.0)
    try:
        return round(float(out.strip()), 3) if code == 0 else 0.0
    except ValueError:
        return 0.0


async def extract_audio(video_url: str, *, in_sec: float | None = None,
                        dur_sec: float | None = None) -> tuple[str, float] | None:
    """把视频里的音轨剥成独立 m4a，返回 (url, 时长秒)；无音轨/失败返回 None。

    用途：让 AI 生成视频自带的声音以独立音频段的形式出现在音频轨上，
    可以单独挪位置、裁剪、删除（见 db.py AudioClip.source_shot_id）。

    取舍：
      - 只处理已落盘的本地视频（provider 已统一落盘 generated/），
        与 make_thumb 同理，不为这个功能去下载外链。
      - 编码用 aac 而非 -c:a copy：源音轨编码五花八门（部分 provider 出
        opus/vorbis），copy 出来的 m4a 有些播放器打不开；重编码一次
        几百毫秒，换来的是产物格式统一、时间轴预览与导出都能直接吃。
      - **必须**尊重镜头的取片窗口 in/dur（TB-01 镜头分割后，两段共用同一个
        video_url 各取一段）。不裁的话第二段会拿到整条视频的音频，
        长度和内容都对不上。
    """
    src = _resolve_local(video_url)
    if src is None or not src.exists():
        return None
    if not await _has_audio(src):
        return None
    name = f"shotaudio_{uuid.uuid4().hex[:12]}.m4a"
    dest = GENERATED_DIR / name
    cmd = ["ffmpeg", "-y"]
    # -ss/-t 放 -i 之前：输入侧 seek，长片快一个数量级
    if in_sec is not None and float(in_sec) > 0:
        cmd += ["-ss", str(float(in_sec))]
    if dur_sec is not None and float(dur_sec) > 0:
        cmd += ["-t", str(float(dur_sec))]
    cmd += ["-i", str(src), "-vn",
            "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "192k",
            "-movflags", "+faststart", str(dest)]
    code, log = await _run(cmd, timeout=300.0)
    if code != 0 or not dest.exists() or dest.stat().st_size == 0:
        logger.warning("[media] 抽音频失败 %s: %s", video_url[:120], log[-200:])
        dest.unlink(missing_ok=True)
        return None
    return f"/fw/media/generated/{name}", await _probe_duration(dest)


# ---- TB-06 缓存统计与清理 ----
def _dir_stat(d: Path) -> tuple[int, int]:
    """返回 (文件数, 总字节)。目录不存在按空算。"""
    n = total = 0
    if not d.exists():
        return 0, 0
    for f in d.rglob("*"):
        # 并发删除（导出结束清临时文件、另一次 cache_clear）会让 stat 抛
        # FileNotFoundError，不兜住就是接口 500 —— 只是统计而已，跳过即可
        try:
            if f.is_file():
                n += 1
                total += f.stat().st_size
        except OSError:
            continue
    return n, total


@router.get("/system/cache-stats")
def cache_stats() -> dict:
    """各媒体目录的占用情况（设置页「缓存」用）。

    outputs 归为"可清理"：那是历次导出的成片，重新导出就能再生成。
    uploads/generated 是**不可再生**的（用户上传的素材、花钱生成的图与视频），
    绝不能提供一键清空——所以这里只报数字，清理接口只接受 outputs。

    但 generated/ 里确实存在一部分**已无任何数据库引用**的孤儿（换版本、
    重生首帧、删镜头之后留下的），任何界面都再也访问不到，纯占磁盘。
    这里单独把它的体积报出来（B24），用户才知道有这块可回收的空间；
    真正的清理走 /system/cache-clear?scope=generated_orphans，且默认 dry_run。
    """
    items = []
    for key, label, d, clearable in (
        ("outputs", "导出成片", OUTPUT_DIR, True),
        ("generated", "AI 生成素材", GENERATED_DIR, False),
        ("uploads", "上传素材", UPLOAD_DIR, False),
    ):
        n, b = _dir_stat(d)
        items.append({"key": key, "label": label, "files": n, "bytes": b,
                      "clearable": clearable})
    try:
        orphans, orphan_bytes = _scan_generated_orphans()
        orphan_info = {"files": len(orphans), "bytes": orphan_bytes,
                       "min_age_hours": GENERATED_ORPHAN_MIN_AGE_H}
    except Exception:  # noqa: BLE001
        # 统计失败不该让设置页整个打不开
        orphan_info = {"files": 0, "bytes": 0, "error": True}
    return {"items": items, "total_bytes": sum(i["bytes"] for i in items),
            "generated_orphans": orphan_info}


class CacheClearIn(BaseModel):
    #: outputs = 导出成片（可再生）；generated_orphans = generated/ 里**无人引用**的孤儿文件
    scope: str = "outputs"
    #: 只清早于 N 天的；0 = 全清
    older_than_days: int = 0
    #: scope=generated_orphans 时：true 只统计不删（默认，先看清单再决定）
    dry_run: bool = True


#: generated/ 下由本系统产出的文件名前缀。清理孤儿时**只认这些**——
#: 目录里混进来的其它文件（如历史上误落的一个空 filmweaver_dev.db）一律不碰。
#:
#: ⚠️ 加前缀前先确认该类文件的引用列**已在 `media_refs.URL_COLUMNS` 里**，
#: 否则就是把在用文件拉进删除清单。2026-09-11 补的四个：
#:   · tail_（**历史产物**：已停用的尾帧接力，见
#:     `docs/DECISION-2026-09-11-尾帧接力停用.md`）→ 引用列 Shot.tail_frame_url 仍登记着，
#:     所以存量 277 条**仍受保护不会被回收**；要腾出这部分空间得先清空该列，
#:     脚本是 `backend/scripts/purge_tail_frames.py`（默认只报数，`--yes` 才真删）。
#:     新出片不再产生 tail_ 文件。
#:   · shotaudio_（media.py 抽镜头音轨）→ 引用列 AudioClip.url，已登记
#:   · board_（scene_board.py）→ 引用列 Asset.board_url，已登记
#:   · ref_（providers/video_runninghub.py `_fetch_external`）→ **从不落库**：
#:     H3 只吃平台内文件，故把 http 外链拉回本地再上传，用完即弃。
#:     它是设计上的纯临时产物，24h 年龄窗足以覆盖在途任务。
#: 补这四个之前它们**永远回收不掉**（实测 tail_ 302 个 25.8MB、shotaudio_ 63 个
#: 20.9MB、board_ 2 个 1.1MB）。
#:
#: 第五个 `refvoice_`（2026-09-11 的 N2）：`jobs._resolve_media_local` 从视频素材
#: 抽出来的 15s 参考音轨。它原本叫 `<源文件>.refvoice.wav` 落在 **uploads/**——
#: 既是**后缀不是前缀**、又不在本函数扫描的目录里，所以两头都收不掉。
#: 现已改落 `generated/refvoice_<源 id>.wav`：不落任何库、必然被认成孤儿、
#: 24h 后自动回收，下次要用再花几秒重抽，与缩略图同性质的可重建缓存。
_GENERATED_PREFIXES = ("img_", "thumb_", "h3_", "sd_", "shot_", "tts_", "ff_",
                       "anchor_", "tail_", "shotaudio_", "board_", "ref_",
                       "refvoice_")

#: 孤儿文件的最小年龄（小时）。刚生成还没写进库的文件在这个窗口内受保护——
#: 生图/生视频与落库之间存在秒级间隔，按"当前无人引用"直接删会误伤在途产物。
GENERATED_ORPHAN_MIN_AGE_H = 24


def _referenced_filenames(session) -> set[str]:
    """DB 里所有被引用到的媒体文件名（只取文件名，不含路径与 query）。

    ⚠️ 列清单在 `media_refs.URL_COLUMNS`，**不要在这里硬写列名**。
    本函数 2026-09-11 前自己维护了一份，漏掉 `SceneView.image_url`（180 张里
    157 张漏出引用集，其中 7 张已进当前删除清单）、`Shot.tail_frame_url`（277/277）
    与 `Asset.board_url`（1/1）。这些图正好是 `img_*.png`，在上面的前缀白名单内——
    用户在设置里点一次「清理缓存」就是真实数据丢失，而且因为出片时
    `scene_view.pick_for_shot` 要按机位从这些图里挑参考图注入，表现是
    **生成质量静默劣化，连报错都没有**。

    墓碑行（`Asset.deleted_at` / `AssetStage.deleted_at`）仍算"被引用"，
    理由见 `media_refs.referenced_filenames`。
    """
    from .media_refs import referenced_filenames
    return referenced_filenames(session)


def _scan_generated_orphans(older_than_days: int = 0) -> tuple[list[Path], int]:
    """扫出 generated/ 里无人引用的文件，返回 (文件列表, 总字节)。

    三重保险，缺一不可：
      1. 只认本系统的命名前缀（见 _GENERATED_PREFIXES）——目录里的其它文件不碰
      2. 至少 GENERATED_ORPHAN_MIN_AGE_H 小时前的文件才算候选——
         保护"刚生成、还没来得及写库"的在途产物
      3. 与 DB 全量引用比对——被任何一处引用就跳过
    """
    import time

    from .db import get_session
    now = time.time()
    age_cut = now - GENERATED_ORPHAN_MIN_AGE_H * 3600
    day_cut = now - older_than_days * 86400 if older_than_days > 0 else None

    with get_session() as session:
        refs = _referenced_filenames(session)

    out: list[Path] = []
    total = 0
    for f in GENERATED_DIR.rglob("*"):
        try:
            if not f.is_file():
                continue
            if not f.name.startswith(_GENERATED_PREFIXES):
                continue
            st = f.stat()
        except OSError:
            continue
        if st.st_mtime > age_cut:
            continue                    # 太新，可能正在落库
        if day_cut is not None and st.st_mtime > day_cut:
            continue
        if f.name in refs:
            continue                    # 仍被引用
        out.append(f)
        total += st.st_size
    return out, total


@router.post("/system/cache-clear")
def cache_clear(body: CacheClearIn) -> dict:
    """清理可再生缓存（导出成片）或 generated/ 里的孤儿文件。

    - `scope=outputs`：历次导出的成片，重新导出即可再生
    - `scope=generated_orphans`：generated/ 里**已无任何数据库引用**的文件（B24）

    仍然刻意**不提供**"清空 generated/"这种口子：那里绝大多数是花钱买来的
    生成结果，一个按钮全删是灾难性的。只清孤儿——即被换版本/被重生/被删镜头
    之后留下的、任何界面都再也访问不到的那部分（实测占 21%、约 0.9 GB）。
    孤儿清理默认 dry_run，先把清单和体积报给用户，确认后再真删。
    """
    if body.older_than_days < 0:
        # 负数会落进 "cutoff=None → 删全部" 的分支，等于把 -1 当成"全清"，
        # 与字面意思相反。明确拒绝。
        raise HTTPException(400, "older_than_days 不能为负数")

    if body.scope == "generated_orphans":
        files, total = _scan_generated_orphans(body.older_than_days)
        if body.dry_run:
            sample = sorted(files, key=lambda f: f.stat().st_size, reverse=True)[:20]
            return {"ok": True, "dry_run": True,
                    "candidates": len(files), "bytes": total,
                    "min_age_hours": GENERATED_ORPHAN_MIN_AGE_H,
                    "sample": [{"name": f.name, "bytes": f.stat().st_size}
                               for f in sample]}
        removed = freed = 0
        for f in files:
            try:
                size = f.stat().st_size
                f.unlink()
                removed += 1
                freed += size
            except OSError:
                continue
        return {"ok": True, "dry_run": False, "removed": removed,
                "freed_bytes": freed}

    if body.scope != "outputs":
        raise HTTPException(
            400, "scope 只能是 outputs（导出成片）或 generated_orphans"
                 "（generated/ 中无引用的孤儿文件）")
    import time
    cutoff = time.time() - body.older_than_days * 86400 if body.older_than_days > 0 else None
    removed = freed = 0
    for f in OUTPUT_DIR.rglob("*"):
        # stat() 可能在这中间被并发删除（另一次清理、导出结束清理临时文件），
        # 不兜住的话整个接口 500，而且会停在删了一半的状态。
        try:
            if not f.is_file():
                continue
            stat = f.stat()
        except OSError:
            continue
        if cutoff is not None and stat.st_mtime > cutoff:
            continue
        try:
            f.unlink()
            removed += 1
            freed += stat.st_size
        except OSError:
            continue    # 正在被下载/占用的文件跳过即可
    return {"ok": True, "removed": removed, "freed_bytes": freed}
