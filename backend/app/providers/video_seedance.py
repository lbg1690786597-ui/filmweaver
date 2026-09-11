"""火山方舟 Seedance 2.0 / 2.0 mini 视频生成 Provider。

协议（与主平台 volc/client.py 实测一致）：
- 提交: POST {ark}/contents/generations/tasks  body={"model": <ep>, "content": [...]}
- 查询: GET  {ark}/contents/generations/tasks/{id}  完成时 content.video_url
- 参数走官方 text 尾缀语法: --resolution --duration --ratio --audio
- 多图必须每张带 role（first_frame/last_frame/reference_image），否则 400
  —— 天然支持 i2va/fl2va/l2va/full_reference 全部生成模式。
"""
from __future__ import annotations

import asyncio
import uuid

import httpx

from ..config import get_settings
from ..media import GENERATED_DIR
from .base import (AudioMode, VideoProvider, VideoRequest, VideoResult, VisualMode,
                   sanitize_video_prompt, to_public_url)

_SEEDANCE_ASPECTS = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"]


class SeedanceVideoProvider(VideoProvider):
    """Seedance 系（火山方舟异步任务通道）。音画一体，支持首帧/尾帧/参考图。"""

    def __init__(self, model_id: str, ep: str, *,
                 min_duration: int = 4, max_duration: int = 15,
                 poll_interval: float = 10.0, poll_max: int = 120) -> None:
        self.model_id = model_id
        self.ep = ep
        self.visual_mode = VisualMode.reference
        self.audio_mode = AudioMode.inline
        # 官方支持 min_duration..max_duration 连续区间（AI 拆镜动态判定时长直接
        # 下发，不取整到档位）。2.0/2.0-mini 上限 15s；2.5 提到 30s。
        #
        # ⚠️ **下限不是 1**：官方文档（api-doc-rules.txt）写「时长 4~16 秒」，
        #    实测 seedance-2.0-mini 的 r2v（带参考图）变体对 3s 直接 400：
        #      InvalidParameter: the specified duration is not supported
        #      for model doubao-seedance-2-0-mini-r2v
        #    原来 duration_slots 从 1 起、submit() 又 `max(1, ...)` 兜底，等于
        #    宣称 1~3s 合法：AI 拆镜或用户手调只要落到 <4s，这一镜生成时必 400，
        #    且是**出片那一刻**才炸、拆镜阶段毫无预警。故下限收到 min_duration。
        #
        # ⚠️ 这个上限**同时决定解说剧的拆镜粒度**：
        #   duration_slots → base.max_seconds() → routes_v2.shot_seconds_cap()
        #   → narration_max_chars() → 拆解提示词的字数上限
        # 所以给 2.5 配 30 之后，拆解会自动按 25~30s 一段设计，
        # 不需要在拆解侧写任何 if model == "seedance-2.5" 的分支。
        self.min_duration = int(min_duration)
        self.duration_slots = list(range(self.min_duration, max_duration + 1))
        self.max_duration = int(max_duration)      # submit() 钳制用，见其内注释
        self.supports_last_frame = True            # 支持 last_frame role
        self.aspect_ratios = list(_SEEDANCE_ASPECTS)
        self.max_reference_images = 4              # 官方多参考图上限，实测后校准
        # 参考音频（音色参考）：官方支持 0~3 个 audio_url，见
        # prompt_opt/skill_assets/seedance2/references/api-doc-rules.txt「输入素材数量限制」。
        # ⚠️ 这里原本写死 False 并在 submit() 里直接 return failed，理由写的是
        #    "音画一体自带声音"——那是把"能自己配音"误当成"不能指定音色"。
        #    后果：给人物上传的音色永远到不了模型，且**静默**（上层只把该镜标失败）。
        #    2026-09-10 实测方舟接口证实支持，报错原文见 _build_audios 注释。
        self.supports_reference_audio = True
        self.max_reference_audios = 3
        self.supports_reference_video = False
        self.poll_interval = poll_interval
        self.poll_max = poll_max

    def mode_support(self) -> dict[str, dict]:
        """Seedance 官方支持全部帧锚定模式与参考图/参考音频（无参考视频）。

        `reference_audio` 逐模式给：官方明确「不支持"文本+音频"、"纯音频"输入」
        （api-doc-rules.txt「输入素材数量限制」），故 **t2va 不能带音频**——
        纯文本镜头若硬塞音色参考会被接口 400 打回。其余模式都至少有一张图，可带。
        """
        return {
            "t2va": {"available": True, "reference_audio": False},
            "i2va": {"available": True, "reference_audio": True},
            "fl2va": {"available": True, "reference_audio": True},
            "l2va": {"available": True, "reference_audio": True},
            "full_reference": {"available": True, "reference_audio": True,
                               "reference_video": False},
        }

    def _cfg(self) -> tuple[str, str]:
        s = get_settings()
        key = (s.ark_api_key or "").strip()
        if not key:
            raise RuntimeError("FW_ARK_API_KEY 未配置")
        return key, s.ark_base_url.rstrip("/")

    @staticmethod
    def _build_images(req: VideoRequest) -> list[dict]:
        """按生成模式组装带 role 的图片列表（多图必须带 role，火山硬约束）。

        URL 一律绝对化：方舟是"把 URL 交给远端自己拉"，相对地址到对端即死链。
        """
        images: list[dict] = []
        if req.first_frame_url:
            images.append({"url": to_public_url(req.first_frame_url),
                           "role": "first_frame"})
        if req.last_frame_url:
            images.append({"url": to_public_url(req.last_frame_url),
                           "role": "last_frame"})
        for u in (req.reference_image_urls or []):
            images.append({"url": to_public_url(u), "role": "reference_image"})
        return images

    @staticmethod
    def _build_audios(req: VideoRequest) -> list[dict]:
        """组装参考音频（音色参考）content 分片。

        形状是 2026-09-10 直接问接口问出来的，两次探测的原文报错：
          1. `{"type":"audio_url_xyz"}` → “supported values are: `text`,
             `image_url`, `audio_url`, `video_url` and `draft_task`”
             —— 确认字段名就是 `audio_url`，与 image_url 同构。
          2. `{"type":"audio_url","audio_url":{...}}`（不带 role）→
             “reference media mode requires audio role to be reference_audio”
             —— 确认 **role 必填且只能是 reference_audio**，漏了就 400。
        文档页当时抓不到（沙箱不放行 docs.volcengine.com），故以接口自身为准。

        URL 同样要绝对化：方舟是把 URL 交给远端自己拉，相对地址到对端即死链。
        """
        out: list[dict] = []
        for u in ([req.reference_audio_url] if req.reference_audio_url else []):
            pub = to_public_url(u)
            if pub:
                out.append({"type": "audio_url", "audio_url": {"url": pub},
                            "role": "reference_audio"})
        return out

    async def submit(self, req: VideoRequest) -> VideoResult:
        key, base = self._cfg()
        if req.reference_video_url:
            return VideoResult(status="failed", error="Seedance 通道不支持参考视频")

        seconds = int(round((req.duration_ms or 5000) / 1000))
        # ⚠️ 这里原本写死 `min(15, seconds)`，把构造参数 max_duration **只用在
        #    规划侧、请求侧直接忽略**，于是 seedance-2.5 出现了一条静默劈叉：
        #      duration_slots(1..30) → max_seconds() → shot_seconds_cap()
        #        → 拆镜按 25~30s 设计单镜
        #      submit() → 写死钳到 15 → 实际只出 15.07s
        #    2026-09-04 的真人剧验证片实测：29 镜里 **17 镜**计划 16~29s、
        #    实际全是 15.07s，且 145 条字幕里 32 条落在视频结束之后（最长的一镜
        #    计划 29.3s，尾部 14.2s 的台词根本没画面）。全程无任何报错——
        #    因为 Shot.duration_sec 保留的是未钳制的计划值，没人回头对过实测时长。
        #    改为跟着 max_duration 走：2.0/2.0-mini 仍是 15（range(1,16) 最大值），
        #    行为完全不变；只有显式声明了更大上限的通道才会真的下发更长时长。
        #
        # 下限同理跟着 min_duration 走（原来写死 1）：官方最短 4s，传 1~3 会被
        # 接口 400 打回（报错原文见 __init__ 注释）。时间轴上允许存在 2s 的短镜
        # ——那是剪辑自由——但**下发时必须抬到 4s**：出一条 4s 的片再由取片窗口
        # 裁到 2s，远好过整镜生成失败。
        seconds = max(self.min_duration, min(self.max_duration, seconds))
        aspect = req.aspect_ratio if req.aspect_ratio in _SEEDANCE_ASPECTS else "9:16"
        # 分辨率：由项目档位 megapixels 近似映射回 p 档（Seedance 用 p 档语法）
        mp = req.megapixels or 0.9
        resolution = "480p" if mp <= 0.5 else "720p" if mp <= 1.2 else "1080p"

        tail = f" --resolution {resolution} --duration {seconds} --ratio {aspect} --audio true"
        # 净化：拆掉【】(=Seedance 的"烧字幕"语法) + 补无文字约束。见 base.sanitize_video_prompt
        body = sanitize_video_prompt(req.prompt.strip()) or req.prompt.strip()

        images = self._build_images(req)
        if len(images) > 6:
            return VideoResult(status="failed", error=f"参考图过多({len(images)})")
        # 参考音频（音色）：官方不收「纯文本+音频」「纯音频」输入
        # （api-doc-rules.txt「输入素材数量限制」），一张图都没有时直接不带——
        # 少一个音色远好过整镜被 400 打回。
        audios = self._build_audios(req)[: self.max_reference_audios] if images else []
        if audios:
            # 参考音频只有被提示词**点名**才会当音色用（typical-effect-cases 3.8：
            # 「Prompt 中准确指定参考音频」「整个视频主角的音色必须参考音频1」）。
            # 只送 audio_url 不写这句，模型可能当背景音甚至忽略。恒定只发一段，
            # 故写死"音频1"；接在正文之后、--尾缀之前，不影响 flag 解析。
            body = f"{body.rstrip()}".rstrip("。") + "。整个视频主角的音色必须参考音频1。"

        content: list[dict] = [{"type": "text", "text": f"{body}{tail}"}]
        for img in images:
            part: dict = {"type": "image_url", "image_url": {"url": img["url"]}}
            if len(images) > 1 or img["role"] != "first_frame":
                part["role"] = img["role"]   # 多图必带 role；单首帧可省略（走默认）
            content.append(part)
        content.extend(audios)

        headers = {"Authorization": f"Bearer {key}", "Content-Type": "application/json"}
        try:
            async with httpx.AsyncClient(timeout=120.0) as c:
                r = await c.post(f"{base}/contents/generations/tasks",
                                 headers=headers,
                                 json={"model": self.ep, "content": content})
        except Exception as e:  # noqa: BLE001
            return VideoResult(status="failed", error=f"提交失败: {e!r}")
        if r.status_code not in (200, 201):
            return VideoResult(status="failed",
                               error=f"HTTP {r.status_code}: {r.text[:300]}")
        tid = (r.json().get("id") or r.json().get("task_id"))
        if not tid:
            return VideoResult(status="failed", error=f"未返回任务 id: {r.text[:200]}")

        meta = {"ep": self.ep, "resolution": resolution, "duration": seconds,
                "ratio": aspect, "images": [i["role"] for i in images],
                "audios": len(audios)}
        # 轮询至出片（与其他通道行为一致）
        for _ in range(self.poll_max):
            await asyncio.sleep(self.poll_interval)
            st = await self._query(str(tid), key, base)
            if st["status"] == "SUCCEEDED" and st.get("video_url"):
                local = await self._download(st["video_url"])
                return VideoResult(status="done", task_id=str(tid), video_url=local,
                                   duration_ms=seconds * 1000,
                                   raw={**meta, "usage": st.get("usage")})
            if st["status"] in ("FAILED", "CANCELLED", "EXPIRED"):
                return VideoResult(status="failed", task_id=str(tid),
                                   error=f"任务 {st['status']}: {st.get('reason', '')[:200]}",
                                   raw=meta)
        return VideoResult(status="failed", task_id=str(tid),
                           error=f"轮询超时(>{int(self.poll_interval * self.poll_max)}s)",
                           raw=meta)

    @staticmethod
    async def _query(task_id: str, key: str, base: str) -> dict:
        headers = {"Authorization": f"Bearer {key}"}
        async with httpx.AsyncClient(timeout=60.0) as c:
            r = await c.get(f"{base}/contents/generations/tasks/{task_id}", headers=headers)
        if r.status_code != 200:
            raise RuntimeError(f"查询 HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        content = d.get("content") or {}
        return {"status": (d.get("status") or "").upper(),
                "video_url": (content.get("video_url") if isinstance(content, dict) else None)
                             or d.get("video_url"),
                "usage": d.get("usage"),
                "reason": str(d.get("error") or d.get("message") or "")}

    @staticmethod
    async def _download(remote: str) -> str:
        name = f"sd_{uuid.uuid4().hex[:12]}.mp4"
        dest = GENERATED_DIR / name
        async with httpx.AsyncClient(timeout=600.0, follow_redirects=True) as c:
            async with c.stream("GET", remote) as resp:
                resp.raise_for_status()
                with dest.open("wb") as w:
                    async for chunk in resp.aiter_bytes(1024 * 256):
                        w.write(chunk)
        return f"/fw/media/generated/{name}"

    async def poll(self, task_id: str) -> VideoResult:
        key, base = self._cfg()
        st = await self._query(task_id, key, base)
        if st["status"] == "SUCCEEDED" and st.get("video_url"):
            local = await self._download(st["video_url"])
            return VideoResult(status="done", task_id=task_id, video_url=local)
        if st["status"] in ("FAILED", "CANCELLED", "EXPIRED"):
            return VideoResult(status="failed", task_id=task_id, error=st.get("reason"))
        return VideoResult(status="running", task_id=task_id)
