"""Provider 抽象层。新增模型 = 新增一个 Provider 子类 + 注册，不改上层（开闭原则）。"""
from __future__ import annotations

import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from enum import Enum
from typing import Optional


class VisualMode(str, Enum):
    reference = "reference"      # 全能参考
    first_frame = "first_frame"  # 首帧图


class AudioMode(str, Enum):
    inline = "inline"            # 音画一体
    tts_separate = "tts_separate"  # 独立 TTS


#: 生成模式（对齐海螺官方文档五形态）。模式决定：提示词框架分支 + 工作流路由。
GENERATION_MODES: dict[str, str] = {
    "t2va": "纯文本生成（无参考素材）",
    "i2va": "首帧生成（参考图=视频第一帧，向后发展）",
    "fl2va": "首尾帧生成（两图锚定开头结尾，中间插值）",
    "l2va": "尾帧生成（参考图=最后一帧，倒推收敛）",
    "full_reference": "全参考生成（参考图/参考音频/参考视频作身份与风格参考）",
}


def to_public_url(url: str | None) -> str | None:
    """把库里的相对媒体地址补成公网绝对地址（供远端 API 拉取）。

    远端视频服务（火山方舟 / zx1 chat 通道）是把 URL 字符串塞进请求 JSON 后
    **由远端自己去拉**，相对路径 /fw/media/... 到了对端就是死链——这正是首帧图
    与上传型参考图偶发失效的根因（现网多数资产图是 OSS 绝对地址，故非必现）。

    ⚠️ 库里的前缀恒为 `/fw`（media.py 写死，与环境无关），**必须剥掉再按当前
    环境重拼**：prod 进程若原样拼成 …:9080/fw/media/…，那条 nginx 路由指向
    dev 后端 8002，而文件在 prod 数据目录 → 远端拉取 404。2026-09-02 现网
    事故（VolcAsset DownloadFailed / image_url resource not found）即此。

    仅在 Provider 提交前调用，不改写入库的值（DB 存相对地址，换域名不失效）。
    RunningHub 通道无需本函数：它走 upload 换 fileName（_to_remote_name）。
    """
    if not url:
        return url
    if url.startswith(("http://", "https://", "data:", "asset://")):
        return url
    from ..config import get_settings
    base = get_settings().media_base
    if not base:
        return url  # 未配置公网前缀：维持原样，交由渠道自行处理
    # /fw/media/x → /media/x；base 自带环境前缀，不剥就会拼成 /fwp/fw/media/x
    path = url[3:] if url.startswith("/fw/") else url
    return f"{base}/{path.lstrip('/')}"


#: Seedance 官方符号语义（references/seedance-2-troubleshooting-guide.txt「字符使用规范」）：
#:   （）=背景音乐   <>=音效   {}=台词   **【】=字幕（在画面上烧字）**
#: 而我们的原稿把**表演提示与台词**写进了【】（如【声音低沉无情】
#: 【不可能……你怎么可能查得出来？！】），等于逐镜明确要求模型烧字幕。
#: 2026-09-02 抽样 dev 库最近 120 条 gen_prompt，20 条命中——这是现网"画面出字幕"
#: 的直接原因（官方文档另称竖屏本身出字幕概率 60-90%，不加约束根本压不住）。
_SUBTITLE_BRACKETS = re.compile(r"【\s*([^】]{0,300}?)\s*】")

#: 拆【】时是否需要补分隔符。原稿常见 `【声音低沉无情】【不可能……】` 这种连排，
#: 直接摘掉括号会黏成 `声音低沉无情不可能……` 这样的病句，反而干扰模型理解。
#: 左侧含「】」= 上一个括号刚补过分隔符，不重复补；右侧**不含**「【」= 后面紧跟
#: 另一个括号时要补，由前一个负责补这一刀。
_SEP_LEFT_OK = set("。，、；：！？…—~,.;:!?（(《「『【】\n\t 　“‘\"'")
_SEP_RIGHT_OK = set("。，、；：！？…—~,.;:!?）)》」』\n\t 　”’\"'")


def _unwrap_subtitle(m: "re.Match[str]") -> str:
    inner = m.group(1)
    if not inner:
        return ""
    s, start, end = m.string, m.start(), m.end()
    prev = s[start - 1] if start else ""
    nxt = s[end] if end < len(s) else ""
    lead = "，" if prev and prev not in _SEP_LEFT_OK else ""
    tail = "，" if nxt and nxt not in _SEP_RIGHT_OK else ""
    return f"{lead}{inner}{tail}"

#: 出画面文字的兜底否定约束。官方 V-2/V-3 条目实测：显式写禁令可把出字幕概率
#: 从 60-90% 压到 10-40%，且能有效抑制平台 logo/水印。
#: 中英两版：海螺 H3 框架产出的提示词**通篇英文**，往英文正文尾巴上挂一句中文
#: 约束，模型权重给得明显更低（且它自己的 SKILL 还要求"画面可见文字原文保留"）。
_NO_ONSCREEN_TEXT = "无字幕，无文字，无水印，无logo"
_NO_ONSCREEN_TEXT_EN = ("No subtitles, no captions, no on-screen text, "
                        "no watermark, no logo")
_HAS_NO_TEXT = re.compile(
    r"无字幕|不要字幕|避免.{0,4}字幕|保持无字幕|no subtitle|without subtitle|"
    r"no caption|no on-screen text|no onscreen text|no burned-in text",
    re.I)

#: 判定正文语种：CJK 字符占比低即视作英文稿。阈值 15% 而非 0，是因为英文稿里
#: 常合法嵌中文台词（H3 规范 `<d>[Chinese] …</d>`），那种仍应挂英文约束。
_CJK = re.compile(r"[一-鿿]")


def _is_mostly_english(text: str) -> bool:
    letters = sum(c.isalpha() for c in text)
    if not letters:
        return False
    return len(_CJK.findall(text)) / letters < 0.15



def sanitize_video_prompt(prompt: str | None) -> str | None:
    """下发前净化视频提示词：拆掉会被当成"烧字幕"的写法 + 补否定约束。

    这是**确定性兜底**，与提示词优化器的框架规则互补：
    - 优化器是 LLM，不保证每次听话；无框架的通道（veo 直通）压根不过优化器
    - 用户手改的提示词也不过优化器
    故最终出网这一层必须自己再兜一次。

    只做两件不会损失语义的事：
    1. `【x】` → `x`（去掉字幕语义，内容原样保留为普通描述，必要时补「，」分隔）。
       不改写成（）或{}：那两个符号在同一张表里分别是**音乐**和**台词**，
       猜错语义比留成普通描述更糟。台词该怎么写由优化器框架负责规范。
    2. 末尾补无文字约束（已有等价约束则不重复补）。中文稿补中文、英文稿补英文
       —— 海螺 H3 的产出通篇英文，挂中文约束权重明显更低。

    幂等：重复调用结果不变。
    """
    if not prompt or not prompt.strip():
        return prompt
    out = _SUBTITLE_BRACKETS.sub(_unwrap_subtitle, prompt)
    out = re.sub(r"，{2,}", "，", out).strip().strip("，")
    if not _HAS_NO_TEXT.search(out):
        if _is_mostly_english(out):
            sep = "" if out.endswith((".", ",", ";", "\n")) else "."
            out = f"{out}{sep} {_NO_ONSCREEN_TEXT_EN}."
        else:
            sep = "" if out.endswith(("。", "，", ".", ",", ";", "；")) else "。"
            out = f"{out}{sep}{_NO_ONSCREEN_TEXT}。"
    return out


def infer_generation_mode(req: "VideoRequest") -> str:
    """未显式指定模式时按素材推断（显式 generation_mode 优先）。

    ⚠️ **参考音频不参与推断**。它现在是自动注入的（角色音色，见
    jobs._auto_inject_voice_ref）：若让它参与，一个纯文本镜头只因为主角有音色
    就会从 t2va 变成 full_reference，等于注入音色这个动作**顺手改了生成模式**，
    连带换掉提示词框架分支与工作流路由。音色只能改音色。
    """
    if req.generation_mode:
        return req.generation_mode
    if req.first_frame_url and req.last_frame_url:
        return "fl2va"
    if req.first_frame_url:
        return "i2va"
    if req.last_frame_url:
        return "l2va"
    if req.reference_image_urls or req.reference_video_url:
        return "full_reference"
    return "t2va"


@dataclass
class VideoRequest:
    prompt: str
    #: 生成模式（GENERATION_MODES 之一）；None=按素材自动推断
    generation_mode: Optional[str] = None
    first_frame_url: Optional[str] = None      # i2va / fl2va
    last_frame_url: Optional[str] = None       # fl2va / l2va
    reference_image_urls: list[str] = field(default_factory=list)  # full_reference
    reference_audio_url: Optional[str] = None
    reference_video_url: Optional[str] = None  # 参考视频（工作流支持时）
    duration_ms: Optional[int] = None
    aspect_ratio: Optional[str] = None
    #: 画面精细度（百万像素）。仅 reference 路线的可调分辨率模型使用；
    #: None 表示由 Provider 按时长自动选安全值（防显存 OOM）。
    megapixels: Optional[float] = None
    #: 随机种子。None = Provider 自行随机化（务必随机，否则同 prompt 永远同一结果）。
    seed: Optional[int] = None


@dataclass
class VideoResult:
    status: str                 # submitted | running | done | failed
    task_id: Optional[str] = None
    video_url: Optional[str] = None
    last_frame_url: Optional[str] = None   # 尾帧（承接接力用，模型支持时）
    duration_ms: Optional[int] = None
    error: Optional[str] = None
    raw: Optional[dict] = None


class VideoProvider(ABC):
    """视频生成 Provider 接口。"""

    #: 网关/厂商的模型 id
    model_id: str
    #: 该模型的能力档位（拿到 key 实测后回填到具体子类）
    visual_mode: VisualMode
    audio_mode: AudioMode
    duration_slots: list[int] = []
    supports_last_frame: bool = False
    aspect_ratios: list[str] = []
    #: 最多可吃几张参考图（首帧路线通常为 1）
    max_reference_images: int = 1
    #: 是否支持参考音频 / 参考视频
    supports_reference_audio: bool = False
    #: 最多可吃几段参考音频（仅 supports_reference_audio 为真时有意义）
    max_reference_audios: int = 1
    supports_reference_video: bool = False

    def max_seconds(self, megapixels: float | None = None) -> float | None:
        """单镜可生成的最长时长（秒）。None = 未知/不限。

        解说剧按旁白时长驱动镜头时长，拆镜时必须知道"这个模型最长能出多久"，
        否则会切出模型根本吃不下的段：seedance 会静默钳到 15s、veo 只出 8s，
        而旁白音频仍是完整长度 —— 画面早停、声音还在响，且**不报错**。

        缺省实现取 duration_slots 的最大值。时长上限依赖分辨率的模型
        （如 RunningHub H3，受显存 MP·s 约束）应当覆盖此方法。
        """
        return float(max(self.duration_slots)) if self.duration_slots else None

    def mode_support(self) -> dict[str, dict]:
        """各生成模式的可用性：{mode: {available, reason?}}。

        默认实现按 visual_mode 推导保守值；能力更细的 Provider（如按工作流
        配置动态判定的 H3）应覆写本方法。
        """
        first_frame_ok = self.visual_mode == VisualMode.first_frame
        return {
            "t2va": {"available": True},
            "i2va": {"available": first_frame_ok,
                     "reason": None if first_frame_ok else "该通道不支持首帧输入"},
            "fl2va": {"available": False, "reason": "该通道不支持首尾帧锚定"},
            "l2va": {"available": False, "reason": "该通道不支持尾帧锚定"},
            "full_reference": {
                "available": self.visual_mode == VisualMode.reference,
                "reason": None if self.visual_mode == VisualMode.reference
                else "该通道不支持多参考素材"},
        }

    @abstractmethod
    async def submit(self, req: VideoRequest) -> VideoResult:
        """提交生成任务。"""

    @abstractmethod
    async def poll(self, task_id: str) -> VideoResult:
        """轮询任务状态。"""