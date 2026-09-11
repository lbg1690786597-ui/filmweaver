"""全剧服装识别：逐集并发扫描 + 完整性复查 + 场景继承规则。

## 用户的要求（两条，缺一不可）

> 在任何情况下都应该尽可能全面的生成所有剧情所需的服装，而在剧本中没有明确描述
> 服装时则遵循"同一个场景下同一人物服装相同"，例如第一集如果出现人物在卧室穿
> 白色睡衣，第十集又出现相同卧室而剧本没有描述人物服装，那人物还应该用第一集的
> 白色睡衣资产。

① **穷尽**：剧情要求的每一件衣服都要成为资产。
② **兜底**：剧本没写衣着时，沿用该 (角色 × 归一场景) 已确立的服装，而且是
   **沿用同一张图**，不是重新生成一张相似的。

## ① 为什么要逐集扫描（原实现必然漏）

原来是**一次**调用，喂 `script[:6000]` + 前 300 个镜头。8000 字的 5 集短剧就已经
被截掉四分之一，后段所有服装描写模型根本看不见；上百集的项目更是只看得到开头。
"尽可能全面"和"把剧本截断了喂给模型"是直接矛盾的。

现在按「第N集」拆开，**每集一次调用、并发跑**，每次都拿到该集全文 + 该集镜头清单
（镜号 / 归一场景 / 出场角色）。上下文短了，定位镜号反而更准；集数多也只是并发多
几轮，不再丢信息。

跟着一遍**完整性复查**：把该集已识别出的服装回喂给模型，问"这一集里还有哪处写了
衣着没被列出来"。识别类任务漏项是常态，二次自查的收益远高于把第一次的提示词写得
更长。

⚠️ 并发用**既有**的 `settings.default_concurrency`，不新增也不下调任何并发数
（遵并发铁律）。集数多导致慢是吞吐问题，解法是加 KEY 而不是限流。

## ② 场景继承怎么落地

识别时要模型对每件衣服判两件事：

- `scene`：这件衣服是在哪个场景穿的（用给它的**归一场景名**，见 `scenes.py`）
- `scene_bound`：是不是**场景决定型**服装

  场景决定型 = 换到这个场景就自然会穿的（睡衣@卧室、浴袍@浴室、泳装@泳池、
  手术服@手术室）。这类才跨集沿用。

  事件型 = 因为某个事件才穿的（婚纱@教堂、晚礼服@宴会厅、丧服@灵堂）。人物再次
  进入教堂并不意味着又穿婚纱，所以**不跨集传播**（用户确认："只传播场景决定型服装"）。

时间跨度上不设上限：第 1 集和第 10 集之间隔多久都沿用，除非剧本在后面**另写了**
衣着（那时候后写的是显式变体，优先级更高，自然压过继承）——短剧的角色辨识度比
"衣柜要合理"重要得多（用户确认："沿用，除非剧本另写"）。

**歧义保护**：同一个 (角色 × 归一场景) 被识别出两件**互相矛盾**的显式服装时，
两件都退回事件型（`scene_bound=0`）。既然剧本自己就在这个场景写过不同的衣服，
"进这个场景就穿这件"的前提不成立，此时继承只会猜错。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import uuid

from .db import AssetStage, Project, Shot, get_session
from .scenes import canonical_map

log = logging.getLogger(__name__)

#: 从造型名里切出实词（用于在剧本正文中找换装依据）。
#: 只留中文/字母数字连续片段，「的」「与」这类连接词由长度≥2 的过滤兜住。
_WORD_RE = re.compile(r"[一-鿿A-Za-z0-9]+")

#: **情境决定型服装**：模型敢给这个名字，说明剧本写了对应的情境
#: （病床/婚礼/牢房/追悼会），哪怕正文里没有"病号服"这三个字。
#: 这类换装一律不做"无依据"回并——把病号服并回旗袍，等于让角色穿着
#: 旗袍躺在病床上，比多出一张图严重得多。
_SITUATIONAL = {
    "病号服", "婚纱", "礼服", "囚服", "警服", "军装", "丧服", "孝服",
    "校服", "戏服", "泳装", "浴袍", "睡衣", "工装", "工作服", "制服",
    "运动服", "运动装", "居家服", "家居服",
}

#: 「第N集」集头。阿拉伯数字与中文数字都要认——剧本两种写法都常见。
_EP_HEADER_RE = re.compile(r"第\s*([0-9]{1,4}|[一二三四五六七八九十百零〇]{1,6})\s*集")

_CN_DIGITS = {"零": 0, "〇": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
              "六": 6, "七": 7, "八": 8, "九": 9}

#: 喂给单集识别的剧本上限。单集正常一两千字，给到 12000 已远超需要；
#: 设上限只为防"整本没有集头被当成一集"时把上下文顶爆（那种情况下
#: `split_episodes` 会退回全剧一段）。
_EP_TEXT_CAP = 12000

#: 兜底占位阶段的名字（与 routes_v2._PLACEHOLDER_STAGE 同值，见那边注释）。
PLACEHOLDER_STAGE = "默认造型"


def _cn_num(s: str) -> int | None:
    """中文/阿拉伯数字转 int（只需支持集号量级：一 ~ 一百九十九）。"""
    s = s.strip()
    if s.isdigit():
        return int(s)
    if not s:
        return None
    total, section = 0, 0
    for ch in s:
        if ch in _CN_DIGITS:
            section = _CN_DIGITS[ch]
        elif ch == "十":
            section = (section or 1) * 10
            total += section
            section = 0
        elif ch == "百":
            section = (section or 1) * 100
            total += section
            section = 0
        else:
            return None
    return (total + section) or None


def split_episodes(script: str) -> dict[int, str]:
    """把整本剧本按「第N集」拆成 `{集号: 该集全文}`。

    没有集头（或只有一个）时返回 `{0: 全文}`——0 表示"全剧当一段处理"，
    调用方据此退回单次识别，不做假拆分。

    集头本身保留在该集文本开头，模型据此确认自己在看第几集。
    """
    if not script:
        return {}
    hits = list(_EP_HEADER_RE.finditer(script))
    if len(hits) < 2:
        return {0: script}
    out: dict[int, str] = {}
    for i, m in enumerate(hits):
        ep = _cn_num(m.group(1))
        if ep is None:
            continue
        end = hits[i + 1].start() if i + 1 < len(hits) else len(script)
        body = script[m.start():end].strip()
        # 同一集号出现两次（剧本重复/回顾）→ 拼起来，不互相覆盖
        out[ep] = (out[ep] + "\n" + body) if ep in out else body
    return out or {0: script}


_RECOG_SYSTEM = (
    "你是影视服化道统筹。下面给你一部剧其中**一集**的完整剧本和该集的镜头清单。"
    "请把这一集里每个出场角色穿的衣服全部列出来，用于生成定妆参考图。\n"
    "\n"
    "每件衣服分两类：\n"
    "【base 常规造型】这一集里该角色的日常/主要造型，没有特别描写时就是它。"
    "每个出场角色**必须**给且只给一个 base。\n"
    "⚠️ base 的 stage_name 要用**最简洁的服装类别名**（如「白大褂」「西装」「夹克」），"
    "不要加「笔挺」「整洁」「标准」「沉稳」这类修饰词，也不要写成「医生白大褂工作服」"
    "这种堆叠形式。原因：识别是逐集进行的，同一件衣服如果每集起一个不同的名字，"
    "系统就认不出它们是同一件，会当成 N 件各生成一张定妆图——"
    "同一个角色的同一件白大褂会长出十几个不同样子。"
    "衣服的材质、颜色、新旧等细节写进 description，不要写进 stage_name。\n"
    "【variant 特定服装】剧本文字**明确写出**的、只在部分镜头出现的衣着，"
    "例如「一身丝绸睡裙」「浴袍」「婚纱」「红色长裙」「警服」「病号服」。\n"
    "\n"
    "对每件 variant 必须判断并填写：\n"
    "1. shots：它出现在哪些镜头（用镜头清单里的 # 编号，给数组，如 [5,6,7]）。"
    "定位不到就给空数组。\n"
    "2. scene：它是在哪个场景穿的。**必须从我给你的「本集场景清单」里原样抄一个**，"
    "不要自己造名字；跨多个场景就选最主要的那个。\n"
    "3. scene_bound：是不是**场景决定型**服装。\n"
    "   true = 只要进了这个场景就自然会穿的：睡衣/睡裙@卧室、浴袍/浴巾@浴室、"
    "泳装@泳池、手术服@手术室、病号服@病房、居家服@自己家里。\n"
    "   false = 因为某个**事件**才穿的：婚纱@教堂、晚礼服@宴会厅、丧服@灵堂、"
    "警服/制服@上班、礼服@颁奖礼。人物下次再来这个场景不会因此又穿上它。\n"
    "   拿不准就填 false。\n"
    "4. explicit：剧本原文是不是**真的写了**这件衣服。你自己推测的、剧本没写的，"
    "填 false（这类不会被采用，但请如实标注，不要为了通过而谎报 true）。\n"
    "\n"
    "stage_name 就写这件衣服本身（「丝绸睡裙」「白色婚纱」「浅米色风衣」），"
    "不要写「默认造型」这种没有信息的名字。\n"
    "description 用中文写清这件衣服的材质、颜色、款式，以及该角色的发型与气质要点"
    "（会直接用于 AI 生图），至少 20 字。\n"
    "\n"
    '严格输出 JSON：{"characters":[{"name":"白薇","costumes":['
    '{"kind":"base","stage_name":"职业套装","description":"...",'
    '"scene":null,"scene_bound":false,"shots":[],"explicit":true},'
    '{"kind":"variant","stage_name":"丝绸睡裙","description":"...",'
    '"scene":"豪华套房客厅","scene_bound":true,"shots":[5,6,7],"explicit":true}'
    ']}]}，只输出 JSON。'
)

_AUDIT_SYSTEM = (
    "你是影视服化道统筹的复核人。下面给你一集剧本、该集镜头清单，以及已经识别出来"
    "的服装清单。请只做一件事：找出**剧本原文里明确写了衣着、但清单里没有**的服装。\n"
    "重点检查这些容易漏的写法：\n"
    "- 动作里夹带的衣着（「扯了扯睡裙领口」「解开西装扣子」「把外套披在她肩上」）\n"
    "- 台词里提到的（「你穿这条裙子真好看」）\n"
    "- 配角/龙套的制服工装（保安、护士、司机、服务生、律师、保姆）\n"
    "- 换装动作（「换上」「脱下」「披上」「套上」「穿好」）\n"
    "- 同一角色在这一集里换过好几套\n"
    "清单里已有的不要重复列出。剧本没写的不要凭想象补。确实没有遗漏就返回空数组。\n"
    "字段与判定标准和识别阶段完全一致（shots 用镜号，scene 从场景清单原样抄，"
    "scene_bound 区分场景决定型/事件型，explicit 必须为 true）。\n"
    '严格输出 JSON：{"characters":[{"name":"角色名","costumes":[{...}]}]}，只输出 JSON。'
)


def _parse_json(raw: str) -> dict:
    """容错解析模型返回。失败抛 ValueError（调用方按"该集识别失败"处理）。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


def _episode_context(ep: int, shots: list[Shot], canon: dict[str, str],
                     priors: dict[str, str] | None) -> tuple[str, set[str]]:
    """拼该集的镜头清单 + 场景清单，返回 (文本, 该集归一场景名集合)。

    场景给的是**归一名**：模型回填的 `scene` 才能直接和 AssetStage.location 对上，
    不必再做一次模糊匹配。原名一并列出，方便模型在剧本里找到对应段落。
    """
    lines: list[str] = []
    scenes: dict[str, set[str]] = {}
    for s in shots:
        raw = (s.location or "").strip()
        cn = canon.get(raw, raw)
        if cn:
            scenes.setdefault(cn, set())
            if raw and raw != cn:
                scenes[cn].add(raw)
        try:
            chars = json.loads(s.characters or "[]")
        except json.JSONDecodeError:
            chars = []
        lines.append(f"#{s.order} {cn or '未知场景'} "
                     f"{'/'.join(c for c in chars if isinstance(c, str))}")
    out = [f"这是第 {ep} 集。" if ep else "以下是全剧剧本（未按集拆分）。"]
    if scenes:
        out.append("\n本集场景清单（scene 字段必须从这里原样抄）：")
        for cn, raws in scenes.items():
            extra = f"（剧本里写作：{'、'.join(sorted(raws))}）" if raws else ""
            out.append(f"- {cn}{extra}")
    if lines:
        out.append("\n本集镜头清单（# 镜号 / 场景 / 出场角色）：")
        out.extend(lines)
    if priors:
        pri = {"none": "无明显变化", "growth": "成长型角色", "multi": "多身份切换"}
        out.append("\n用户给出的角色先验：")
        for c, p in priors.items():
            out.append(f"- {c}: {pri.get(p, p)}")
    return "\n".join(out), set(scenes)


def _norm_items(data: dict, scenes: set[str], max_order: int,
                ep: int, char_canon: dict[str, str] | None = None) -> list[dict]:
    """把模型返回规整成内部服装项列表，做完所有钳制与丢弃。

    钳制项：
    - `shots` 只保留 1..max_order 的整数（模型会编不存在的镜号）
    - `scene` 必须命中该集的归一场景清单，否则置 None（宁可不绑场景也不能绑错）
    - `explicit=false` 的 variant 直接丢弃：那是模型的想象，不是剧情要求的服装
    - base 一律不绑场景（它是整集的常规造型，不该被某个场景挟持）
    - **角色名过一次归一**（N2）：`char_canon` 把「少年陆明」映射到「陆明」，
      同一个人的造型阶段才不会因为剧本换了个写法就分裂成两套各画各的。
      查不到映射就用原名——没跑过归一的项目行为完全不变。
    """
    out: list[dict] = []
    canon = char_canon or {}
    for ch in data.get("characters", []) or []:
        name = (ch.get("name") or "").strip()
        if not name:
            continue
        name = canon.get(name, name)
        for c in ch.get("costumes", []) or []:
            stage_name = (c.get("stage_name") or "").strip()
            if not stage_name:
                continue
            kind = str(c.get("kind") or "").strip().lower()
            shots_raw = c.get("shots") or []
            orders: list[int] = []
            if isinstance(shots_raw, list):
                for v in shots_raw:
                    try:
                        n = int(v)
                    except (TypeError, ValueError):
                        continue
                    if 1 <= n <= max_order:
                        orders.append(n)
            orders = sorted(set(orders))
            is_var = kind == "variant" or bool(orders)
            explicit = bool(c.get("explicit", True))
            if is_var and not explicit:
                continue        # 模型自己想的衣服不建资产（要求①说的是"剧情所需"）
            if is_var and stage_name == PLACEHOLDER_STAGE:
                continue        # 变体叫「默认造型」= 没识别出东西，别污染资产库
            scene = (c.get("scene") or "").strip() or None
            if scene and scene not in scenes:
                scene = None    # 编出来的场景名，不绑
            desc = (c.get("description") or "").strip() or None
            out.append({
                "character": name,
                "stage_name": stage_name,
                "description": desc,
                "kind": "variant" if is_var else "base",
                "episode": ep,
                "orders": orders,
                "scene": None if not is_var else scene,
                "scene_bound": bool(c.get("scene_bound")) and bool(scene) and is_var,
            })
    return out


async def _recognize_one_episode(ep: int, ep_text: str, shots: list[Shot],
                                 canon: dict[str, str], max_order: int,
                                 priors: dict[str, str] | None,
                                 model_id: str | None,
                                 audit: bool = True,
                                 char_canon: dict[str, str] | None = None,
                                 ) -> list[dict]:
    """识别一集的服装（识别 + 完整性复查两次调用）。

    任一次失败都不抛：识别失败返回空列表（该集没有变体，仍会由基础阶段兜住），
    复查失败就只用第一次的结果。一集失败不该让整部剧的规划失败。
    """
    from .providers.llm import LLMProvider
    llm = LLMProvider(model_id=model_id)
    ctx, scenes = _episode_context(ep, shots, canon, priors)
    user = f"{ctx}\n\n本集剧本原文：\n{ep_text[:_EP_TEXT_CAP]}"
    try:
        raw = await llm.complete(_RECOG_SYSTEM, user, temperature=0.3)
        items = _norm_items(_parse_json(raw), scenes, max_order, ep, char_canon)
    except Exception as e:  # noqa: BLE001 单集失败不阻断全剧
        log.warning("[costumes] 第 %s 集服装识别失败，该集跳过: %r", ep, e)
        # 返回 None 而不是 []：调用方要能区分"这集识别失败"和"这集确实没服装"。
        # 都返回 [] 的话，LLM 全线故障时 recognize_costumes 会"成功"返回空方案，
        # 而写库端是先无条件删除再重建 —— 一次点击就把用户整套造型方案清空。
        return None

    if not audit:
        return items
    listing = "\n".join(
        f"- {i['character']}：{i['stage_name']}"
        f"（{'常规造型' if i['kind'] == 'base' else '特定服装'}"
        f"{'，镜号 ' + ','.join(str(o) for o in i['orders']) if i['orders'] else ''}）"
        for i in items) or "（本集尚未识别出任何服装）"
    try:
        raw2 = await llm.complete(
            _AUDIT_SYSTEM,
            f"{ctx}\n\n已识别出的服装清单：\n{listing}\n\n"
            f"本集剧本原文：\n{ep_text[:_EP_TEXT_CAP]}",
            temperature=0.2)
        extra = _norm_items(_parse_json(raw2), scenes, max_order, ep, char_canon)
    except Exception as e:  # noqa: BLE001 复查失败就用第一次的结果
        log.info("[costumes] 第 %s 集完整性复查失败，仅用首轮结果: %r", ep, e)
        return items

    # 复查只补 variant：base 每角色一个，首轮已给全，复查再给只会打架
    seen = {(i["character"], i["stage_name"]) for i in items}
    added = 0
    for i in extra:
        if i["kind"] != "variant":
            continue
        if (i["character"], i["stage_name"]) in seen:
            continue
        seen.add((i["character"], i["stage_name"]))
        items.append(i)
        added += 1
    if added:
        log.info("[costumes] 第 %s 集完整性复查补出 %s 件遗漏服装", ep, added)
    return items


def _runs(nums: list[int]) -> list[tuple[int, int]]:
    """升序整数列表 → 连续段 [(起,止), ...]。"""
    out: list[tuple[int, int]] = []
    for n in nums:
        if out and n == out[-1][1] + 1:
            out[-1] = (out[-1][0], n)
        else:
            out.append((n, n))
    return out


def _resolve_scene_bound(variants: list[dict]) -> None:
    """歧义保护：同一 (角色 × 场景) 出现互相矛盾的显式服装 → 全部退回事件型。

    用户确认的规则是"只传播场景决定型服装"，前提是"进这个场景就穿这件"能成立。
    要是剧本自己就在同一个场景给同一个人写过两件不同的衣服（卧室里既写过睡裙又
    写过风衣），这个前提就不成立了，继承只会猜错——此时两件都只在自己的镜号区间
    内生效，不再跨集传播。就地改写 `scene_bound`。
    """
    by_key: dict[tuple[str, str], set[str]] = {}
    for v in variants:
        if v["scene"]:
            by_key.setdefault((v["character"], v["scene"]), set()).add(v["stage_name"])
    ambiguous = {k for k, names in by_key.items() if len(names) > 1}
    for v in variants:
        if v["scene"] and (v["character"], v["scene"]) in ambiguous:
            if v["scene_bound"]:
                log.info("[costumes] %s 在场景「%s」有多套显式服装，"
                         "取消跨集传播（歧义保护）", v["character"], v["scene"])
            v["scene_bound"] = False


def _change_has_script_evidence(stage_name: str, base_key: str,
                                ep_text: str) -> bool:
    """这一集的剧本里，有没有文字支持"角色换了这身衣服"？

    逐集识别是**独立**跑的：模型每集都要给角色写一个 base 造型名，剧本没写
    穿什么时它就自己编一个。编出来的名字集集不同，归一后 key 也不同，
    于是 `_merge_base` 认为"换装了"，各出一张图——角色就在集与集之间变了脸。

    实测项目「9125」：林母 ep1「贵妇套装」、ep2「小香风套装」，而剧本里对
    林母**只字未提**服装（唯一相关的是"林母尖锐的高跟鞋"）。同一部戏里
    陆沉 ep1「机长制服」→ ep2「西装」却是真的换了——ep2 原文有"整理西装下摆"
    "西装内袋"。两者的区别不在造型名，在**剧本里有没有这个词**。

    所以判据：造型名里的实词（归一键本身 + 其余 2 字以上片段）只要有一个
    出现在该集正文里，就认这次换装是剧情要求的；一个都没有 → 是模型的
    措辞漂移，应当并回上一段（沿用同一张图，符合"兜底复用同一张图"的规则）。

    取不到该集正文时（整本退化路径 ep_text 为空）返回 True —— 没有证据说明
    它是漂移，就不动它，保持原有行为。
    """
    if not ep_text:
        return True
    if base_key in _SITUATIONAL:
        return True
    tokens = {base_key} | {t for t in _WORD_RE.findall(stage_name or "")
                           if len(t) >= 2}
    return any(t and t in ep_text for t in tokens)


def _merge_base(per_ep: dict[str, dict[int, dict]], max_ep: int,
                ep_text: dict[int, str] | None = None) -> list[dict]:
    """把逐集的常规造型合并成连续的基础阶段区间。

    输入 `{角色: {集号: 该集 base 项}}`。做三件事：
    1. 相邻集**语义同一件**（归一键相同）的合并成一段——同一套常规造型不该按集
       切成 N 条各自出图（那就是"同一角色跨集变脸"的来源）。
    2. 角色没出场的集用**前一段**顺延覆盖：注入只按镜头所在集查阶段，多覆盖无害，
       但留空缺会让那一集的镜头掉到通用图。
    3. 首段拉到第 1 集、末段拉到最后一集，保证 1..max_ep 连续无缺。

    ## 合并判据从"字面相等"改为"归一键相等"（N1）

    原来是 `segs[-1]["stage_name"] == item["stage_name"]`——字符串完全相等才合并。
    但识别是逐集跑的，模型每集给同一件衣服起的名字都不一样：实测「十八年前」
    陆明的白大褂有 17 种写法（医生白大褂/笔挺白大褂/医师白大褂/整洁白大褂医生服…），
    字面永不相等 → 合并率≈0 → 同一件白大褂分裂成 21 个阶段各自出图。

    现在按 `costume_normalize.extract_base_key()` 提取的**主体词**判断，
    「医生白大褂」与「笔挺白大褂」都归到 `白大褂` 键，能正常合并。

    **变体保护**：`is_variant=True`（名字含"湿透/沾血/破损"等显式状态）的
    绝不与常规造型合并——「湿透凌乱的白大褂」是剧情要求的真变体，
    合并掉就等于把那场戏的服装改错了。

    ## 归一键不同时再查一次剧本证据（2026-09-01）

    归一键不同**不足以**断定角色换装了：模型每集自拟名字，措辞天然会飘。
    所以键不同的时候还要问一句"这集剧本里真提到这身衣服了吗"
    （`_change_has_script_evidence`）——没提到就并回上一段，沿用同一张图。
    这正是用户定的兜底规则：剧本没写穿什么时，**复用同一张图**，
    而不是重新生成一张长得差不多的。
    """
    from .costume_normalize import extract_base_key

    ep_text = ep_text or {}
    out: list[dict] = []
    for name, by_ep in per_ep.items():
        eps = sorted(by_ep)
        if not eps:
            continue
        segs: list[dict] = []
        for e in eps:
            item = by_ep[e]
            key, is_var = extract_base_key(item["stage_name"])
            # 归一键 + 变体标记都相同才算"同一件"：
            # 变体与常规同键（都是"白大褂"）但不可合并，故 is_variant 必须一并比对
            same = bool(segs) and segs[-1]["_key"] == key and segs[-1]["_var"] == is_var
            # 键不同、且都不是显式变体时，看剧本有没有换装的文字依据；
            # 没有依据 = 模型措辞漂移，并回上一段（同一张图）。
            # 但**离开**情境服装（病号服→常服 = 出院了）与**换上**情境服装同样
            # 是真事件，不受"无依据"回并的约束——否则角色一进医院就再也换不回来。
            if not same and segs and not is_var and not segs[-1]["_var"] \
                    and segs[-1]["_key"] not in _SITUATIONAL \
                    and not _change_has_script_evidence(
                        item["stage_name"], key, ep_text.get(e, "")):
                log.info("[costumes] %s 第 %s 集造型名「%s」在本集剧本中无依据，"
                         "并入上一段「%s」（避免无故换装）",
                         name, e, item["stage_name"], segs[-1]["stage_name"])
                same = True
            if same:
                segs[-1]["ep_to"] = e
                # 描述取更详细的那一版（识别质量逐集有波动）
                if len(item["description"] or "") > len(segs[-1]["description"] or ""):
                    segs[-1]["description"] = item["description"]
                continue
            segs.append({"character": name, "stage_name": item["stage_name"],
                         "description": item["description"],
                         "ep_from": e, "ep_to": e,
                         "_key": key, "_var": is_var})
        # 顺延填空缺 + 两端对齐
        for i in range(1, len(segs)):
            segs[i]["ep_from"] = segs[i - 1]["ep_to"] + 1
        segs[0]["ep_from"] = 1
        segs[-1]["ep_to"] = max(max_ep, segs[-1]["ep_to"])
        for s in segs:
            if s["ep_to"] < s["ep_from"]:
                s["ep_to"] = s["ep_from"]
            # 内部字段不外泄（调用方按固定键消费，多余键会写进库）
            s.pop("_key", None)
            s.pop("_var", None)
        out.extend(segs)
    return out


def _plan_rows(items: list[dict], max_ep: int, ep_of: dict[int, int],
               ep_text: dict[int, str] | None = None,
               ) -> tuple[list[dict], list[dict]]:
    """逐集识别结果 → (基础阶段行, 变体行)，变体已完成同衣去重与指针标记。

    同一件衣服（同角色 + 同 stage_name）在相隔很远的镜头段各出现一次时，只有
    **第一段**是"源"（会去出图），后续段建成指针行（`follow=True`）指向源，注入
    时解析到源的那张图。这是"同一件衣服绝不出现两张不同的图"的实现点。
    """
    base_per_ep: dict[str, dict[int, dict]] = {}
    variants: list[dict] = []
    for it in items:
        if it["kind"] == "base":
            # 一集一个 base；模型给多个时取描述最长的那个（信息量最大）
            slot = base_per_ep.setdefault(it["character"], {})
            cur = slot.get(it["episode"])
            if cur is None or len(it["description"] or "") > len(cur["description"] or ""):
                slot[it["episode"]] = it
        else:
            variants.append(it)

    _resolve_scene_bound(variants)

    base_rows = _merge_base(base_per_ep, max_ep, ep_text)

    # 变体：按 (角色, 衣服名) 归并；每件衣服的镜号段按出现顺序排，首段为源
    var_rows: list[dict] = []
    grouped: dict[tuple[str, str], list[dict]] = {}
    for v in variants:
        grouped.setdefault((v["character"], v["stage_name"]), []).append(v)
    for (name, stage_name), group in grouped.items():
        orders = sorted({o for v in group for o in v["orders"]})
        desc = max((v["description"] or "" for v in group), key=len) or None
        # 场景绑定：组内只要有一条判为场景决定型就算（同一件衣服在同一场景反复
        # 出现，正是"场景决定"的证据）；场景取第一条给出的
        bound = any(v["scene_bound"] for v in group)
        scene = next((v["scene"] for v in group if v["scene"]), None)
        segs = _runs(orders) if orders else []
        if not segs:
            # 定位不到镜号的显式服装：绑住场景还能靠场景继承生效；连场景也没有
            # 就无处安放，丢弃（强行按集覆盖会把常规造型挤掉，那是旧实现的病）
            if not scene:
                log.info("[costumes] 丢弃无镜号无场景的服装：%s·%s", name, stage_name)
                continue
            eps = sorted({v["episode"] for v in group if v["episode"]}) or [1]
            var_rows.append({"character": name, "stage_name": stage_name,
                             "description": desc, "ep_from": eps[0],
                             "ep_to": eps[-1], "shot_from": None, "shot_to": None,
                             "scene": scene, "scene_bound": bound, "follow": False})
            continue
        for i, (lo, hi) in enumerate(segs):
            eps_in = [ep_of.get(lo, 1), ep_of.get(hi, 1)]
            var_rows.append({
                "character": name, "stage_name": stage_name,
                "description": desc,
                "ep_from": min(eps_in), "ep_to": max(eps_in),
                "shot_from": lo, "shot_to": hi,
                "scene": scene, "scene_bound": bound,
                # 只有第一段自己出图，其余段共用它的图
                "follow": i > 0,
            })
    return base_rows, var_rows


async def recognize_costumes(project_id: str, model_id: str | None = None,
                             priors: dict[str, str] | None = None,
                             progress_cb=None) -> dict:
    """全剧服装识别（逐集并发 + 完整性复查），返回规划好的阶段行。

    **纯识别，不写库**（写库在 routes_v2.stages_draft，那里还要做增量保护）。
    返回 `{"base": [...], "variants": [...], "episodes": n, "scanned": n,
    "max_ep": n}`；`variants` 里 `follow=True` 的是指针行。

    `progress_cb(done, total)`：每扫完一集回调一次（同步函数，异常不影响识别）。
    长剧一扫几分钟，没有它前端只能干等一个不动的进度条。
    """
    from .config import get_settings

    with get_session() as session:
        proj = session.get(Project, project_id)
        if not proj:
            raise ValueError("project not found")
        script = proj.optimized_script or proj.raw_script or ""
        episodes_meta = json.loads(proj.episodes) if proj.episodes else []
        shots = (session.query(Shot).filter(Shot.project_id == project_id)
                 .order_by(Shot.order).all())
        canon = canonical_map(session, project_id)
        # N2 角色归一：把「少年陆明」这类写法映射到「陆明」，避免同一个人的
        # 造型阶段因剧本换了个写法就分裂成两套各画各的。没跑过归一就是空字典，
        # `_norm_items` 里 `canon.get(name, name)` 会原样返回，行为不变。
        from .char_alias import canonical_character_map
        char_canon = canonical_character_map(session, project_id)
        by_ep: dict[int, list[Shot]] = {}
        ep_of: dict[int, int] = {}
        for s in shots:
            by_ep.setdefault(s.episode, []).append(s)
            ep_of[s.order] = s.episode
    if not script.strip():
        raise ValueError("项目没有剧本，请先导入")

    max_ep = max((len(episodes_meta), *(s.episode for s in shots)), default=1) or 1
    max_order = max((s.order for s in shots), default=0) or 1
    chunks = split_episodes(script)

    # 剧本拆得出集头就逐集扫；拆不出（`{0: 全文}`）就整本一次，
    # 此时镜头清单给全部镜头——退化路径，但仍比截断剧本好。
    tasks: list[tuple[int, str, list[Shot]]] = []
    if set(chunks) == {0}:
        tasks.append((0, script, shots))
    else:
        for ep in sorted(chunks):
            tasks.append((ep, chunks[ep], by_ep.get(ep, shots if len(chunks) == 1 else [])))

    # ⚠️ 并发用**既有**的 default_concurrency，不新增也不下调任何并发数（并发铁律）。
    sem = asyncio.Semaphore(max(1, get_settings().default_concurrency))
    done = 0
    failed_eps: list[int] = []   # 识别失败的集号，供调用方判断要不要动库

    async def _one(ep: int, text: str, ep_shots: list[Shot]) -> list[dict]:
        nonlocal done
        async with sem:
            out = await _recognize_one_episode(
                ep, text, ep_shots, canon, max_order, priors, model_id,
                char_canon=char_canon)
        done += 1
        if progress_cb:
            try:
                progress_cb(done, len(tasks))
            except Exception:  # noqa: BLE001 进度回调不该影响识别本身
                log.debug("[costumes %s] progress_cb 抛错，忽略", project_id)
        if out is None:          # None = 该集识别失败（见 _recognize_one_episode）
            failed_eps.append(ep)
            return []
        return out

    results = await asyncio.gather(*(_one(*t) for t in tasks))
    items = [i for r in results for i in r]
    # 全剧一段的退化路径下 episode=0，按镜号回填真实集号，否则 base 合并会全挤在 0
    for it in items:
        if not it["episode"]:
            it["episode"] = (ep_of.get(it["orders"][0], 1) if it["orders"] else 1)

    base_rows, var_rows = _plan_rows(items, max_ep, ep_of, chunks)
    log.info("[costumes %s] 逐集识别完成：%s 集 / 基础阶段 %s 条 / "
             "服装变体 %s 条（其中场景绑定 %s，指针行 %s）",
             project_id, len(tasks), len(base_rows), len(var_rows),
             sum(1 for v in var_rows if v["scene_bound"]),
             sum(1 for v in var_rows if v["follow"]))
    return {"base": base_rows, "variants": var_rows,
            "episodes": max_ep, "scanned": len(tasks), "max_ep": max_ep,
            "max_order": max_order,
            # 识别失败的集号。写库端据此判断能否安全重建 ——
            # 有失败集时方案是残缺的，不能拿它去覆盖用户已有的造型规划。
            "failed_episodes": sorted(failed_eps)}


def resolve_stage_image(session, st: AssetStage, depth: int = 0) -> str | None:
    """取该阶段实际可用的图：指针行解析到源阶段的图。

    深度上限防环（数据被人工改坏时不能把请求挂死）。

    ⚠️ 指针**不穿透墓碑**：源阶段被用户删掉后，跟随它的行就没有图源了
    （返回 None → 上层按"缺图"处理）。若照旧穿透，用户删掉的那套造型会通过
    指针行继续出现在画面里，等于删不掉。删除接口会告知有几条跟随行受影响。
    """
    if st is None or st.deleted_at:
        return None
    if st.image_url:
        return st.image_url
    if st.source_stage_id and depth < 4:
        src = session.get(AssetStage, st.source_stage_id)
        if src is not None and src.id != st.id and not src.deleted_at:
            return resolve_stage_image(session, src, depth + 1)
    return None


def is_follower(st: AssetStage) -> bool:
    """指针行（与别的阶段是同一件衣服，不该单独出图）。"""
    return bool(getattr(st, "source_stage_id", None)) and not st.image_url


def uid() -> str:
    return uuid.uuid4().hex[:12]
