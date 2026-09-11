"""RunningHub MiniMax H3 视频生成 Provider（多工作流：全参考 / 首帧 / 首尾帧）。

与 veo 通道（同步 chat/completions）互补：H3 走 ComfyUI 异步工作流，
能力更强但更慢，适合"多角色一致性"镜头。

⚠️ **一个生成模式 = 一条独立工作流 = 一套独立节点号**。节点映射见 MODE_NODES，
   新增模式只需加一条 H3Nodes + 填对应 workflow id 环境变量。

## full_reference / t2va：参考图生视频工作流 2084464684937342977
实测结论（2026-08）：
- 参考输入：最多 9 张参考图（#137/#139/#142/#147/#149~#153）+ 参考音频（#155 LoadAudio）。
  9 个图槽默认全空（image=None），**未用到的槽必须不传**，不能塞占位图，
  否则占位图会被当参考喂给模型，污染参考语义。
- 参考视频（#158 VHS_LoadVideo）：作者已在最新工作流里**关闭该节点**，不再参与执行。
  故本 Provider 不再覆盖 #158（对已关闭的节点传 nodeInfo 会 NODE_INFO_MISMATCH），
  `supports_reference_video = False`。历史版本曾因 #158 被硬接进 #136 且默认值
  video="0" 非法而必须喂纯黑占位视频，该 workaround 已随节点关闭一并移除。
  未来若要重启参考视频能力，需作者重新打开 #158，再恢复参考视频节点的覆盖逻辑。
- #155(LoadAudio) 默认 audio="None"，实测不覆盖也不报错。
- 提示词节点 #138 是 PrimitiveStringMultiline，字段名 **value**。

## i2va：首帧生视频工作流 2086982586613714946（2026-08 接入）
- 提示词节点 #55 是 Text，字段名 **text**（与上面那条不同，写错会静默不生效）。
- 只有 1 个图槽 #61；无参考音频节点。详见 I2VA_NODES 注释。
- 首帧语义靠提示词首行官方指令行承载，见 I2VA_INSTRUCTION。

## fl2va：首尾帧生视频工作流 2086993488448675842（2026-08 接入）
- 提示词**没有独立节点**，写在 #332 MiniMaxH3ImageToVideo 自带的 **prompt** 输入上
  （第三种字段名写法）。
- 两个专用图槽 #61(first_frame) / #73(last_frame)，**两张都必填**；无通用参考图槽、
  无参考音频节点。首尾语义由节点承载，不需要提示词指令行。详见 FL2VA_NODES 注释。

## 三条工作流共通的物理约束
- 分辨率：ResolutionSelector 按 aspect_ratio + megapixels 算，
  再对齐 32 的倍数（multiple=32 是 VAE 约束，不可改）。
  实测 5 组全部吻合 sqrt(MP*1024^2/(w*h)) 公式。
- 时长：PrimitiveFloat（浮点秒）；下游表达式节点把帧数对齐到 %17==5（模型约束），
  实测 2s→56帧=2.333s、8s→192帧=8.000s。
- seed：RandomNoise.noise_seed。工作流里是**固定值**，不覆盖就永远同一结果，
  故本 Provider 默认每次随机化（见 _pick_seed）。
- 显存包线（实测）：2MP + 8s 在默认机与 plus(48G) 均 CUDA OOM；
  可行域 2MP≤2~3s、1MP≤8s。故 megapixels 缺省按时长自动降档（见 _auto_megapixels）。
- 出片自带 AI 音轨（AAC 32kHz 立体声），24fps H.264。
- instanceType：plus=48G(1.5×价) 可用；ultra=84G 当前账号未开通
  （注意：乱写的值会被**静默忽略**降级到默认机，不会报错）。
"""
from __future__ import annotations

import asyncio
import logging
import math
import random
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import httpx

from ..config import get_settings
from .base import (AudioMode, VideoProvider, VideoRequest, VideoResult,
                   VisualMode, sanitize_video_prompt)

from ..media import GENERATED_DIR  # 复用 media 模块的目录约定，避免路径两处定义

logger = logging.getLogger(__name__)

# ---- 工作流节点映射 ----
# ⚠️ 每个生成模式是**一条独立的 ComfyUI 工作流**，节点号与字段名互不相同，
#    绝不可共用一套常量。曾经只有 ref2v 一条工作流时是模块级常量，
#    接入 i2va 工作流后发现连 prompt 的 fieldName 都不同（value vs text），
#    故改为按模式的映射表。新增模式工作流时在此加一条 H3Nodes 即可。
@dataclass(frozen=True)
class H3Nodes:
    """一条 H3 工作流的可覆盖节点。None 表示该工作流没有对应节点。

    ⚠️ prompt_field 三条工作流各不相同（value / text / prompt），写错不报错只丢值。
    """
    prompt: str
    prompt_field: str            # ref2v=PrimitiveStringMultiline.value；i2va=Text.text；
                                 # fl2va=MiniMaxH3ImageToVideo 自带的 .prompt 输入
    duration: str                # PrimitiveFloat.value（秒）；帧数由下游表达式节点自动对齐
    seed: str                    # RandomNoise.noise_seed
    resolution: str              # ResolutionSelector: aspect_ratio / megapixels
    ref_images: tuple[str, ...] = ()   # 通用参考图槽 LoadImage.image，顺序即 ref_image_0..N
    ref_audio: str | None = None       # LoadAudio.audio
    first_frame: str | None = None     # 专用首帧槽（接 MiniMaxH3ImageToVideo.first_frame）
    last_frame: str | None = None      # 专用尾帧槽（接 MiniMaxH3ImageToVideo.last_frame）

    @property
    def max_images(self) -> int:
        """通用参考图槽位数（不含专用首/尾帧槽）。"""
        return len(self.ref_images)

    @property
    def frame_slots(self) -> bool:
        """True = 该工作流用专用首/尾帧槽，而非通用参考图槽。"""
        return self.first_frame is not None or self.last_frame is not None


#: 参考图生视频工作流（2084464684937342977）——t2va / full_reference 共用。
#: 9 个图槽默认全空，未用到的槽必须不传（塞占位图会污染参考语义）。
#: 注：#158(VHS_LoadVideo) 参考视频节点已在该工作流中关闭，故不定义/不覆盖。
REF2V_NODES = H3Nodes(
    prompt="138", prompt_field="value", duration="132", seed="129",
    resolution="115",
    ref_images=("137", "139", "142", "147", "149", "150", "151", "152", "153"),
    ref_audio="155",
)

#: 首帧生视频工作流（2086982586613714946）——i2va 专用。
#: 结构差异（2026-08 核对平台 getJsonApiFormat 返回，与作者提供的 JSON 一致）：
#: - 只有 **1 个图槽** #61，图经 #63 缩放后进 #329 MiniMaxH3ReferenceToVideo
#:   的 ref_image_0（ref_image_size="match"，会对齐到 #59 算出的输出尺寸）——
#:   故首帧图的画幅必须与请求 aspect_ratio 一致，否则会被裁切（本项目首帧图
#:   本就按项目画幅生成，天然对齐）。
#: - **无 LoadAudio 节点**：该工作流不支持参考音频（传了会静默无效，故显式报错）。
#: - 采样走 #8 fl2va UNET（#9 ref2va 分支不接输出，ComfyUI 不会执行，仅是 JSON 冗余）。
#:   "参考图即第一帧"的语义由提示词首行指令承载（见 I2VA_INSTRUCTION）。
I2VA_NODES = H3Nodes(
    prompt="55", prompt_field="text", duration="58", seed="235",
    resolution="59", ref_images=("61",), ref_audio=None,
)

#: 首尾帧生视频工作流（2086993488448675842）——fl2va 专用（2026-08 接入）。
#: 结构与前两条又都不同（已核对平台 getJsonApiFormat，28 节点，与作者 JSON 一致）：
#: - **提示词没有独立节点**：直接写在 #332 MiniMaxH3ImageToVideo 自带的 `prompt`
#:   输入上，字段名就是 **prompt**（第三种写法；前两条分别是 value / text）。
#: - **两个专用图槽**：#61→#63→`first_frame`，#73→#71→`last_frame`。
#:   两张都是**必填**（LoadImage 默认 image="None"，缺一张该节点直接报错），
#:   故不接受"只给首帧"的调用，也没有通用参考图槽。
#: - 缩放节点 #63/#71 用 `aspect_ratio="original"`（**保持原图画幅、不裁切**），
#:   只把总像素缩到约 1536 千像素并对齐 32。也就是说画幅不一致**不会**被这里纠正，
#:   会直接带进 #332 与 #349 算出的 width/height 打架 → 拉伸/裁切。
#:   故本 Provider 在提交前主动校验首尾帧画幅与请求比例是否吻合（容差 5%）。
#: - **无 LoadAudio 节点**：不支持参考音频。
#: - 首尾帧语义由 #332 的 first_frame/last_frame 输入直接承载，
#:   **不需要**也**不应该**像 i2va 那样往提示词里塞指令行。
#: - 同样有 #9(ref2va UNET)→#125→#187 的死分支，不接输出、不会执行，忽略即可。
FL2VA_NODES = H3Nodes(
    prompt="332", prompt_field="prompt", duration="346", seed="338",
    resolution="349", ref_audio=None,
    first_frame="61", last_frame="73",
)

#: 模式 → 节点映射。未列出的模式（l2va）尚无工作流，_cfg 会先行拦截。
MODE_NODES: dict[str, H3Nodes] = {
    "t2va": REF2V_NODES,
    "full_reference": REF2V_NODES,
    "i2va": I2VA_NODES,
    "fl2va": FL2VA_NODES,
}

#: I2VA 官方固定指令行（Video Prompt Writing Guide §2.1）。
#: 这一行是"参考图=0.00 秒首帧"语义的**唯一载体**——工作流节点本身只是把图喂进
#: ReferenceToVideo，缺了它模型会把图当泛参考而非首帧，画面从别的构图起手。
#: 提示词优化技能（skill_assets/minimax_h3）在 生成模式=i2va 时会产出该行，
#: 但优化可能失败/被跳过（用户手填提示词、LLM 直通），故提交前兜底补写。
I2VA_INSTRUCTION = ("For the target video, at 0.00 seconds into the target video, "
                    "<Picture 1> (from [Shot 1]) is fully referenced.")

# ComfyUI ResolutionSelector 合法枚举（必须逐字符一致，写错会 KeyError 炸任务）
ASPECT_ENUM = {
    "1:1": "1:1 (Square)",
    "2:3": "2:3 (Portrait Photo)",
    "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)",
    "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)",
    "16:9": "16:9 (Widescreen)",
    "21:9": "21:9 (Ultrawide)",
}

_IMAGE_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
               ".webp": "image/webp"}
_AUDIO_MIME = {".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac",
               ".m4a": "audio/mp4"}
_VIDEO_MIME = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
               ".mkv": "video/x-matroska"}


def frames_for(seconds: float) -> int:
    """复刻 #131 表达式，用于预估实际出片时长（对齐到 %17==5）。"""
    v = max(5, round(seconds * 24))
    return v + (5 - (v % 17)) % 17


def resolution_for(aspect: str, megapixels: float, multiple: int = 32) -> tuple[int, int]:
    """复刻 #115 ResolutionSelector 的算法，用于日志/校验。"""
    w_r, h_r = (int(x) for x in aspect.split(":"))
    scale = math.sqrt(megapixels * 1024 ** 2 / (w_r * h_r))
    w = int(round(w_r * scale / multiple)) * multiple
    h = int(round(h_r * scale / multiple)) * multiple
    return w, h


#: 各机型的显存预算，单位 **MP·s**（百万像素 × 秒）。
#:
#: 【2026-08-29/30 实测标定】scripts/probe_video_limits.py，72 点全测完，
#: 模型 minimax-h3-ref2v / 画幅 9:16 / **无参考素材** / 无未测出点。
#: 取值为「成功点最大值」（下方区间的左端），右端是最小爆显存点。
#:
#:   default(24G): 15 ~ 16   0.5MP→30s  1.0MP→15s  2.0MP→5s
#:      plus(48G): 20 ~ 24   0.5MP→40s  1.0MP→20s  2.0MP→8s
#:     ultra(84G): 20 ~ 24   0.5MP→40s  1.0MP→20s  2.0MP→8s
#:
#: default 那条边界由三个分辨率档交叉验证（15 通过、16 就炸），干净可信。
#: 显存占用正比于 latent 体积（像素 × 帧数），故 MP·s 是对的量纲，
#: 比原来"按时长查表"更能外推到没测过的组合。
#:
#: ⚠️ **ultra 与 plus 逐点完全相同**（20 个共同点的成功/失败模式一致，
#: 含 20s@1.0MP 双双通过、25s@1.0MP 双双爆）。84G 比 48G 多 75% 显存却
#: 零收益，说明瓶颈不是显存容量而是工作流/模型自身的 latent 长度上限。
#: ¥9/h 相对 ¥6/h 是纯浪费——**没有任何理由选 ultra**。
#: 另注：24G→48G 显存翻倍也只换来预算 +33%，边际效益同样不佳。
_VRAM_BUDGET_MPS: dict[str, float] = {
    "default": 15.0,             # 24G，¥4/h
    "plus": 20.0,                # 48G，¥6/h
    "ultra": 20.0,               # 84G，¥9/h —— 与 plus 同能力，不值
}

#: 未显式指定机型时实际使用的档位 —— **plus（48G）**。
#:
#: 为什么不是 default(24G)：24G 的预算只有 15 MP·s，0.5MP 下单镜 30s、
#: 1.0MP 下只有 15s；plus 是 20 MP·s，同分辨率能出 40s / 20s。多出的
#: ¥2/h 换来 1/3 的镜头数下降 —— 镜头少意味着调用次数少、拼接痕迹少、
#: 总时长反而更短，综合成本是降的而不是升的。
#:
#: 而 ultra(84G) 与 plus 逐点同能力（见上），多花 ¥3/h 零收益，永不默认。
#:
#: ⚠️ 这个值同时决定**拆镜时长上限**（max_narration_sec 的默认机型）。
#: 两者必须同源：若真实调用走 plus、拆镜却按 default 的 15 MP·s 算，
#: 镜头会被无谓地切碎；反过来则会提交注定 OOM 的任务。
DEFAULT_INSTANCE_TYPE = "plus"

#: 生产余量系数。探测是**纯 prompt**跑的，而真实请求会带最多 9 张参考图
#: + 参考音频，这些额外占显存，故真实可用预算略低于实测值。
#: 取 0.95：只削掉贴边的那一点点。不用更激进的值（如 0.8），因为那会在
#: 0.5MP 档把 30s 砍到 24s，白白多切 25% 的镜头——而拆镜侧另有
#: _DURATION_HEADROOM_SEC 的 2s 余量兜底，两层足够。
_VRAM_SAFETY = 0.95

#: 可选的分辨率档位，从高到低。
_MP_LADDER = (2.0, 1.0, 0.5)


def resolve_instance_type(instance_type: str = "") -> str:
    """空串/None → DEFAULT_INSTANCE_TYPE。全链路统一从这里取机型名。

    要显式要 24G 机请传 "default"（而不是留空）—— 留空的语义是
    "没指定，用我们认为最划算的那档"，现在等于 plus。
    """
    return (instance_type or "").strip() or DEFAULT_INSTANCE_TYPE


def vram_budget(instance_type: str = "") -> float:
    """该机型的**生效**显存预算（MP·s，已含安全余量）。"""
    raw = _VRAM_BUDGET_MPS.get(resolve_instance_type(instance_type),
                               _VRAM_BUDGET_MPS[DEFAULT_INSTANCE_TYPE])
    return raw * _VRAM_SAFETY


def max_seconds_for(megapixels: float, instance_type: str = "") -> float:
    """给定分辨率，该机型能安全生成的最长时长（秒）。"""
    return vram_budget(instance_type) / max(0.1, megapixels)


def _auto_megapixels(seconds: float, instance_type: str = "") -> float:
    """按显存预算选最高的安全分辨率档。

    原实现是按时长查表（≤3s→2MP / ≤8s→1MP / 否则 0.5MP），有个会直接
    打爆显存的洞：最后那条 `return 0.5` **对时长不设上限**，于是 35s 的
    镜头拿到 0.5MP，算出 17.5 MP·s，远超 default 的 15 —— 解说剧实测出现
    的 35s 片段爆显存就是从这里来的。

    改成按预算反推：选**满足 mp × seconds ≤ 预算**的最高档。
    若连最低档 0.5MP 都装不下，返回 0.5 并由调用方拦截报错——
    这种情况必须显式失败，不能默默提交一个注定 OOM 的任务。
    """
    budget = vram_budget(instance_type)
    for mp in _MP_LADDER:
        if mp * seconds <= budget:
            return mp
    return _MP_LADDER[-1]


def _pick_seed(seed: Optional[int]) -> int:
    """种子随机化：工作流内是固定 seed，不覆盖则同 prompt 永远同一结果。

    显式传入则复用（便于复现/A-B 对比）；否则每次随机。
    ComfyUI noise_seed 上限取 2^63-1 之内的安全范围。
    """
    if seed is not None:
        return int(seed)
    return random.randint(1, 2 ** 53 - 1)


def _resolve_local(url: str) -> Optional[Path]:
    """把 /fw/media/... 地址映射回本地磁盘路径（复用 media 模块的目录约定）。"""
    from ..media import _resolve_local as media_resolve
    p = media_resolve(url)
    if p is not None:
        return p
    cand = Path(url)
    return cand if cand.is_absolute() else None


async def _fetch_external(url: str) -> Path:
    """H3 只吃平台内上传的文件，http 外链先拉回本地临时目录再上传。"""
    async with httpx.AsyncClient(timeout=300.0, follow_redirects=True) as c:
        r = await c.get(url)
    if r.status_code != 200:
        raise RuntimeError(f"下载参考素材失败 HTTP {r.status_code}: {url[:80]}")
    ext = Path(url.split("?", 1)[0]).suffix.lower() or ".bin"
    dest = GENERATED_DIR / f"ref_{uuid.uuid4().hex[:12]}{ext}"
    dest.write_bytes(r.content)
    return dest



class RunningHubH3VideoProvider(VideoProvider):
    """MiniMax H3 参考图生视频（RunningHub ComfyUI 异步工作流）。

    异步三段式：upload（参考素材）→ create（覆盖节点参数）→ 轮询 status → outputs。
    submit() 提交并轮询至出片（与 ChatVideoProvider 行为一致，上层零差异），
    poll() 供已有 task_id 的续查场景使用。
    """

    def __init__(
        self,
        model_id: str = "minimax-h3-ref2v",
        *,
        instance_type: str | None = None,
        poll_interval: float = 10.0,
        #: 轮询上限：**默认不设**。只有 RunningHub 主动报 FAILED 才算失败，
        #: 我方绝不主动打断——被自己取消的任务无法区分"能力不足"和"排队慢"，
        #: 2026-08-29 标定时就因 1800s 上限误杀 14 个点，把 plus/ultra 的
        #: 包线统计成和 default 一样高（假象）。实测 40s@0.5MP 真实耗时
        #: 2880s（48 分钟），旧的 30 分钟上限在生产中同样会误杀长镜。
        #: 传正整数可恢复有限轮询（仅测试用）。
        poll_max: int | None = None,
        timeout: float = 120.0,
        enforce_vram_budget: bool = False,
    ) -> None:
        self.model_id = model_id
        self.visual_mode = VisualMode.reference
        self.audio_mode = AudioMode.inline
        # 时长连续可调（受显存限制），列出常用档供前端选择
        self.duration_slots = [2, 3, 5, 8, 12, 15, 20, 30, 40]
        self.aspect_ratios = list(ASPECT_ENUM.keys())
        self.max_reference_images = REF2V_NODES.max_images   # 9（full_reference 路线）
        self.supports_reference_audio = True
        # #158(VHS_LoadVideo) 已在工作流中关闭，参考视频能力暂不可用
        self.supports_reference_video = False
        self.poll_interval = poll_interval
        self.poll_max = poll_max
        self.timeout = timeout
        self._instance_type_override = instance_type
        #: 是否在提交前按 _VRAM_BUDGET_MPS 拦截超预算请求。
        #: **标定脚本必须传 False** —— 预算值本身就是靠实测标出来的，
        #: 若探测时也走这道守卫，就变成"拿写死的预算去验证预算"的循环论证：
        #: 探测点会在 0 秒被本地拒绝、根本到不了 GPU，却被记成 OOM 数据
        #: （2026-08-29 实测踩过：14 个点全被自己的守卫拦下并写进结果文件）。
        self._enforce_vram_budget = enforce_vram_budget

    def max_seconds(self, megapixels: float | None = None) -> float | None:
        """H3 的时长上限由**显存**决定，随分辨率变化，不是固定档位。

        不能沿用基类的 max(duration_slots)：那里的 [2,3,5,8] 只是给手动
        覆盖用的常用档，与真实包线无关（0.5MP 实测能出 40s）。
        拿不到分辨率时返回 None（= 交给上层按分辨率自己算）。
        """
        if not megapixels or megapixels <= 0:
            return None
        return max_seconds_for(megapixels, self.instance_type)

    # ---- 生成模式 → 工作流路由（补齐模式所需工作流后自动开通）----
    @property
    def supports_last_frame(self) -> bool:
        """尾帧能力随工作流配置动态开合（fl2va/l2va 任一条接入即为 True）。

        写成 property 而非 __init__ 赋值，是为了"填了 env 重启即生效"，
        不必再改一次代码；registry.list_video() 每次读取都会拿到最新值。
        """
        return bool(self._workflow_for_mode("fl2va") or self._workflow_for_mode("l2va"))

    def _workflow_for_mode(self, mode: str) -> str:
        """返回该模式的工作流 id；空串=该模式尚无工作流（不可用）。"""
        s = get_settings()
        table = {
            "t2va": s.runninghub_h3_workflow_id,           # ref2v 工作流跑纯文本已实测可行
            "full_reference": s.runninghub_h3_workflow_id,  # 参考图/音频，当前主力
            "i2va": s.runninghub_h3_i2va_workflow_id,
            "fl2va": s.runninghub_h3_fl2va_workflow_id,
            "l2va": s.runninghub_h3_l2va_workflow_id,
        }
        return (table.get(mode) or "").strip()

    def mode_support(self) -> dict[str, dict]:
        """按工作流配置动态判定各模式可用性（供 UI 模式选择器置灰/提示）。

        同时上报**该模式的**参考图上限与是否支持参考音频——不同工作流差异很大
        （full_reference 9 图 + 音频；i2va 仅 1 图且无音频节点），上层若只看
        Provider 级 max_reference_images 会误判。
        """
        out: dict[str, dict] = {}
        for mode in ("t2va", "i2va", "fl2va", "l2va", "full_reference"):
            wf = self._workflow_for_mode(mode)
            nodes = MODE_NODES.get(mode)
            if wf and nodes is not None:
                out[mode] = {"available": True,
                             "max_reference_images": nodes.max_images,
                             "reference_audio": nodes.ref_audio is not None,
                             "requires_first_frame": nodes.first_frame is not None,
                             "requires_last_frame": nodes.last_frame is not None}
            else:
                env = {"i2va": "FW_RUNNINGHUB_H3_I2VA_WORKFLOW_ID",
                       "fl2va": "FW_RUNNINGHUB_H3_FL2VA_WORKFLOW_ID",
                       "l2va": "FW_RUNNINGHUB_H3_L2VA_WORKFLOW_ID"}.get(mode, "")
                out[mode] = {"available": False,
                             "reason": f"工作流未配置（{env} 留空），提供工作流 id 后自动开通"}
        # 参考视频：full_reference 内的子能力，受 #158 节点关闭限制
        out["full_reference"]["reference_video"] = self.supports_reference_video
        return out

    # ---- 配置 ----
    def _creds(self) -> tuple[str, str]:
        """只取 key/base（upload/status/outputs 等与工作流无关的调用用）。

        不要在这里校验 workflow id——否则"只配了 i2va 工作流"时连上传都会被拦。
        """
        s = get_settings()
        key = (s.runninghub_api_key or "").strip()
        if not key:
            raise RuntimeError("FW_RUNNINGHUB_API_KEY 未配置")
        return key, (s.runninghub_base_url or "https://www.runninghub.cn").rstrip("/")

    def _cfg(self, mode: str = "full_reference") -> tuple[str, str, str]:
        key, base = self._creds()
        wf = self._workflow_for_mode(mode)
        if not wf:
            raise RuntimeError(
                f"生成模式 {mode} 的工作流未配置，请提供对应 RunningHub 工作流 id")
        return key, base, wf

    @property
    def instance_type(self) -> str:
        """生效机型，**永不为空**（留空一律解析成 DEFAULT_INSTANCE_TYPE）。

        返回值可能是 "default" —— 那是"显式要 24G 机"，与"没指定"不同，
        见 create() 里对 payload 的处理。
        """
        if self._instance_type_override is not None:
            return resolve_instance_type(self._instance_type_override)
        return resolve_instance_type(get_settings().runninghub_instance_type)

    # ---- 素材上传 ----
    async def upload(self, local: Path | str, kind: str) -> str:
        """上传本地素材到 RunningHub，返回其 fileName（形如 api/xxx.png）。

        kind: image | audio | video —— 决定 fileType 与 MIME。
        local 可以是 Path 或字符串路径。
        """
        key, base = self._creds()
        local = Path(local)
        if not local.exists():
            raise RuntimeError(f"待上传素材不存在: {local}")
        ext = local.suffix.lower()
        table = {"image": _IMAGE_MIME, "audio": _AUDIO_MIME, "video": _VIDEO_MIME}[kind]
        mime = table.get(ext, "application/octet-stream")
        raw = local.read_bytes()
        async with httpx.AsyncClient(timeout=max(self.timeout, 300.0)) as c:
            r = await c.post(
                f"{base}/task/openapi/upload",
                data={"apiKey": key, "fileType": kind},
                files={"file": (local.name, raw, mime)},
            )
        if r.status_code != 200:
            raise RuntimeError(f"RH upload HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(f"RH upload error: {d.get('msg')}")
        fn = (d.get("data") or {}).get("fileName")
        if not fn:
            raise RuntimeError(f"RH upload 未返回 fileName: {str(d)[:200]}")
        return str(fn)

    async def _to_remote_name(self, url_or_path: str, kind: str) -> str:
        """把本地 /fw/media/... 地址或磁盘路径转成 RunningHub fileName。

        已是 RunningHub fileName（api/ 前缀）时直接复用，避免重复上传。
        """
        if url_or_path.startswith("api/"):
            return url_or_path
        if url_or_path.startswith(("http://", "https://")):
            local = await _fetch_external(url_or_path)
        else:
            local = _resolve_local(url_or_path)
        if local is None or not local.exists():
            raise RuntimeError(f"参考素材不可用: {url_or_path}")
        return await self.upload(local, kind)

    async def _image_slot(self, url: str, node: str) -> tuple[dict, tuple[int, int] | None]:
        """把一张图落到某个 LoadImage 槽，顺带返回其像素尺寸（用于画幅校验）。

        走这条路只下载/上传一次；已是平台 fileName（api/ 前缀）时拿不到本地文件，
        尺寸返回 None，跳过校验而不是报错（用户直接给平台文件名属于高级用法）。
        """
        local: Path | None = None
        if url.startswith("api/"):
            name = url
        else:
            local = (await _fetch_external(url) if url.startswith(("http://", "https://"))
                     else _resolve_local(url))
            if local is None or not local.exists():
                raise RuntimeError(f"参考素材不可用: {url}")
            name = await self.upload(local, "image")
        dims: tuple[int, int] | None = None
        if local is not None:
            try:
                from PIL import Image
                with Image.open(local) as im:
                    dims = im.size
            except Exception:  # noqa: BLE001 —— 校验是增值项，读不出尺寸不该阻断出片
                dims = None
        return {"nodeId": node, "fieldName": "image", "fieldValue": name}, dims


    async def _build_node_info(self, req: VideoRequest,
                               mode: str = "full_reference") -> tuple[list[dict], dict]:
        """把 VideoRequest 翻译成**该模式所用工作流**的节点覆盖列表 + 生效参数摘要。

        节点号与字段名随工作流而变（见 MODE_NODES），所以 mode 必须传进来——
        用错节点号会被平台以 NODE_INFO_MISMATCH 拒绝，用错字段名则更隐蔽：
        平台接受但节点值不变，等于**静默丢掉提示词**跑出一条无关的视频。
        """
        nd = MODE_NODES.get(mode)
        if nd is None:
            raise RuntimeError(f"生成模式 {mode} 尚无节点映射（工作流未接入）")
        seconds = (req.duration_ms / 1000.0) if req.duration_ms else 8.0
        if seconds <= 0:
            raise RuntimeError(f"时长非法: {seconds}s")
        aspect_key = req.aspect_ratio or "9:16"
        if aspect_key not in ASPECT_ENUM:
            raise RuntimeError(
                f"不支持的画面比例 {aspect_key}；合法值: {', '.join(ASPECT_ENUM)}")
        inst = self.instance_type
        mp = (req.megapixels if req.megapixels is not None
              else _auto_megapixels(seconds, inst))
        if not 0.1 <= mp <= 16:
            raise RuntimeError(f"megapixels 超出范围(0.1~16): {mp}")
        # 显存预算仅作**告警**，不拦截。
        # 拆镜阶段（script_import.max_narration_sec）已按用户选定的分辨率
        # 把每镜控制在包线内，正常路径不会走到这里。用户手动指定超预算参数
        # 时也应当尊重其选择并真的去跑——包线是统计出来的经验值，不是物理禁令，
        # 真跑不动自然会由 RunningHub 报 FAILED。我方不替平台下结论。
        budget = vram_budget(inst)
        if mp * seconds > budget:
            logger.warning(
                "超出 %s 机型实测显存预算：%sMP × %ss = %.1f MP·s > %.1f，"
                "该分辨率下实测最长 %.1fs；仍按用户参数提交",
                inst or "default", mp, seconds, mp * seconds, budget,
                max_seconds_for(mp, inst))
        if self._enforce_vram_budget and mp * seconds > budget:
            raise RuntimeError(
                f"超出 {inst or 'default'} 机型显存预算："
                f"{mp}MP × {seconds}s = {mp * seconds:.1f} MP·s > {budget:.1f}；"
                f"该分辨率下最长 {max_seconds_for(mp, inst):.1f}s，"
                f"或把时长 {seconds}s 的分辨率降到 "
                f"{budget / max(0.1, seconds):.2f}MP 以下")
        seed = _pick_seed(req.seed)

        # 净化：拆【】(会被当成"烧字幕") + 补无文字约束。见 base.sanitize_video_prompt。
        # 顺序要紧：必须在拼 I2VA_INSTRUCTION **之前**净化 —— 那行是首帧锚定指令，
        # 净化会把约束句追加到末尾，先拼再净化就会把约束塞到指令行后面的错位置。
        prompt = sanitize_video_prompt(req.prompt or "") or ""
        if mode == "i2va" and "is fully referenced" not in prompt:
            # 兜底补首帧指令行：缺了它模型把图当泛参考，第一帧会自己另起构图，
            # 首帧路线的防偏移前提就没了（见 I2VA_INSTRUCTION 注释）。
            prompt = f"{I2VA_INSTRUCTION}\n\n{prompt}".strip()

        nodes: list[dict] = [
            {"nodeId": nd.prompt, "fieldName": nd.prompt_field, "fieldValue": prompt},
            {"nodeId": nd.duration, "fieldName": "value", "fieldValue": seconds},
            {"nodeId": nd.seed, "fieldName": "noise_seed", "fieldValue": seed},
            {"nodeId": nd.resolution, "fieldName": "aspect_ratio",
             "fieldValue": ASPECT_ENUM[aspect_key]},
            {"nodeId": nd.resolution, "fieldName": "megapixels", "fieldValue": mp},
        ]

        w, h = resolution_for(aspect_key, mp)
        unused_refs = 0

        if nd.frame_slots:
            # 专用首/尾帧槽工作流（fl2va）：图不是"参考"，是画面本身的两个端点。
            frames: list[tuple[str, str | None, str | None]] = [
                ("首帧", nd.first_frame, req.first_frame_url),
                ("尾帧", nd.last_frame, req.last_frame_url),
            ]
            for label, slot, url in frames:
                if slot is None:
                    continue
                if not url:
                    raise RuntimeError(
                        f"生成模式 {mode} 必须提供{label}图"
                        f"（该工作流的{label}槽是必填输入，缺图会直接报错）")
                node, dims = await self._image_slot(url, slot)
                nodes.append(node)
                # #63/#71 用 aspect_ratio="original" 只缩不裁，画幅不一致不会被纠正，
                # 会带进 #332 与输出尺寸打架 → 拉伸/裁切。宁可提交前报错。
                if dims and abs(dims[0] / dims[1] - w / h) / (w / h) > 0.05:
                    raise RuntimeError(
                        f"{label}图画幅 {dims[0]}x{dims[1]} 与请求比例 {aspect_key}"
                        f"（输出 {w}x{h}）不符，该工作流不会自动裁切，会导致画面拉伸；"
                        f"请按 {aspect_key} 重新生成{label}图")
            # 该工作流没有通用参考图槽，多传的图物理上无处可放。此处丢弃但记进 meta，
            # 因为上层会按 Provider 能力自动注入资产图，硬报错会让本模式直接不可用。
            unused_refs = len(req.reference_image_urls or [])
        else:
            # 参考图：first_frame_url 视作第一张参考图；**只填实际用到的槽**，
            # 未用到的槽保持工作流内的空值（塞占位图会污染参考语义）。
            refs = list(req.reference_image_urls or [])
            if req.first_frame_url and req.first_frame_url not in refs:
                refs.insert(0, req.first_frame_url)
            if len(refs) > nd.max_images:
                # 上限是**每条工作流**的槽位数，不是 Provider 级的 9：
                # i2va 工作流只有 1 个槽，多传的图不会被使用，宁可报错也不静默丢弃。
                raise RuntimeError(
                    f"生成模式 {mode} 的工作流最多 {nd.max_images} 张参考图，"
                    f"收到 {len(refs)} 张")
            for slot, url in zip(nd.ref_images, refs):
                node, _ = await self._image_slot(url, slot)
                nodes.append(node)

        if req.reference_audio_url:
            if nd.ref_audio is None:
                raise RuntimeError(
                    f"生成模式 {mode} 的工作流无参考音频节点，不支持 reference_audio_url"
                    "（如需音色参考请用 full_reference 模式）")
            name = await self._to_remote_name(req.reference_audio_url, "audio")
            nodes.append({"nodeId": nd.ref_audio, "fieldName": "audio", "fieldValue": name})
        # 参考视频（#158）已在工作流中关闭：不再覆盖该节点，也无需占位视频兜底。
        # 上层若误传 reference_video_url，明确报错而不是静默忽略。
        if req.reference_video_url:
            raise RuntimeError(
                "当前 H3 工作流已关闭参考视频节点(#158)，不支持 reference_video_url")

        f = frames_for(seconds)
        meta = {
            "aspect_ratio": aspect_key, "megapixels": mp, "seed": seed,
            "requested_seconds": seconds,
            "expected_resolution": f"{w}x{h}",
            "expected_frames": f, "expected_seconds": round(f / 24, 3),
            "reference_images": sum(1 for n in nodes if n["fieldName"] == "image"),
            "reference_audio": bool(req.reference_audio_url),
            "instance_type": self.instance_type,
        }
        if unused_refs:
            # 可见地记下"被丢掉的图"，避免"我明明传了参考图却没生效"变成哑谜
            meta["unused_reference_images"] = unused_refs
        if nd.frame_slots:
            meta["first_frame"] = bool(req.first_frame_url)
            meta["last_frame"] = bool(req.last_frame_url)
        if mode == "i2va":
            meta["first_frame_instruction"] = prompt.startswith(I2VA_INSTRUCTION[:40])
        return nodes, meta

    # ---- 创建任务 ----
    async def create(self, req: VideoRequest) -> tuple[str, dict]:
        """提交任务，返回 (task_id, 生效参数摘要)。按生成模式路由工作流。"""
        from .base import infer_generation_mode
        mode = infer_generation_mode(req)
        support = self.mode_support().get(mode, {})
        if not support.get("available"):
            raise RuntimeError(
                f"生成模式 {mode} 当前不可用：{support.get('reason', '未知原因')}")
        key, base, wf = self._cfg(mode)
        nodes, meta = await self._build_node_info(req, mode)
        meta["generation_mode"] = mode
        meta["workflow_id"] = wf
        payload: dict = {"apiKey": key, "workflowId": wf, "nodeInfoList": nodes}
        # 注意：instanceType 传非法值时平台**静默忽略**降级到默认机，不会报错。
        # "default" 不是平台认的取值，它表示"就用默认那台 24G 机"，
        # 所以这一档**不带**该字段，而不是把 "default" 发过去碰运气。
        inst = self.instance_type
        if inst and inst != "default":
            payload["instanceType"] = inst
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(f"{base}/task/openapi/create", json=payload)
        if r.status_code != 200:
            raise RuntimeError(f"RH create HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(f"RH create error: {d.get('msg')} {str(d.get('data'))[:200]}")
        data = d.get("data") or {}
        tid = data.get("taskId") if isinstance(data, dict) else None
        if not tid:
            raise RuntimeError(f"RH create 未返回 taskId: {str(d)[:200]}")
        return str(tid), meta

    # ---- 状态 / 产出 ----
    async def status(self, task_id: str) -> str:
        key, base = self._creds()
        async with httpx.AsyncClient(timeout=self.timeout) as c:
            r = await c.post(f"{base}/task/openapi/status",
                             json={"apiKey": key, "taskId": task_id})
        if r.status_code != 200:
            raise RuntimeError(f"RH status HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(f"RH status error: {d.get('msg')}")
        return str(d.get("data") or "").upper()

    async def outputs(self, task_id: str) -> list[str]:
        key, base = self._creds()
        async with httpx.AsyncClient(timeout=max(self.timeout, 120.0)) as c:
            r = await c.post(f"{base}/task/openapi/outputs",
                             json={"apiKey": key, "taskId": task_id})
        if r.status_code != 200:
            raise RuntimeError(f"RH outputs HTTP {r.status_code}: {r.text[:200]}")
        d = r.json()
        if d.get("code") != 0:
            raise RuntimeError(f"RH outputs error: {d.get('msg')} {str(d.get('data'))[:200]}")
        data = d.get("data") or []
        urls: list[str] = []
        if isinstance(data, list):
            for it in data:
                if isinstance(it, dict):
                    u = it.get("fileUrl") or it.get("url")
                    if u:
                        urls.append(str(u))
                elif isinstance(it, str):
                    urls.append(it)
        if not urls:
            raise RuntimeError(f"RH outputs 无产出地址: {str(d)[:200]}")
        return urls

    async def failure_detail(self, task_id: str) -> str:
        """取平台侧真实失败原因（节点名 + 异常信息）。

        任务 FAILED 时 outputs 接口返回 code=805，data.failedReason 里带
        node_name / exception_type / exception_message / traceback。
        不读这个就只能猜"大概率显存不足"——实测 fl2va 首次失败其实是
        LoadImage 找不到刚上传的文件（见 §12），猜错方向会误导排查。
        取不到时返回空串，由调用方回落到通用提示。
        """
        try:
            key, base = self._creds()
            async with httpx.AsyncClient(timeout=self.timeout) as c:
                r = await c.post(f"{base}/task/openapi/outputs",
                                 json={"apiKey": key, "taskId": task_id})
            fr = ((r.json().get("data") or {}) or {}).get("failedReason") or {}
            node = fr.get("node_name") or ""
            msg = (fr.get("exception_message") or fr.get("exception_type") or "").strip()
            if not (node or msg):
                return ""
            return f"节点 {node}: {msg[:200]}" if node else msg[:200]
        except Exception:  # noqa: BLE001 —— 诊断信息拿不到不该盖掉原始失败
            return ""

    async def cancel(self, task_id: str) -> bool:
        """取消任务（超时/放弃时调用，避免白烧算力）。"""
        key, base = self._creds()
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as c:
                r = await c.post(f"{base}/task/openapi/cancel",
                                 json={"apiKey": key, "taskId": task_id})
            return r.status_code == 200 and r.json().get("code") == 0
        except Exception:  # noqa: BLE001
            return False

    # ---- 落盘 ----
    async def _download(self, url: str) -> str:
        """把产出视频拉回本地，返回 /fw/media/generated/... 形式的可访问地址。"""
        async with httpx.AsyncClient(timeout=600.0, follow_redirects=True) as c:
            r = await c.get(url)
        if r.status_code != 200:
            raise RuntimeError(f"下载产出失败 HTTP {r.status_code}")
        ext = ".mp4"
        for cand in (".mp4", ".webm", ".mov"):
            if cand in url.lower():
                ext = cand
                break
        name = f"h3_{uuid.uuid4().hex[:12]}{ext}"
        (GENERATED_DIR / name).write_bytes(r.content)
        return f"/fw/media/generated/{name}"

    # ---- VideoProvider 接口 ----
    async def submit(self, req: VideoRequest) -> VideoResult:
        """提交并轮询至出片（与 veo 通道行为一致，上层可无差别调用）。

        **只认 RunningHub 的结论**：轮询无限期进行，直到平台报 SUCCESS 或
        FAILED。我方不设时间上限、不主动 cancel —— 主动打断会把"排队慢"
        误记成"任务失败"，既丢了已经付费排队的算力，也污染判断依据。
        （poll_max 传正整数可恢复有限轮询，仅测试用。）
        """
        task_id, meta = await self.create(req)
        try:
            n = 0
            while self.poll_max is None or n < self.poll_max:
                n += 1
                await asyncio.sleep(self.poll_interval)
                st = await self.status(task_id)
                if st == "SUCCESS":
                    urls = await self.outputs(task_id)
                    local = await self._download(urls[0])
                    return VideoResult(
                        status="done", task_id=task_id, video_url=local,
                        duration_ms=int(meta["expected_seconds"] * 1000),
                        raw={"remote_url": urls[0], **meta},
                    )
                if st in {"FAILED", "ERROR", "CANCELED", "CANCELLED"}:
                    detail = await self.failure_detail(task_id)
                    if detail:
                        meta["failure_detail"] = detail
                    return VideoResult(
                        status="failed", task_id=task_id,
                        error=(f"RunningHub 任务 {st}：{detail}" if detail else
                               f"RunningHub 任务 {st}（大概率为显存不足："
                               f"{meta['expected_resolution']} × {meta['expected_seconds']}s，"
                               f"可降低 megapixels 或时长后重试）"),
                        raw=meta)
                if n % 30 == 0:      # 每 5 分钟记一次，便于观察长镜排队
                    logger.info("RH 任务 %s 仍在 %s，已等待 %.0f 分钟",
                                task_id, st, n * self.poll_interval / 60)
        except Exception as e:  # noqa: BLE001
            # 异常路径仍 cancel：这里是我方出错（网络/解析），任务留在平台上
            # 无人认领只会白烧钱。与"主动判超时"不同，这不是对结果下结论。
            await self.cancel(task_id)
            return VideoResult(status="failed", task_id=task_id,
                               error=f"{e!r}", raw=meta)
        await self.cancel(task_id)
        return VideoResult(
            status="failed", task_id=task_id,
            error=f"轮询达到显式上限 {self.poll_max} 次，已取消任务",
            raw=meta)

    async def poll(self, task_id: str) -> VideoResult:
        """查询既有任务；SUCCESS 时顺带落盘。"""
        st = await self.status(task_id)
        if st == "SUCCESS":
            urls = await self.outputs(task_id)
            local = await self._download(urls[0])
            return VideoResult(status="done", task_id=task_id, video_url=local,
                               raw={"remote_url": urls[0]})
        if st in {"FAILED", "ERROR", "CANCELED", "CANCELLED"}:
            detail = await self.failure_detail(task_id)
            return VideoResult(status="failed", task_id=task_id,
                               error=f"RunningHub 任务 {st}" + (f"：{detail}" if detail else ""))
        return VideoResult(status="running", task_id=task_id)

