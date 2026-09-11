"""verify_continuity.py — 镜头连贯性推导（3.9）

要钉住的是用户实测的两类穿帮，两者根子相同：连续镜头之间没有可传递的状态。

## 一、在场角色断续（「林母只出现在一个片段里」）

项目「真人剧-验证片（五集）」镜 1-7 同属「半岛酒店顶楼餐厅」、镜 2-7 全是
continuous，`characters` 却是：

    镜1 林语/陆沉/林母 → 镜2 陆沉/林语 → … → 镜5 又有林母 → 镜6 又没有

而镜 2-4 的剧本里**一个字的离场描写都没有**（镜 1 结尾林母刚"压低身子凑近
林语死死盯着她"）。链式后果：不在 characters → 定妆图不注入 → 提示词不提她
→ 模型按"两人对坐"画。镜 2 实际下发的提示词就是「陆沉与林语对面而坐」。

## 二、位置跳变

`_scene_run_ctx` 早就写了"座次延续上一镜结尾"，但那是没有事实支撑的空话。
台账（`blocking_out`）把位置变成显式状态，本脚本钉住它的解析与渲染。

## 断言分区

  ① 离场判定：必须**同句**才算，否则一个人出门会让整桌人从下一镜起消失
  ② 在场传播：段首不补、有离场就停、已有的不重复补
  ③ 台账解析：脏数据一律降级为"没有台账"，绝不把半残字段拼进提示词
  ④ 台账渲染：三字段齐全/缺省都要读得通
  ⑤ 真实回归：用验证片镜 1-7 的真实 characters 跑一遍，林母必须被补回 2/3/4/6/7

运行：python3 backend/scripts/verify_continuity.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from app.continuity import (  # noqa: E402
    parse_characters, mentions_exit, derive_present_characters,
    parse_blocking, blocking_text,
)

_pass = 0
_fail = 0


def ok(cond, msg):
    global _pass, _fail
    if cond:
        _pass += 1
        print(f"  ✅ {msg}")
    else:
        _fail += 1
        print(f"  ❌ {msg}")


class S:
    """最小镜头替身。"""

    def __init__(self, sid, order, chars, ref="", loc="餐厅", link="continuous"):
        self.id = sid
        self.order = order
        self.characters = json.dumps(chars, ensure_ascii=False)
        self.script_ref = ref
        self.location = loc
        self.link_to_prev = link


print("① 离场判定：必须与角色名同句")
ok(mentions_exit("林母起身离去。", "林母"), "同句命中：起身离去")
ok(mentions_exit("△林母摔门而出，屋里只剩两人。", "林母"), "同句命中：摔门")
ok(not mentions_exit("林母叹了口气，端起茶杯。", "林母"), "没有离场词 → 不判离场")
# 这一条是关键：不同句不能牵连
ok(not mentions_exit("林建国走出房间。林母低头不语。", "林母"),
   "别人离场不牵连：林建国走了，林母仍在场")
ok(mentions_exit("林建国走出房间。林母也跟着离开了。", "林母"),
   "各自成句时各判各的")
ok(not mentions_exit("林母转身看向窗外。", "林母"),
   "「转身」不等于离场（还在场）")
ok(not mentions_exit("", "林母"), "空文本不判离场")
ok(not mentions_exit("林母离开了。", ""), "空角色名不判离场")

print("\n② 在场传播")
run = [
    S("a", 1, ["林语", "陆沉", "林母"],
      "△林母压低身子凑近林语，死死盯着她。"),
    S("b", 2, ["陆沉", "林语"], "△陆沉神情冷淡，慢条斯理地放下咖啡杯。"),
    S("c", 3, ["陆沉", "林语"], "陆沉：第一，婚后我绝不干涉你的社交。"),
]
d = derive_present_characters(run)
ok("a" not in d, "段首镜不补（谁在场以拆解为准）")
ok(d.get("b") == ["林母"], "镜2 补回林母")
ok(d.get("c") == ["林母"], "镜3 仍然补回林母")

run2 = [
    S("a", 1, ["林语", "林母"], "△两人坐下。"),
    S("b", 2, ["林语"], "△林母起身离去，只剩林语一人。"),
    S("c", 3, ["林语"], "△林语看着窗外。"),
]
d2 = derive_present_characters(run2)
ok(d2.get("b") == ["林母"], "离场那一镜她**还在场**（她是在这一镜里走的）")
ok("c" not in d2, "离场之后不再传播")

run3 = [S("a", 1, ["林语", "陆沉"], ""), S("b", 2, ["林语", "陆沉"], "")]
ok(derive_present_characters(run3) == {}, "本来就齐的不重复补")
ok(derive_present_characters([S("a", 1, ["林语"], "")]) == {},
   "单镜成段不推导")
ok(derive_present_characters([]) == {}, "空段不炸")

print("\n③ 台账解析：脏数据降级")
ok(parse_blocking(None) == {}, "None → 空")
ok(parse_blocking("") == {}, "空串 → 空")
ok(parse_blocking("不是 json") == {}, "非 JSON → 空（不抛）")
ok(parse_blocking('["林母"]') == {}, "顶层不是对象 → 空")
ok(parse_blocking('{"林母": "画面左侧"}') == {}, "值不是对象 → 丢掉该角色")
ok(parse_blocking('{"林母": {"posture": "坐"}}') == {},
   "缺 pos → 丢掉（没有位置等于没说）")
ok(parse_blocking('{"林母": {"pos": "   "}}') == {}, "pos 是空白 → 丢掉")
good = parse_blocking(
    '{"林母": {"pos": "画面左侧，餐桌北侧座位", "posture": "坐",'
    ' "facing": "面向林语", "emotion": "愤怒", "costume": "红裙"}}')
ok(list(good) == ["林母"], "正常数据解析出来")
ok(set(good["林母"]) == {"pos", "posture", "facing"},
   "白名单外的字段（emotion/costume）被丢掉——它们各有各的真源")

print("\n④ 台账渲染")
ok(blocking_text({}) == "", "空台账渲染成空串（不占提示词篇幅）")
t = blocking_text(good)
ok("林母" in t and "餐桌北侧座位" in t and "面向林语" in t, "三字段都在文案里")
ok("愤怒" not in t and "红裙" not in t, "被丢掉的字段不会漏进文案")
t2 = blocking_text({"陆沉": {"pos": "餐桌对面"}})
ok(t2.strip().endswith("餐桌对面"), "只有 pos 时也读得通，不出现空的顿号")

print("\n⑤ 真实回归：验证片镜 1-7")
real = [
    S("s1", 1, ["林语", "陆沉", "林母"],
      "△桌下特写：林母尖锐的高跟鞋尖狠狠踩在林语的脚背上。"
      "△林母压低身子，凑近林语死死盯着她。"),
    S("s2", 2, ["陆沉", "林语"], "△陆沉神情冷淡，慢条斯理地放下咖啡杯。"),
    S("s3", 3, ["陆沉", "林语"], "△陆沉神情冷淡，慢条斯理地放下咖啡杯。"),
    S("s4", 4, ["陆沉", "林语"], "△陆沉修长的手指在桌面轻敲。"),
    S("s5", 5, ["林语", "陆沉", "林母"], "△林母脸色一变。"),
    S("s6", 6, ["林语", "陆沉"], "△陆沉看着她。"),
    S("s7", 7, ["陆沉", "林语"], "△两人对视。"),
]
dr = derive_present_characters(real)
missing = [s.order for s in real[1:] if "林母" not in
           (parse_characters(s.characters) + dr.get(s.id, []))]
ok(not missing, f"镜 2-7 全都有林母（原本缺 2/3/4/6/7）")
ok(dr.get("s2") == ["林母"] and dr.get("s4") == ["林母"], "缺的那几镜确实是补进来的")
ok("s5" not in dr, "本来就有林母的镜 5 不重复补")

print(f"\n连贯性推导：{_pass} ✅ / {_fail} ❌")
if _fail:
    sys.exit(1)
print("\n✅ 连贯性推导全部通过：离场判定要求同句（一个人走不会牵连整桌）；"
      "在场角色在同场连续戏内向后传播且遇离场即止；"
      "走位台账的脏数据一律降级为「没有台账」而不是把半残字段拼进提示词")
