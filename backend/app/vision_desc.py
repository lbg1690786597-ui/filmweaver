"""视觉反推造型描述——把"用户直接上传的一张无描述参考图"变成可用的文字锚点。

## 为什么需要

提示词与资产图对齐依赖 `AssetStage.description` / `Asset.prompt` 这段**文字**：
出片时 `jobs._auto_inject_refs_detailed` 把它作为 ref_notes 喂给提示词优化器，
优化器才知道"图片 1 里的林晨穿的是米色风衣"，从而不会自己编一件别的衣服。

但用户完全可以**跳过生图直接上传一张图**（资产页的上传入口、换图入口都不要求填
描述）。此时 description 为空 → 优化器没有任何服装信息。本模块用多模态模型把图
**反推**成一段造型描述，补上这段缺失的文字。

## ⚠️ 2026-09-10：本模块不再挂在上传/换图链路上

原先 `patch_stage` / `patch_asset` / `upsert_asset_image` / `create_asset` 换图时
都会自动 `await` 一次反推。后果（用户实测反馈）：

- **上传变成几十秒**：一次多模态调用实测均 8.2s，还要把刚落盘的图整份读成
  base64 上行（体积 ×1.33），渠道不健康时还要逐渠道 fallback；
- **整页锁死**：资产弹窗在上传期间不许关闭（防 `<input>` 卸载丢上传），
  于是这几十秒里全屏遮罩关不掉，用户什么都干不了。

现在只有两个调用点，都不在交互关键路径上：
- `routes_v2.describe_image`（弹窗里的「🔍 AI 看图补写」按钮，用户显式点才跑，
  结果回给输入框、经用户过目才落库）；
- `scene_desc._describe_from_existing_images`（批量补齐老项目场景描述的后台 job）。

**"用户上传了自己的图"的正确处理不是反推，而是把旧描述清空**——
描述为空时 `jobs.py` 的 `blind` 分支会禁止提示词书写该图的服装/陈设，
外观完全交给参考图钳制，这比任何猜出来的文字都可靠。见 `routes_v2._CLEAR_DESC_WHY`。

## 模型选型（2026-08 实测，3 张真实定妆图 × 9 个候选）

选定 `gpt-5.6-terra`：3/3 成功、平均 8.2s，输出最凝练（62~166 字）且材质词最准
（缎面/暗纹/水滴坠）。对比：gemini-3.5-flash 更快但把米色风衣说成卡其色；
gemini-3.6-flash 准确但啰嗦；grok-4.6 把香槟色睡裙说成粉色且 31s；
doubao-seed-2-1-pro 准确但单次最长 110s；两个 doubao vision 型号当前 key 无权限。

## 字数是软约束

提示词里写"建议不超过 80 字"，**绝不在代码里做 `[:N]` 硬切**——硬切会从中间
斩断句子，把"脚穿黑色系带皮鞋"这类关键锚点截没，比长一点危害大得多。
"""
from __future__ import annotations

import logging

logger = logging.getLogger("fw.vision")

#: **历史标记**。自动反推的描述曾统一带这个前缀，用来在换图时区分
#: "AI 看图写的（可覆盖）"与"用户手写的（不许动）"。
#:
#: 2026-09-10 起**新写入的描述不再带它**：唯一的反推入口是弹窗里的手动按钮，
#: 结果先回给输入框、由用户过目修改后才落库——那就是用户的字了，不该再标成机器写的。
#: 前缀只保留在**读路径**（`strip_auto`，以及前端 AssetDialog 的同名常量）上，
#: 用于兼容库里已有的历史数据。
AUTO_PREFIX = "〔自动识图〕"

_SYS = (
    "你是影视剧组的造型记录员。看图，用一段中文写清画面中人物的**造型**：\n"
    "1) 只写服装（外套/上衣/下装/鞋）、发型、妆容、配饰，每件都要有颜色+款式"
    "（有明显材质就写材质）；\n"
    "2) 严禁描述背景、场景、光线、动作、表情、情绪、构图、画质，也不要猜品牌与价格；\n"
    "3) 图里看不清或没出现的部位（如被裁掉的鞋）就不写，不要编；\n"
    "4) 输出一段中文，建议控制在 80 字以内、尽量凝练；但**宁可略微超出也不要漏掉"
    "任何一件已看清的服饰**，不要为了字数砍掉鞋子或配饰；\n"
    "5) 不要分点、不要 markdown、不要前后缀说明，直接给描述正文。"
)

_SYS_LOCATION = (
    "你是影视剧组的置景记录员。看图，用一段中文写清画面中的**场景**：\n"
    "1) 只写空间类型、主要陈设与家具、材质与配色、时段光线氛围；\n"
    "2) 不要描述人物、动作、情绪、镜头运动、画质；\n"
    "3) 图里没有的东西不要编；\n"
    "4) 输出一段中文，建议控制在 80 字以内、尽量凝练；但宁可略微超出也不要漏掉"
    "关键陈设；\n"
    "5) 不要分点、不要 markdown、不要前后缀说明，直接给描述正文。"
)

_USER = "请写出这张定妆图的造型描述。"
_USER_LOCATION = "请写出这张场景参考图的场景描述。"


def strip_auto(text: str | None) -> str:
    """去掉自动标记前缀，取正文（喂给提示词优化器时用，别把标记也喂进去）。"""
    t = (text or "").strip()
    return t[len(AUTO_PREFIX):].strip() if t.startswith(AUTO_PREFIX) else t


async def derive(image_url: str, *, kind: str = "character") -> str | None:
    """看图写造型/场景描述。返回带 AUTO_PREFIX 的一段中文；失败返回 None。

    失败一律吞掉并记 warning：这是**批量补齐**场景（`scene_desc` 给老项目回填）
    的默认语义，一张图看不了不该让整个 job 挂掉。

    ⚠️ 手动按钮那条路径（`routes_v2.describe_image`）**不能**沿用这个语义：
    用户显式点了按钮，静默返回空等于按钮坏了，那边把 None 翻成 502 报出来。
    """
    if not (image_url or "").strip():
        return None
    from .providers.llm import LLMProvider
    try:
        llm = LLMProvider()
        raw = await llm.complete_vision(
            _SYS_LOCATION if kind == "location" else _SYS,
            _USER_LOCATION if kind == "location" else _USER,
            image_url)
    except Exception as e:  # noqa: BLE001
        logger.warning("视觉反推失败（%s）：%s", image_url[:80], e)
        return None
    text = (raw or "").strip()
    if not text:
        logger.warning("视觉反推返回空文本：%s", image_url[:80])
        return None
    return AUTO_PREFIX + text
