"""Video Provider：走 OpenAI 兼容网关的 chat/completions 视频通道。

zx1.deepwl.net 实测（2026-08-07）：veo-3-1-fast / veo-3-1 通过
POST /v1/chat/completions（messages 里放提示词）同步返回
assistant content，内容为 markdown 链接 `[download video](https://...)`。
生成视频链接有时效（Expires 签名），故拿到后立刻下载落盘到
`media.GENERATED_DIR`（由 FW_DATA_DIR 决定，dev/prod 各一份），
对外给稳定的 /fw/media/generated/ 地址。

该通道为同步接口：submit() 即阻塞至出片（veo fast 实测约 1-3 分钟），
poll() 仅为满足 VideoProvider 接口——同步通道提交即完成。
"""
from __future__ import annotations

import re
import uuid

import httpx

from ..config import get_settings
# 落盘目录统一从 media 取（读 settings.data_dir）；这里再写一份硬编码路径
# 会让 prod 把视频写进 dev 目录，见 2026-09-01 的「参考素材不可用」。
from ..media import GENERATED_DIR
from .base import (AudioMode, VideoProvider, VideoRequest, VideoResult, VisualMode,
                   sanitize_video_prompt, to_public_url)

# markdown 链接 / 裸 URL 两种返回形态都兼容
_URL_RE = re.compile(r"\((https?://[^\s)]+)\)|(?<!\()(https?://[^\s\]\)\"']+)")


def _extract_url(content: str) -> str | None:
    for m in _URL_RE.finditer(content):
        url = m.group(1) or m.group(2)
        if url:
            return url
    return None


class ChatVideoProvider(VideoProvider):
    """chat/completions 同步视频通道（veo 系等）。"""

    def __init__(
        self,
        model_id: str,
        *,
        visual_mode: VisualMode = VisualMode.first_frame,
        audio_mode: AudioMode = AudioMode.inline,
        duration_slots: list[int] | None = None,
        aspect_ratios: list[str] | None = None,
        timeout: float = 900.0,
    ) -> None:
        self.model_id = model_id
        self.visual_mode = visual_mode
        self.audio_mode = audio_mode
        self.duration_slots = duration_slots or [8]
        self.supports_last_frame = False
        self.aspect_ratios = aspect_ratios or ["16:9", "9:16"]
        self.timeout = timeout
        self.settings = get_settings()

    async def submit(self, req: VideoRequest) -> VideoResult:
        url = f"{self.settings.llm_base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.settings.llm_api_key}",
            "Content-Type": "application/json",
        }
        # 首帧图路线：有图时走多模态 content 块；纯文生视频走纯文本。
        # URL 绝对化：网关侧由远端拉图，相对地址到对端即死链。
        # 提示词净化与 seedance 通道同源：veo 走**直通**（无优化框架），
        # 原稿里的【】与缺失的无文字约束在这条链路上无人把关，只能在这里兜。
        prompt = sanitize_video_prompt(req.prompt) or req.prompt
        if req.first_frame_url or req.reference_image_urls:
            img = to_public_url(req.first_frame_url or req.reference_image_urls[0])
            content: object = [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": img}},
            ]
        else:
            content = prompt
        payload = {"model": self.model_id, "messages": [{"role": "user", "content": content}]}

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                resp = await client.post(url, headers=headers, json=payload)
                resp.raise_for_status()
                data = resp.json()
                text = data["choices"][0]["message"]["content"] or ""
        except httpx.HTTPStatusError as e:
            return VideoResult(status="failed",
                              error=f"HTTP {e.response.status_code}: {e.response.text[:300]}")
        except Exception as e:  # noqa: BLE001
            return VideoResult(status="failed", error=repr(e))

        remote = _extract_url(text)
        if not remote:
            return VideoResult(status="failed", error=f"模型未返回视频链接: {text[:300]}", raw=data)

        # 立刻落盘（远端签名 URL 会过期）
        try:
            local_url = await self._download(remote)
        except Exception as e:  # noqa: BLE001
            # 下载失败也把远端地址给出去，让上层还有机会用
            return VideoResult(status="done", video_url=remote,
                              error=f"落盘失败(已返回远端地址): {e!r}", raw=data)
        return VideoResult(status="done", video_url=local_url, raw=data)

    async def _download(self, remote: str) -> str:
        name = f"shot_{uuid.uuid4().hex[:12]}.mp4"
        dest = GENERATED_DIR / name
        async with httpx.AsyncClient(timeout=600.0, follow_redirects=True) as client:
            async with client.stream("GET", remote) as resp:
                resp.raise_for_status()
                with dest.open("wb") as w:
                    async for chunk in resp.aiter_bytes(1024 * 256):
                        w.write(chunk)
        return f"/fw/media/generated/{name}"

    async def poll(self, task_id: str) -> VideoResult:
        # 同步通道：submit 即完成，不存在待轮询任务
        return VideoResult(status="failed", error="同步视频通道无轮询任务")