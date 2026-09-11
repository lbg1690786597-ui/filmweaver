"""Provider 注册表。集中登记可用模型，上层按 model_id 取用。

新增模型步骤：
1. 在 providers/ 下实现一个 VideoProvider 子类。
2. 在 register_defaults() 里注册一行。
3. 完毕——路由/编排层无需改动。
"""
from __future__ import annotations

from .base import VideoProvider


class ProviderRegistry:
    def __init__(self) -> None:
        self._video: dict[str, VideoProvider] = {}

    def register_video(self, provider: VideoProvider) -> None:
        self._video[provider.model_id] = provider

    def get_video(self, model_id: str) -> VideoProvider | None:
        return self._video.get(model_id)

    def list_video(self) -> list[dict]:
        return [
            {
                "model_id": p.model_id,
                "visual_mode": p.visual_mode.value,
                "audio_mode": p.audio_mode.value,
                "duration_slots": p.duration_slots,
                "supports_last_frame": p.supports_last_frame,
                "aspect_ratios": p.aspect_ratios,
                "max_reference_images": p.max_reference_images,
                "supports_reference_audio": p.supports_reference_audio,
                "supports_reference_video": p.supports_reference_video,
            }
            for p in self._video.values()
        ]


registry = ProviderRegistry()


def register_defaults() -> None:
    """登记默认 Provider。

    zx1.deepwl.net 网关实测（2026-08-07）：
    - veo-3-1-fast：chat/completions 同步通道可出片（约1-3分钟），默认路线 ✓
    - veo-3-1：同通道，质量档
    其余（seedance/kling/grok-video 等）在当前分组无可用渠道（model_not_found），
    渠道开通后在此追加注册即可，上层零改动。
    """
    from .video import ChatVideoProvider
    from .base import AudioMode, VisualMode

    registry.register_video(ChatVideoProvider(
        "veo-3-1-fast",
        visual_mode=VisualMode.first_frame,
        audio_mode=AudioMode.inline,
        duration_slots=[8],
        aspect_ratios=["16:9", "9:16"],
    ))
    registry.register_video(ChatVideoProvider(
        "veo-3-1",
        visual_mode=VisualMode.first_frame,
        audio_mode=AudioMode.inline,
        duration_slots=[8],
        aspect_ratios=["16:9", "9:16"],
    ))

    # RunningHub MiniMax H3 参考图生视频（异步 ComfyUI 工作流通道）。
    # 与 veo 互补：可吃最多 9 张参考图 + 参考音频 + 参考视频，分辨率/比例/时长/seed 精确可控，
    # 适合多角色一致性镜头；代价是慢（1MP/8s 实测约 600s）。
    # 仅在配置了 API key 时注册，未配置则静默跳过（不影响 veo 通道）。
    from ..config import get_settings
    from .video_runninghub import RunningHubH3VideoProvider

    if (get_settings().runninghub_api_key or "").strip():
        registry.register_video(RunningHubH3VideoProvider())

    # 火山方舟 Seedance 2.0 / 2.0 mini（配置 KEY+EP 即注册，同 RunningHub 模式）。
    # 音画一体、支持首帧/尾帧/参考图 role → 五生成模式全开；
    # seedance* 前缀自动命中 seedance2 提示词优化框架（prompt_opt）。
    from .video_seedance import SeedanceVideoProvider
    s = get_settings()
    if (s.ark_api_key or "").strip():
        if (s.seedance_ep or "").strip():
            registry.register_video(SeedanceVideoProvider("seedance-2.0", s.seedance_ep.strip()))
        if (s.seedance_mini_ep or "").strip():
            registry.register_video(SeedanceVideoProvider("seedance-2.0-mini", s.seedance_mini_ep.strip()))
        if (s.seedance25_ep or "").strip():
            # 2.5 与 2.0 同协议同能力，唯一差别是单镜可出 30s（2.0 是 15s）。
            # 提示词优化沿用 seedance2 框架（prompt_opt 按 "seedance" 前缀命中）。
            registry.register_video(SeedanceVideoProvider(
                "seedance-2.5", s.seedance25_ep.strip(), max_duration=30))