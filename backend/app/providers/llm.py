"""LLM Provider：走 OpenAI 兼容网关的 /chat/completions，**三中转站互为兜底**。

用于剧本优化、镜头拆解等文本阶段。默认模型取 settings.llm_model
（gemini-3.6-flash，三个中转站均实测可用）。

## 为什么要多渠道（2026-08 血泪）

zx1 账号余额跑成负数后，**所有**文本调用一律 403 `insufficient_user_quota`，
剧本导入的镜头拆解 100% 失败。而 api4me 上同一批模型完全正常——
两个中转站承载的是同一批模型、能力等价，本就该互为备份，
却因为代码里只写死了一条 base_url 而白白全挂。

故本模块把"渠道"抽象出来，任一渠道欠费 / 无可用渠道 / 5xx / 网络故障
自动切到下一条，只有**全部**渠道都失败才向上抛错。

## 渠道顺序：zx1 → api4me → modelverse

modelverse(UCloud) 于 2026-09 加入（与主平台 drama 对齐），排最后是
**成本考量**：单价明显高于前两家，定位是"前两条都挂了才用"的终极兜底。
它单 key 覆盖全部模型，没有 api4me 那种分组之分。

## 两把 api4me key 不可混用

api4me 的两把 key 属于不同分组，实测：
- `gemini-*`  → 只有 `api4me_gemini_api_key`（优质gemini 分组）能用，主 key 报 503 无可用渠道
- 非 gemini（如 gpt-5.5）→ 只有 `api4me_api_key` 能用，gemini key 报 503

所以选哪把 key 必须**按模型名自动判定**（`_api4me_key`），写错等于这条渠道白配。

## 冷却而非降并发

某渠道判定不可用后冷却 `llm_channel_cooldown` 秒，期间直接跳过，
避免高并发下每个请求都去撞一次死渠道白等一个 RTT。
⚠️ 这是"跳过已知坏渠道"，**不改任何并发数**（遵并发铁律）。
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass

import httpx

from ..config import get_settings

logger = logging.getLogger("fw.llm")


@dataclass(frozen=True)
class Channel:
    """一个 OpenAI 兼容中转站。"""

    name: str
    base_url: str   # 已含 /v1，末尾无斜杠
    api_key: str


class ChannelDown(Exception):
    """该渠道当前不可用（欠费/鉴权/无渠道/5xx/网络），应当切换到下一条。"""

    def __init__(self, msg: str, account_level: bool = False) -> None:
        super().__init__(msg)
        #: True = 账号级故障（欠费/鉴权），该渠道所有模型都别试了；
        #: False = 模型级故障（无可用渠道/404），同渠道其它模型照常走。
        self.account_level = account_level


# ---- 渠道健康度：key -> 冷却截止时刻（time.monotonic）----
# 进程内内存态即可：重启自动清空，多 worker 各自独立探测，无需共享存储。
# key 两种粒度：
#   "zx1"                  账号级（余额/鉴权）——该渠道整体跳过
#   "zx1:grok-4.5"         模型级（该渠道没上架这个模型）——只跳过这一个模型
_COOLDOWN: dict[str, float] = {}


def _mark_down(name: str, model: str, seconds: int, exc: ChannelDown) -> None:
    key = name if exc.account_level else f"{name}:{model}"
    _COOLDOWN[key] = time.monotonic() + seconds
    logger.warning("文本渠道 %s 判定不可用（%s），冷却 %ds：%s", key,
                   "账号级" if exc.account_level else "模型级", seconds, exc)


def _healthy(name: str, model: str) -> bool:
    now = time.monotonic()
    for key in (name, f"{name}:{model}"):
        until = _COOLDOWN.get(key)
        if until is None:
            continue
        if now >= until:
            _COOLDOWN.pop(key, None)   # 冷却到期，重新纳入探测
        else:
            return False
    return True


def _api4me_key(model: str, s) -> str:
    """api4me 两把 key 分组不同：gemini 系走 gemini key，其余走主 key。"""
    if "gemini" in (model or "").lower():
        return s.api4me_gemini_api_key or ""
    return s.api4me_api_key or ""


def build_channels(model: str, settings=None) -> list[Channel]:
    """按配置顺序构造该模型的可用渠道列表（key/base 缺失的渠道自动剔除）。"""
    s = settings or get_settings()
    catalog: dict[str, Channel] = {}
    if s.llm_base_url and s.llm_api_key:
        catalog["zx1"] = Channel("zx1", s.llm_base_url.rstrip("/"), s.llm_api_key)
    a4m_key = _api4me_key(model, s)
    if s.api4me_base_url and a4m_key:
        catalog["api4me"] = Channel(
            "api4me", s.api4me_base_url.rstrip("/") + "/v1", a4m_key)
    # modelverse：单 key 覆盖全部模型，无 api4me 那种分组区分。
    # 默认排最后（见 config.llm_channel_order）——单价高，只当终极兜底。
    if s.modelverse_v1_base and s.modelverse_api_key:
        catalog["modelverse"] = Channel(
            "modelverse", s.modelverse_v1_base, s.modelverse_api_key)

    order = [x.strip() for x in (s.llm_channel_order or "").split(",") if x.strip()]
    chans = [catalog[n] for n in order if n in catalog]
    # 配置顺序里没列到的渠道也追加进来，避免新增渠道忘了改 order 就静默失效
    chans += [c for n, c in catalog.items() if n not in order]
    return chans


def _order_by_health(chans: list[Channel], model: str) -> list[Channel]:
    """健康的排前面；全在冷却中则保持原序（宁可撞一次也不能无渠道可用）。"""
    healthy = [c for c in chans if _healthy(c.name, model)]
    return healthy + [c for c in chans if c not in healthy] if healthy else chans


class LLMProvider:
    def __init__(self, model_id: str | None = None) -> None:
        self.settings = get_settings()
        self.model_id = model_id or self.settings.llm_model
        self.last_channel: str | None = None   # 实际出结果的渠道，便于排查/记 meta

    async def complete(self, system: str, user: str, temperature: float = 0.7,
                       allow_truncated: bool = False) -> str:
        """对话补全，跨渠道兜底。

        max_tokens 策略：协议上不存在"无限"取值，省略=网关默认（可能偏小）。
        故 FW_LLM_MAX_TOKENS>0 时显式带上，把输出上限顶到配置值（应设为
        模型输出硬上限附近）；=0 保持省略。
        截断检测：finish_reason=="length" 说明输出被拦腰截断（半截 JSON 的根因），
        默认直接报错让上层走分块/重试。**截断不是渠道故障，不触发换渠道**——
        换一条也是同样结果，白花一次钱。
        """
        payload: dict = {
            "model": self.model_id,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
        }
        if self.settings.llm_max_tokens > 0:
            payload["max_tokens"] = self.settings.llm_max_tokens

        chans = build_channels(self.model_id, self.settings)
        if not chans:
            raise RuntimeError(
                f"模型 {self.model_id} 没有任何可用文本渠道：请检查 FW_GATEWAY_API_KEY "
                f"与 FW_API4ME_API_KEY / FW_API4ME_GEMINI_API_KEY 是否配置"
                f"（gemini 系模型必须配 gemini 分组那把）。")

        errors: list[str] = []
        async with httpx.AsyncClient(timeout=self.settings.request_timeout) as client:
            for ch in _order_by_health(chans, self.model_id):
                try:
                    content = await self._call(client, ch, payload, allow_truncated)
                    self.last_channel = ch.name
                    if errors:   # 前面有渠道失败过，记一笔便于事后追因
                        logger.info("文本渠道已切换到 %s（前序失败：%s）",
                                    ch.name, "；".join(errors))
                    return content
                except ChannelDown as e:
                    _mark_down(ch.name, self.model_id,
                               self.settings.llm_channel_cooldown, e)
                    errors.append(f"{ch.name} → {e}")
                    continue

        raise RuntimeError(
            f"全部 {len(chans)} 个文本渠道均不可用（模型 {self.model_id}）：{'；'.join(errors)}。"
            f"请检查各渠道余额/配额；若为限流，建议增加 API KEY 或提升配额，而非降并发。")

    async def _call(self, client: httpx.AsyncClient, ch: Channel,
                    payload: dict, allow_truncated: bool) -> str:
        """在单条渠道上完成一次调用。渠道级故障抛 ChannelDown，内容级问题照常抛。"""
        url = f"{ch.base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {ch.api_key}",
            "Content-Type": "application/json",
        }
        # 针对瞬时 429 限流做轻量指数退避重试（非降并发，仅容忍网关瞬时限流）；
        # 退避后仍 429 则判定该渠道当前不可用，换另一条——等于把压力分散到两个渠道。
        for attempt in range(3):
            try:
                resp = await client.post(url, headers=headers, json=payload)
            except (httpx.TimeoutException, httpx.TransportError) as e:
                raise ChannelDown(f"网络异常 {type(e).__name__}: {e}") from e

            if resp.status_code == 429:
                if attempt < 2:
                    await asyncio.sleep(2 ** attempt)   # 1s, 2s
                    continue
                raise ChannelDown("持续 429 限流（本渠道重试 3 次）")

            if resp.status_code >= 400:
                # 401/402/403 = 账号级（余额/鉴权）→ 整条渠道拉黑；
                # 其余（503 无可用渠道 / 404 无此模型 / 5xx）= 模型级，同渠道别的模型照常。
                raise ChannelDown(f"HTTP {resp.status_code}: {_err_text(resp)}",
                                  account_level=resp.status_code in (401, 402, 403))

            try:
                data = resp.json()
                choice = data["choices"][0]
                content = choice["message"]["content"]
            except Exception as e:
                # 200 但结构不对 = 该渠道返回异常，换一条比原地失败更有机会成功
                raise ChannelDown(f"响应结构异常: {type(e).__name__} {str(e)[:120]}") from e

            if choice.get("finish_reason") == "length" and not allow_truncated:
                raise RuntimeError(
                    f"LLM 输出被截断(finish_reason=length, 已输出{len(content or '')}字符)。"
                    "输入过长导致输出超上限，请缩短单次输入（拆解链路会自动分块）。"
                )
            return content

        raise ChannelDown("重试耗尽")   # 理论不可达，兜底防御

    async def complete_vision(self, system: str, user: str, image_url: str,
                              temperature: float = 0.2) -> str:
        """多模态对话补全（文本+图片），跨渠道兜底。

        默认模型 gpt-5.6-terra（视觉任务专用，不走 settings.llm_model）。
        image_url 支持三种格式：
          1) data:image/png;base64,...  直接传 base64
          2) /fw/media/uploads/x.png    本地路径，自动转 data URI（**文件必须存在**，
                                       读不到直接抛，理由见下方）
          3) http(s)://...              外链，原样下发（网关自行拉取）
        """
        # 视觉模型固定 gpt-5.6-terra，不受 self.model_id 影响
        vision_model = "gpt-5.6-terra"

        # 本地路径 → data URI
        if image_url.startswith("/fw/media/") or image_url.startswith("/media/"):
            from ..media import _resolve_local
            p = _resolve_local(image_url)
            # 解析不到或文件不在，必须**当场报错**，不能把这个相对路径原样下发。
            # 它对网关是一个取不到的地址，实测两种结局都很坏：
            #   ① 逐渠道超时重试，一次调用拖到几分钟才失败；
            #   ② 更糟——模型直接照着系统提示词**编**一段造型描述回来，
            #      调用方拿到的是一段"看上去很像"的假描述并落库，
            #      正是我们在修的"参考图与文字不一致→人物外观漂移"。
            # 图读不到时唯一正确的行为是失败，不是猜。
            if not (p and p.is_file()):
                raise RuntimeError(f"图片不存在或无法读取：{image_url}")
            import base64
            with open(p, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            ext = p.suffix.lower().lstrip(".")
            mime = f"image/{ext if ext in ('png','jpeg','jpg','webp') else 'png'}"
            image_url = f"data:{mime};base64,{b64}"

        payload: dict = {
            "model": vision_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": [
                    {"type": "text", "text": user},
                    {"type": "image_url", "image_url": {"url": image_url}},
                ]},
            ],
            "temperature": temperature,
        }
        if self.settings.llm_max_tokens > 0:
            payload["max_tokens"] = self.settings.llm_max_tokens

        chans = build_channels(vision_model, self.settings)
        if not chans:
            raise RuntimeError(
                f"视觉模型 {vision_model} 没有任何可用文本渠道：请检查 "
                "FW_GATEWAY_API_KEY / FW_API4ME_API_KEY 配置。")

        errors: list[str] = []
        async with httpx.AsyncClient(timeout=self.settings.request_timeout) as client:
            for ch in _order_by_health(chans, vision_model):
                try:
                    content = await self._call(client, ch, payload, allow_truncated=False)
                    self.last_channel = ch.name
                    if errors:
                        logger.info("视觉渠道已切换到 %s（前序失败：%s）",
                                    ch.name, "；".join(errors))
                    return content
                except ChannelDown as e:
                    _mark_down(ch.name, vision_model,
                               self.settings.llm_channel_cooldown, e)
                    errors.append(f"{ch.name} → {e}")
                    continue

        raise RuntimeError(
            f"全部 {len(chans)} 个视觉渠道均不可用（模型 {vision_model}）：{'；'.join(errors)}。")


def _err_text(resp: httpx.Response) -> str:
    """把网关错误体压成一行可读信息（优先取 error.message）。"""
    try:
        body = resp.json()
        msg = (body.get("error") or {}).get("message") or body.get("message")
        if msg:
            return str(msg)[:200]
    except Exception:
        pass
    return (resp.text or "")[:200].replace("\n", " ")


async def channel_health(model: str | None = None) -> list[dict]:
    """逐渠道实测可用性（供运维/排查用，不写任何状态）。"""
    s = get_settings()
    m = model or s.llm_model
    out: list[dict] = []
    async with httpx.AsyncClient(timeout=60) as client:
        for ch in build_channels(m, s):
            item = {"channel": ch.name, "base_url": ch.base_url,
                    "cooling_down": not _healthy(ch.name, m)}
            try:
                r = await client.post(
                    f"{ch.base_url}/chat/completions",
                    headers={"Authorization": f"Bearer {ch.api_key}"},
                    json={"model": m, "messages": [{"role": "user", "content": "ping"}],
                          "max_tokens": 4})
                item["status"] = r.status_code
                item["ok"] = r.status_code < 400
                if r.status_code >= 400:
                    item["error"] = _err_text(r)
            except Exception as e:
                item["ok"] = False
                item["error"] = f"{type(e).__name__}: {e}"
            out.append(item)
    return out
