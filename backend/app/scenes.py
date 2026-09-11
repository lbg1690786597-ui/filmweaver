"""场景归一（canonical scene）：把每集各写一遍的 `Shot.location` 收敛成物理空间。

## 这个模块要解决的问题

用户的要求是：**剧本没有明确描述服装时，遵循"同一个场景下同一人物服装相同"**
（第 1 集在卧室穿白色睡衣，第 10 集又回到同一个卧室而剧本没写衣着，就该沿用
第 1 集那张白色睡衣资产）。

这条规则的前提是"能判断两个镜头是不是同一个场景"。而拆解落库的 `Shot.location`
做不到——它是自由文本，每集各写一遍。实测项目 36c691b20387（测试813）的 22 个
场景名**跨集复用率为 0**：

    「金诚律所 密室会客室」ep2       ←→  「夜 内 沈修杰律所办公室」ep5
    「顾氏集团 总裁办走廊」ep3       ←→  「日 内 鼎盛集团 总裁办走廊」ep4
    「高端酒店大堂/电梯间」ep1       ←→  「酒店走廊/电梯间」ep1

同一个根因也让 `scene_anchors`（原按 (项目,集,场景) 建键）给同一个房间在每集
发一张互不相干的基准帧——场景侧的同一个 bug。

## 归一分两步

1. `normalize_location`：**确定性**清洗。剥掉剧本 slug 行带进来的「日/夜/晨/黄昏」
   「内/外」前缀、统一分隔符与空白、去掉集号前缀。这一步不需要模型，永远可复现。
2. `canonicalize_scenes`：一次 LLM 合并，把清洗后仍不同名的别名归组。

## 为什么"保守归一"是安全的

少归一 → 少一次服装继承，用户仍会看到该场景单独出一张图，**画面不会错**。
错归一 → 人物在 A 房间穿了 B 房间的衣服，或两个不同房间共用一张基准帧，
**画面会错**。所以提示词与代码一律偏向"拿不准就别合"，且合并结果人工可改
（`SceneAlias.source='manual'` 的行 AI 重跑时不覆盖）。
"""
from __future__ import annotations

import json
import re
import uuid

from .db import Shot, get_session

#: slug 行/场景名里常见的时间标记（剧本 `1-1 日 内 高端酒店大堂` 会被拆解器
#: 整段抄进 location，于是同一个房间因为"日/夜"不同而被当成两个场景）
_TIME_WORDS = ("日", "夜", "晨", "早", "晚", "黄昏", "傍晚", "清晨", "深夜",
               "白天", "凌晨", "午后", "正午")
#: 内外景标记
_INT_EXT_WORDS = ("内", "外", "内景", "外景")

#: 分隔符统一成一个空格：`顾氏集团·总裁办走廊` / `顾氏集团/总裁办走廊`
#: / `顾氏集团　总裁办走廊` 视为同名
_SEP_RE = re.compile(r"[·、,，\t　]+")
#: 行首的 `1-1` / `12-3` 场号
_SLUG_NO_RE = re.compile(r"^\s*\d+\s*[-–—]\s*\d+\s*")
_WS_RE = re.compile(r"\s+")


def normalize_location(raw: str) -> tuple[str, str | None, str | None]:
    """确定性清洗一个场景名。

    返回 `(clean, time_of_day, int_ext)`：
    - `clean`：剥掉集场号、时间、内外标记后的场景名（分隔符归一为单空格）
    - `time_of_day` / `int_ext`：剥下来的标记（None = 原名里没写）

    这些标记要单独留着而不是丢掉：生成场景基准帧时"夜 内"决定光线氛围，
    只是它**不该参与"是不是同一个空间"的判断**——同一间卧室白天夜里都是它。

    >>> normalize_location("日 内 高端酒店大堂/电梯间")
    ('高端酒店大堂/电梯间', '日', '内')
    >>> normalize_location("1-3 夜 外 顾家大宅 院子")
    ('顾家大宅 院子', '夜', '外')
    >>> normalize_location("顾氏集团·总裁办走廊")
    ('顾氏集团 总裁办走廊', None, None)
    """
    s = (raw or "").strip()
    if not s:
        return "", None, None
    s = _SLUG_NO_RE.sub("", s)
    s = _SEP_RE.sub(" ", s)
    time_of_day: str | None = None
    int_ext: str | None = None
    # 只剥**前缀**位置的标记：场景名内部的"内/外"是实义字（如「室内泳池」「外滩」），
    # 全局删除会把名字改烂。循环是因为顺序可能是「日 内」也可能是「内 日」。
    changed = True
    while changed:
        changed = False
        head = _WS_RE.split(s.strip(), 1)
        first = head[0] if head else ""
        rest = head[1] if len(head) > 1 else ""
        if not rest:
            break                      # 只剩一个词了，那就是场景名本身，不再剥
        if time_of_day is None and first in _TIME_WORDS:
            time_of_day, s, changed = first, rest, True
            continue
        if int_ext is None and first in _INT_EXT_WORDS:
            int_ext, s, changed = first[0], rest, True
            continue
    return _WS_RE.sub(" ", s).strip(), time_of_day, int_ext


def raw_locations(session, project_id: str) -> list[str]:
    """该项目拆解出的全部 `Shot.location` 原值（按首次出现顺序）。

    只取 (order, location) 两列，不实例化整行 ORM 对象（B29）：这里唯一要用的
    就是 location，而 Shot 有 40+ 列（含 gen_prompt / script_ref / transform_meta
    等大文本）。1424 镜的项目按整行加载要造 1424 个对象、把所有大文本读进内存，
    只为读一个字段。
    """
    out: list[str] = []
    seen: set[str] = set()
    for _order, loc in (session.query(Shot.order, Shot.location)
                        .filter(Shot.project_id == project_id)
                        .order_by(Shot.order).all()):
        lo = (loc or "").strip()
        if lo and lo not in seen:
            seen.add(lo)
            out.append(lo)
    return out


def canonical_map(session, project_id: str, shots=None) -> dict[str, str]:
    """`{Shot.location 原值: 归一场景名}`，覆盖该项目所有出现过的场景名。

    字典表里有映射就用它（含人工改过的）；没有的退回 `normalize_location` 的
    确定性结果——这保证**任何时候**都能拿到一个可用的归一名，不依赖"是否跑过
    AI 归一"。缺失映射不是错误状态，只是"还没做过别名合并"。

    `shots`：调用方**已经加载过**该项目镜头时把列表传进来，避免再查一遍库
    （B29：compute_readiness 原先查两次 shots，第二次就是从这里发出的）。
    """
    from .db import SceneAlias
    rows = (session.query(SceneAlias)
            .filter(SceneAlias.project_id == project_id).all())
    mapping = {r.raw_name: r.canonical for r in rows if r.canonical}
    if shots is None:
        raws = raw_locations(session, project_id)
    else:
        seen: set[str] = set()
        raws = []
        for sh in shots:
            lo = (getattr(sh, "location", None) or "").strip()
            if lo and lo not in seen:
                seen.add(lo)
                raws.append(lo)
    for raw in raws:
        if raw not in mapping:
            mapping[raw] = normalize_location(raw)[0] or raw
    return mapping


def canonical_of(session, project_id: str, raw: str | None) -> str:
    """单个场景名的归一结果（空名返回空串）。

    热路径（注入、锚点）用它；批量场合请用 `canonical_map` 一次取全，
    避免 N 次查库。
    """
    if not raw or not raw.strip():
        return ""
    from .db import SceneAlias
    row = (session.query(SceneAlias)
           .filter(SceneAlias.project_id == project_id,
                   SceneAlias.raw_name == raw.strip()).first())
    if row and row.canonical:
        return row.canonical
    return normalize_location(raw)[0] or raw.strip()


def canonical_locations(session, project_id: str, shot,
                        canon: dict[str, str] | None = None) -> list[str]:
    """镜头最终注入的**归一**场景名（保序去重）。`effective_locations` 的归一版。

    `effective_locations` 返回的是 `Shot.location` **原值**，而场景资产
    （`Asset(kind="location")`）一律按归一名存放——两边直接比字符串必然漏配。
    凡是"按镜头场景取资产"的地方都要过这个函数，不要自己拼。

    这里没有直接包一层 `effective_locations`，而是把它的契约
    （`(L1 ∪ add_loc) − remove_loc`）在**归一名空间**重算一遍。原因是
    `remove_loc` 是按字符串相等剔除的：场景轨现在展示归一名，用户点"移除"
    传回来的就是归一名，拿它去比原名「夜 内 楚家公馆-客厅」永远不等，
    移除会静默失效。归一后再比，原名归一名两种写法都能命中。

    `canon`：调用方**批量**处理镜头时把 `canonical_map` 的结果传进来，
    否则每个名字都要查一次别名表（1424 镜的项目就是几千次，见 B29）。
    map 里没有的名字（`add_loc` 写的自定义场景）仍退回确定性清洗。
    """
    def _canon(x: str) -> str:
        if canon is None:
            return canonical_of(session, project_id, x)
        key = (x or "").strip()
        if not key:
            return ""
        return canon.get(key) or normalize_location(key)[0] or key

    l1 = [shot.location] if getattr(shot, "location", None) else []
    try:
        ov = json.loads(shot.ref_overrides) if shot.ref_overrides else {}
    except (ValueError, TypeError):
        ov = {}
    if not isinstance(ov, dict):
        ov = {}

    def _names(key: str) -> list[str]:
        return [x for x in ov.get(key, []) if isinstance(x, str) and x]

    remove = {c for c in (_canon(x) for x in _names("remove_loc")) if c}
    out: list[str] = []
    for raw in l1 + _names("add_loc"):
        cn = _canon(raw)
        if cn and cn not in remove and cn not in out:
            out.append(cn)
    return out


def location_asset(session, project_id: str, name: str | None):
    """按场景名取资产行；`name` 传原名或归一名都行，取不到返回 None。

    先按归一名找（这是新写入的口径），找不到再按传进来的原样找一次——
    兼容还没跑过 `reconcile_location_assets` 的老项目。迁移完之后只会命中第一路。
    """
    from .db import Asset
    raw = (name or "").strip()
    if not raw:
        return None
    canon = canonical_of(session, project_id, raw)
    q = (session.query(Asset)
         .filter(Asset.project_id == project_id, Asset.kind == "location"))
    a = q.filter(Asset.name == canon).first() if canon else None
    if a is None and raw != canon:
        a = q.filter(Asset.name == raw).first()
    return a


def ensure_location_asset(session, project_id: str, canon: str):
    """拿到**名字正好等于归一名** `canon` 的场景资产行，没有就建/改名。

    优先认领老项目里那行按原名建的资产（把它改名成归一名），而不是另起一行：
    另起一行会让已经生成好的图和描述留在旧行上，界面看着"这个场景没图"、
    于是又花一次钱重新生成同一个房间。

    调用方负责 commit。**只改 `Asset.name`**，理由见 `reconcile_location_assets`。
    """
    import uuid as _uuid

    from .db import Asset
    a = location_asset(session, project_id, canon)
    if a is None:
        a = Asset(id=_uuid.uuid4().hex[:12], project_id=project_id,
                  kind="location", name=canon)
        session.add(a)
    elif a.name != canon:
        a.name = canon
    return a


def _keep_rank(asset, canon: str) -> tuple:
    """合并同一归一名下的多行场景资产时，「留哪一行」的排序键（越小越优先留）。

    第一优先级是"没被用户删掉"：否则一个墓碑行可能把同组里用户还在用的那一行
    合并掉，资产就凭空消失了（组内全是墓碑时，留下的自然还是墓碑，语义正确）。
    其后：已经叫归一名的优先 → 有图的 → 有描述的。

    提成函数是为了让**预览**（`preview_groups`，只算不写）与**执行**
    （`reconcile_location_assets`）用的是同一条判据。两处各写一遍的话，
    预览说"会删掉 A 保留 B"、实际删的却是 B —— 而这个动作是不可逆的。
    """
    return (asset.deleted_at is not None, asset.name != canon,
            not bool(asset.image_url), not bool((asset.prompt or "").strip()))


def reconcile_location_assets(session, project_id: str,
                              only_canon: set[str] | None = None) -> dict:
    """把场景资产的名字收敛到归一名，归一后重名的合并成一行。调用方负责 commit。

    `only_canon`：只处理归一名落在这个集合里的资产（`None` = 全项目）。
    逐组确认的入口必须传它 —— 用户确认的是"合并这一组"，不该顺带把库里
    另外几十组早先由 AI 写下的别名也一起收敛掉（那是用户没看过、
    且会删资产行的有损动作）。

    场景资产历史上按 `Shot.location` **原值**创建，于是「夜 内 楚家公馆-客厅」
    与「楚家公馆-客厅」成了两行、各自出了一张图：同一个房间在成片里长得不一样，
    还白花一次生图钱。这里按归一名分组，一组只留一行。

    **只改 `Asset.name`**，不动 `Shot.location` 与 `SceneAlias.raw_name`——
    镜头留在原名空间、资产在归一名空间，两者由别名表桥接。所以这里不能用
    `rename_asset_everywhere`：它会把原名一起改掉，等于抹掉映射本身。

    合并时只**补空位**（留存行没有图/描述才从被删行取），绝不覆盖已有值：
    留存行的图和描述可能是用户手工换过的。

    返回 `{"renamed", "merged", "deleted": [被删的名字]}`。
    """
    from .db import Asset
    rows = (session.query(Asset)
            .filter(Asset.project_id == project_id,
                    Asset.kind == "location").all())
    groups: dict[str, list] = {}
    for a in rows:
        canon = canonical_of(session, project_id, a.name) or (a.name or "").strip()
        if canon and (only_canon is None or canon in only_canon):
            groups.setdefault(canon, []).append(a)

    renamed = merged = 0
    deleted: list[str] = []
    for canon, items in groups.items():
        items.sort(key=lambda a: _keep_rank(a, canon))
        keep, dups = items[0], items[1:]
        for d in dups:
            if not keep.image_url and d.image_url:
                keep.image_url = d.image_url
            if not (keep.prompt or "").strip() and (d.prompt or "").strip():
                keep.prompt = d.prompt
            deleted.append(d.name)
            session.delete(d)
            merged += 1
        if keep.name != canon:
            keep.name = canon
            renamed += 1
    return {"renamed": renamed, "merged": merged, "deleted": deleted}


def set_alias(session, project_id: str, raw_name: str, canonical: str,
              source: str = "ai",
              time_of_day: str | None = None,
              int_ext: str | None = None) -> bool:
    """写入/更新一条别名映射。返回是否发生了变更。

    `source='ai'` **不覆盖**已存在的 `source='manual'` 行——人工判断优先于模型，
    否则用户每改一次都会被下一次重识别推翻。
    """
    from .db import SceneAlias
    raw_name = (raw_name or "").strip()
    canonical = (canonical or "").strip()
    if not raw_name or not canonical:
        return False
    row = (session.query(SceneAlias)
           .filter(SceneAlias.project_id == project_id,
                   SceneAlias.raw_name == raw_name).first())
    if row is None:
        session.add(SceneAlias(
            id=uuid.uuid4().hex[:12], project_id=project_id,
            raw_name=raw_name, canonical=canonical,
            time_of_day=time_of_day, int_ext=int_ext, source=source))
        return True
    if source == "ai" and row.source == "manual":
        return False               # 人工映射不被 AI 推翻
    if row.canonical == canonical and row.source == source:
        return False
    row.canonical = canonical
    row.source = source
    if time_of_day is not None:
        row.time_of_day = time_of_day
    if int_ext is not None:
        row.int_ext = int_ext
    return True


_MERGE_SYSTEM = (
    "你是影视场景统筹。下面给你同一部剧的全部场景名（来自逐集分场，同一个物理空间"
    "在不同集里写法常常不同）。请把**指向同一个物理空间**的名字归为一组。\n"
    "判断标准（务必从严）：\n"
    "1. 只有当你确信两个名字说的是**同一个房间/同一处空间**时才合并。"
    "机构名不同（A 公司会议室 vs B 公司会议室）、房间用途不同（会客室 vs 办公室）、"
    "归属人不同（林晨卧室 vs 白薇卧室）一律**不合并**。\n"
    "2. 同一机构的**不同房间**不要合并成一个（「总裁办公室」和「总裁办走廊」是两处）。\n"
    "3. 公司/机构改名或简称（「顾氏集团 总裁办走廊」与「鼎盛集团 总裁办走廊」）"
    "若从上下文看是同一处走廊，可以合并；拿不准就**不合并**。\n"
    "4. 时间与内外景（日/夜/内/外）**不影响**是否同一空间，同一房间白天夜里是同一组。\n"
    "宁可漏合并也不要错合并：漏合并只是少一次资产复用，错合并会让人物在错误的"
    "房间里穿错衣服。\n"
    "每组给一个简洁、稳定、不含时间与内外标记的规范名（canonical），"
    "优先采用组内最完整清晰的那个写法。\n"
    '严格输出 JSON：{"groups":[{"canonical":"顾家大宅 客厅",'
    '"members":["顾家大宅 客厅","夜 内 顾宅客厅"]}]}，只输出 JSON。'
    "每个输入名字必须且只能出现在一个组里；独一无二的场景也要单独成组。"
)


def _parse_json(raw: str) -> dict:
    """容错解析模型返回（去 ```json 包裹）。失败抛 ValueError。"""
    text = (raw or "").strip()
    if text.startswith("```"):
        text = text.strip("`")
        if text.lower().startswith("json"):
            text = text[4:]
    start, end = text.find("{"), text.rfind("}")
    if start >= 0 and end > start:
        text = text[start:end + 1]
    return json.loads(text)


async def propose_scene_groups(project_id: str, model_id: str | None = None,
                               ) -> dict:
    """**只算不写**：算出一份归一分组建议。不碰 `scene_aliases`、不碰资产。

    这是 `canonicalize_scenes` 的前半段。提出来的唯一理由是**归一是有损的**：
    它会把多行场景资产合并成一行（删掉的那行可能已经出过图），而原来的入口
    「跑一次归一」是算完直接写库，用户在看到结果之前就已经被改了。
    有了它，界面才能做到"先看、逐组确认、再执行"。

    返回 `{"groups": [{canonical, members[]}], "llm": bool,
            "meta": {原名: (time_of_day, int_ext)}}`。
    """
    from .providers.llm import LLMProvider

    with get_session() as session:
        raws = raw_locations(session, project_id)
    if not raws:
        return {"groups": [], "llm": False, "meta": {}}

    # 第一步：确定性清洗后按清洗结果分组（同名的先并起来）
    det: dict[str, list[str]] = {}
    meta: dict[str, tuple[str | None, str | None]] = {}
    for raw in raws:
        clean, tod, ie = normalize_location(raw)
        det.setdefault(clean or raw, []).append(raw)
        meta[raw] = (tod, ie)

    groups: list[dict] = [{"canonical": k, "members": v} for k, v in det.items()]
    used_llm = False
    # 第二步：清洗后仍有多个不同名字才值得让模型判别名
    if len(det) > 1:
        listing = "\n".join(f"- {k}（原名：{'、'.join(v)}）" for k, v in det.items())
        try:
            llm = LLMProvider(model_id=model_id)
            raw_out = await llm.complete(
                _MERGE_SYSTEM, f"全剧场景名清单：\n{listing}", temperature=0.1)
            data = _parse_json(raw_out)
            merged: list[dict] = []
            seen_clean: set[str] = set()
            for g in data.get("groups", []):
                canon = (g.get("canonical") or "").strip()
                members = [m.strip() for m in g.get("members", [])
                           if isinstance(m, str) and m.strip()]
                # 模型可能回清洗名也可能回原名，两种都认；未知名字直接丢弃
                raw_members: list[str] = []
                for m in members:
                    if m in det:
                        raw_members.extend(det[m])
                        seen_clean.add(m)
                    else:
                        for clean, rs in det.items():
                            if m in rs:
                                raw_members.extend(rs)
                                seen_clean.add(clean)
                                break
                raw_members = list(dict.fromkeys(raw_members))
                if canon and raw_members:
                    merged.append({"canonical": canon, "members": raw_members})
            # 模型漏掉的清洗名按原样补回来——绝不能让某个场景在字典里消失
            for clean, rs in det.items():
                if clean not in seen_clean:
                    merged.append({"canonical": clean, "members": rs})
            if merged:
                groups = merged
                used_llm = True
        except (ValueError, TypeError, KeyError) as e:      # 解析失败
            groups = [{"canonical": k, "members": v} for k, v in det.items()]
            _log_merge_fallback(project_id, e)
        except Exception as e:  # noqa: BLE001 模型调用失败不阻断——退回确定性归一
            groups = [{"canonical": k, "members": v} for k, v in det.items()]
            _log_merge_fallback(project_id, e)
    return {"groups": groups, "llm": used_llm, "meta": meta}


def apply_scene_groups(session, project_id: str, groups: list[dict],
                       source: str = "ai",
                       meta: dict[str, tuple[str | None, str | None]] | None = None,
                       scoped_assets: bool = False) -> dict:
    """把分组写进 `scene_aliases`，并收敛场景资产。调用方负责 commit。

    `source='manual'`（逐组确认的入口）写下的行 AI 重跑时不会被推翻 ——
    用户既然一组一组看过并确认了，那就是人工判断。

    `scoped_assets=True` 时资产收敛只作用于本次这些组的归一名，
    详见 `reconcile_location_assets` 的 `only_canon`。
    """
    meta = meta or {}
    updated = 0
    touched: set[str] = set()
    for g in groups:
        canon = (g.get("canonical") or "").strip()
        if not canon:
            continue
        touched.add(canon)
        for raw in g.get("members", []):
            tod, ie = meta.get(raw, (None, None))
            if set_alias(session, project_id, raw, canon,
                         source=source, time_of_day=tod, int_ext=ie):
                updated += 1
    # 别名一变，场景资产该归到哪个归一名也跟着变——就地收敛，
    # 否则同一个房间会留着两行资产、各出一张不一样的图。
    assets = reconcile_location_assets(
        session, project_id, only_canon=touched if scoped_assets else None)
    return {"updated": updated, "assets": assets}


def preview_groups(session, project_id: str, groups: list[dict],
                   meta: dict[str, tuple[str | None, str | None]] | None = None,
                   ) -> list[dict]:
    """把一份分组建议翻译成「执行后到底会变什么」，**不写任何东西**。

    每组返回：
    - `members`：每个原名的镜头数、当前归一名、是否人工锁定、这组会不会改到它
    - `changed`：这一组是否有任何实际变化（全都已经是这个归一名 → False）
    - `locked`：组内有 `source='manual'` 且当前归一名与建议不同的成员。
      这些成员**不会**被写（`set_alias` 里 ai 不覆盖 manual），但逐组确认走的是
      manual 源，会覆盖 —— 所以必须在界面上单独标出来让用户知道自己在推翻什么。
    - `asset_merges`：会被合并掉的场景资产行（**不可逆**，且被删那行可能已出过图）

    资产那一段是这个预览存在的主要理由：镜头与别名都是可改回来的映射，
    而资产合并会 `session.delete()` 掉一行。用户必须先看到"要删的是哪一行、它有没有图"。
    """
    from .db import Asset

    meta = meta or {}
    counts: dict[str, int] = {}
    for (loc,) in (session.query(Shot.location)
                   .filter(Shot.project_id == project_id).all()):
        lo = (loc or "").strip()
        if lo:
            counts[lo] = counts.get(lo, 0) + 1
    cur = canonical_map(session, project_id)
    from .db import SceneAlias
    src = {r.raw_name: r.source for r in (session.query(SceneAlias)
           .filter(SceneAlias.project_id == project_id).all())}
    loc_assets = (session.query(Asset)
                  .filter(Asset.project_id == project_id,
                          Asset.kind == "location").all())

    out: list[dict] = []
    for g in groups:
        canon = (g.get("canonical") or "").strip()
        members = [m for m in g.get("members", []) if m]
        if not canon or not members:
            continue
        mem_out: list[dict] = []
        locked: list[str] = []
        changed = False
        for raw in members:
            now = cur.get(raw) or normalize_location(raw)[0] or raw
            will_change = now != canon
            if will_change:
                changed = True
            if will_change and src.get(raw) == "manual":
                locked.append(raw)
            tod, ie = meta.get(raw, normalize_location(raw)[1:])
            mem_out.append({"raw_name": raw, "shots": counts.get(raw, 0),
                            "current_canonical": now,
                            "source": src.get(raw, "auto"),
                            "will_change": will_change,
                            "time_of_day": tod, "int_ext": ie})
        # 资产合并模拟：本组执行后，哪些场景资产行会落到同一个归一名下。
        # 映射用"建议覆盖当前"——成员按建议走，其余资产维持现状。
        proposed = {raw: canon for raw in members}
        fall_in = [a for a in loc_assets
                   if (proposed.get((a.name or "").strip())
                       or cur.get((a.name or "").strip())
                       or normalize_location(a.name or "")[0]
                       or (a.name or "").strip()) == canon]
        merges: dict = {}
        if len(fall_in) > 1:
            fall_in.sort(key=lambda a: _keep_rank(a, canon))
            keep, dups = fall_in[0], fall_in[1:]
            merges = {
                "keep": {"name": keep.name, "has_image": bool(keep.image_url)},
                "drop": [{"name": d.name, "has_image": bool(d.image_url),
                          "deleted": d.deleted_at is not None} for d in dups],
            }
        out.append({
            "canonical": canon, "members": mem_out, "changed": changed,
            "locked": locked, "asset_merges": merges,
            "shots": sum(m["shots"] for m in mem_out),
        })
    # 有变化的排前面，其次按镜头数多的在前（一眼看到影响最大的组）
    out.sort(key=lambda g: (not g["changed"], -g["shots"], g["canonical"]))
    return out


async def canonicalize_scenes(project_id: str, model_id: str | None = None,
                              ) -> dict:
    """跑一次场景别名合并，把结果写进 `scene_aliases`。

    幂等：重复调用只会更新 AI 来源的行，人工行保持不动。
    场景名 ≤1 个时直接走确定性归一，不浪费一次模型调用。

    ⚠️ 这条路径**算完直接写**（`stages_draft` 内部依赖它的这个语义）。
    需要"先看再决定"的场合请用 `propose_scene_groups` + `preview_groups`
    + `apply_scene_groups`，见 `routes_v2` 的 `/scenes/preview` 与 `/scenes/apply-groups`。

    返回 `{"scenes": [{canonical, members[]}], "updated": n, "llm": bool}`。
    """
    prop = await propose_scene_groups(project_id, model_id)
    groups = prop["groups"]
    if not groups:
        return {"scenes": [], "updated": 0, "llm": False}
    with get_session() as session:
        res = apply_scene_groups(session, project_id, groups,
                                 source="ai", meta=prop["meta"])
        session.commit()
    return {"scenes": groups, "updated": res["updated"], "llm": prop["llm"],
            "assets": res["assets"]}


def _log_merge_fallback(project_id: str, err: object) -> None:
    import logging
    logging.getLogger(__name__).warning(
        "[scenes %s] 场景别名合并失败，退回确定性归一（只按清洗后同名合并）: %r",
        project_id, err)
