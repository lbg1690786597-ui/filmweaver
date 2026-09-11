"""资产图**视觉体检**——把"人物图里没有场景 / 场景图里没有人"从祈祷变成可验证。

## 为什么需要它

用户 2026-09-09 明确要求：「要确保人物资产图中没有场景，确保场景资产图中没有人物」。

提示词层面能做的已经做了（`asset_prompt._CLEAN_BG` / `_SCENE_REQUIREMENTS`
逐类点名禁止）。但提示词是**概率约束**，不是保证：生图模型对否定词的遵循度
本来就不稳，而且这两条约束恰好和别的要求有张力——
「完整露出鞋靴」推着模型画地面，「呈现空间的材质与年代感」推着模型加生活痕迹。

所以必须有一道**事后核验**：图出来了，真的看一眼合不合规。不核验的话，
"确保"这个词就没有落点——出问题要等用户在成片里看见才发现，那时已经花了
整条链路的钱。

## 为什么用多模态模型而不是 CV

判"这张图里有没有人"用人脸检测确实更便宜，但要判的其实是四件事：
① 有没有人/人体局部/人像替代物　② 有没有场景元素　③ 是不是三视图
④ 左上角有没有名称标注、有没有多余文字。
②③④ 没有现成检测器，写规则更不靠谱。而 `vision_desc` 已经在用
`gpt-5.6-terra` 做"看图写造型"（实测 3/3 成功、平均 8.2s），
同一条通道多问四个是非题是最省的做法。

## 体检不阻断出片

`check_*` 失败或超时一律返回 None，判定不合格也**只标记不删图**：
- 判定本身会出错（模型也会看错），自动删图等于让一个不可靠的判断销毁用户资产；
- 用户可能就想要那张图（比如故意保留一点地面）。
所以结论落在 `qc_json` / 返回值里，由用户决定重画哪张。这与
`vision_desc.derive` 的"失败吞掉记 warning"是同一条原则。
"""
from __future__ import annotations

import json
import logging

log = logging.getLogger(__name__)

#: 体检项 → 人读的说明。前端直接展示这里的文案，不自己拼句子。
ISSUE_LABELS = {
    "has_person": "场景图里出现了人物或人像替代物",
    "has_scene": "人物图里出现了场景元素（地面/家具/门窗/环境）",
    "not_three_view": "不是正面+侧面+背面三视图",
    "no_name_label": "左上角缺少名称标注",
    # 角色图用 extra_text（纯白背景上任何多余字都是缺陷）；
    # 场景图用 overlay_text（招牌车牌是空间的一部分，见 check_scene 的说明）
    "extra_text": "画面里有多余文字/水印（除左上角标注外）",
    "overlay_text": "画面上叠加了水印/字幕/台标/分镜框编号",
    "bg_not_white": "背景不是纯白干净背景",
}

_SYS_CHAR = (
    "你是影视剧组的资产质检员。看这张**角色定妆图**，只回答事实，不做评价。\n"
    "\n"
    "严格按 JSON 输出，不要 markdown 代码块、不要任何解释：\n"
    '{"three_view": true/false, "person_count": 数字, "has_scene": true/false,\n'
    ' "bg_white": true/false, "name_label_topleft": true/false,\n'
    ' "extra_text": true/false, "note": "一句话说明看到的问题"}\n'
    "\n"
    "判定口径（很重要，按这个来）：\n"
    "1. three_view：画面里是否**并排呈现同一个人的正面、侧面、背面三个全身站姿**。"
    "只有一个人站姿 = false。\n"
    "2. person_count：画面里出现了几个**人物形象**。三视图是同一个人的三个视角，"
    "这种情况请填 1。\n"
    "3. has_scene：画面里是否出现**任何场景元素**——地面/地平线/地板、墙面/墙角、"
    "门窗、家具摆件、室内外环境、天空风景、明显的空间透视或景深、"
    "人物脚下的投影或倒影。有任何一项就是 true。\n"
    "4. bg_white：背景是否为**纯白干净空白背景**（无渐变、无纹理、无影棚灰）。\n"
    "5. name_label_topleft：**左上角**是否有中文姓名文字标注。\n"
    "6. extra_text：除左上角那处标注之外，画面里是否还有其它文字/字母/数字/水印/LOGO。\n"
)

_SYS_SCENE = (
    "你是影视剧组的资产质检员。看这张**场景参考图**（应为空镜头），"
    "只回答事实，不做评价。\n"
    "\n"
    "严格按 JSON 输出，不要 markdown 代码块、不要任何解释：\n"
    '{"person_count": 数字, "person_kind": "无|完整人物|人体局部|人像替代物",\n'
    ' "name_label_topleft": true/false, "overlay_text": true/false,\n'
    ' "diegetic_text": true/false, "note": "一句话说明看到的问题"}\n'
    "\n"
    "判定口径（很重要，按这个来）：\n"
    "1. person_count：画面里出现了几个人。**以下都要计入**：\n"
    "   · 完整人物、人影、剪影\n"
    "   · **人体局部**：一只手、手臂、脚、腿、背影、半身\n"
    "   · **人像替代物**：墙上的人物照片/海报/画像/壁画、人形雕塑与胸像、"
    "服装模特与人体模型、镜子里的人影\n"
    "   一个都没有就填 0。\n"
    "2. person_kind：上面计入的是哪一类（都没有填「无」）。\n"
    "3. name_label_topleft：**左上角**是否有中文场景名称文字标注。\n"
    "4. overlay_text：除左上角那处标注之外，是否有**叠加在画面之上**的文字——"
    "水印、字幕条、台标 LOGO、分镜框编号、拼版格子里的标签。"
    "这类文字不属于被拍摄的空间，是废片标志。\n"
    "5. diegetic_text：**空间里本来就有**的文字——店铺招牌、路牌、车牌、门牌、"
    "书脊、包装字。这类是真实空间的一部分，如实报即可，不是缺陷。\n"
    "\n"
    "第 4、5 项**务必分开判**：一块挂在楼上的店铺招牌算 diegetic_text，"
    "不算 overlay_text。\n"
)

_USER_CHAR = "请质检这张角色定妆图。"
_USER_SCENE = "请质检这张场景参考图。"


def _parse(raw: str | None) -> dict | None:
    """宽容解析模型输出的 JSON（偶尔会裹代码块或前后加话）。"""
    t = (raw or "").strip()
    if not t:
        return None
    i, j = t.find("{"), t.rfind("}")
    if i < 0 or j < i:
        log.warning("[qc] 输出里找不到 JSON：%s", t[:120])
        return None
    try:
        d = json.loads(t[i:j + 1])
    except ValueError as e:
        log.warning("[qc] JSON 解析失败：%s | %s", e, t[i:j + 1][:120])
        return None
    return d if isinstance(d, dict) else None


def _as_bool(v) -> bool:
    """模型有时给 "true"/"是"/1 而不是 JSON true。"""
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return bool(v)
    return str(v or "").strip().lower() in ("true", "yes", "1", "是", "有")


def _as_int(v) -> int:
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


async def check_character(image_url: str, *, expect_three_view: bool = True,
                          expect_name_label: bool = True) -> dict | None:
    """体检一张角色定妆图。返回 `{"ok","issues","raw"}`；调用失败返回 None。

    `expect_three_view` / `expect_name_label`：老资产图是单视图、无标注的口径
    （2026-09-09 之前生成的），对它们不该报这两项——那不是缺陷，是代际差异。
    """
    d = await _ask(_SYS_CHAR, _USER_CHAR, image_url)
    if d is None:
        return None
    issues: list[str] = []
    if expect_three_view and not _as_bool(d.get("three_view")):
        issues.append("not_three_view")
    if _as_bool(d.get("has_scene")):
        issues.append("has_scene")
    if not _as_bool(d.get("bg_white")):
        issues.append("bg_not_white")
    if expect_name_label and not _as_bool(d.get("name_label_topleft")):
        issues.append("no_name_label")
    if _as_bool(d.get("extra_text")):
        issues.append("extra_text")
    return {"ok": not issues, "issues": issues,
            "note": str(d.get("note") or "")[:200], "raw": d}


async def check_scene(image_url: str, *, expect_name_label: bool = True) -> dict | None:
    """体检一张场景参考图。返回 `{"ok","issues","raw"}`；调用失败返回 None。

    ⚠️ **景物自带的文字不算缺陷**。2026-09-09 实测「日 外 街道」8 张图：
    6 张通过，2 张仅因车牌与楼体招牌被报为"多余文字"。若把这也算不合格，
    每一个街景、店铺、办公楼场景都会永远挂着红色"不合格"——虚警多到用户
    直接无视体检，那这道核验就白做了。所以只有**叠加在画面之上**的文字
    （水印/字幕/台标/分镜框编号）才是缺陷；招牌车牌门牌如实记在
    `diegetic_text` 里、进 note，但不进 `issues`。
    """
    d = await _ask(_SYS_SCENE, _USER_SCENE, image_url)
    if d is None:
        return None
    issues: list[str] = []
    if _as_int(d.get("person_count")) > 0:
        issues.append("has_person")
    if expect_name_label and not _as_bool(d.get("name_label_topleft")):
        issues.append("no_name_label")
    # 老结论里只有 extra_text（没分叠加/景物两类），回退时按叠加处理，
    # 免得历史 qc_json 里的判定被静默降级成"通过"。
    if _as_bool(d.get("overlay_text") if "overlay_text" in d else d.get("extra_text")):
        issues.append("overlay_text")
    return {"ok": not issues, "issues": issues,
            "diegetic_text": _as_bool(d.get("diegetic_text")),
            "note": str(d.get("note") or "")[:200], "raw": d}


async def _ask(system: str, user: str, image_url: str) -> dict | None:
    if not (image_url or "").strip():
        return None
    from .providers.llm import LLMProvider
    try:
        llm = LLMProvider()
        raw = await llm.complete_vision(system, user, image_url, temperature=0.0)
    except Exception as e:                  # noqa: BLE001
        # 体检是质量增强，渠道抽风不该影响任何出图流程（见模块头）
        log.warning("[qc] 视觉体检失败（%s）：%s", image_url[:80], e)
        return None
    return _parse(raw)


def describe(result: dict | None) -> str:
    """体检结论 → 一句人读的话（给前端和日志共用，避免两处各拼一遍）。"""
    if result is None:
        return "体检未完成（视觉通道不可用）"
    if result.get("ok"):
        # 招牌/车牌照实说明，免得用户以为体检没看见
        return ("体检通过（画面内有招牌/路牌/车牌等景物文字，属空间的一部分）"
                if result.get("diegetic_text") else "体检通过")
    names = [ISSUE_LABELS.get(i, i) for i in (result.get("issues") or [])]
    tail = f"；模型备注：{result['note']}" if result.get("note") else ""
    return "、".join(names) + tail
