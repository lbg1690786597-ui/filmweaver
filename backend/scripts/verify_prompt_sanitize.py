#!/usr/bin/env python3
"""回归：视频提示词净化（拆【】字幕语法 + 补无文字约束）+ 框架层硬规则。

背景（2026-09-02 用户反馈）：成片里 ①镜头总在往人物推近 ②画面出现字幕。
根因两条，本脚本各守一条：
- 字幕：【】在 Seedance 语法里就是「烧字幕」，而我们的原稿拿它写表演提示与台词
  → providers.base.sanitize_video_prompt 确定性拆除 + 补否定约束（本脚本 1-6）
- 运镜：优化器框架 SKILL.txt 要求「每个时间切片一种运镜」
  → prompt_opt.service 末尾的「出品硬规则」覆盖它（本脚本 7-9）

用法：cd backend && python3 scripts/verify_prompt_sanitize.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.providers.base import sanitize_video_prompt  # noqa: E402
from app.prompt_opt.service import build_system_prompt  # noqa: E402

FAILS: list[str] = []


def check(name: str, cond: bool, detail: str = "") -> None:
    print(f"{'✅' if cond else '❌'} {name}" + (f"  {detail}" if detail else ""))
    if not cond:
        FAILS.append(name)


NO_TEXT = "无字幕，无文字，无水印，无logo"

# 1. 【】拆除：内容保留为普通描述，不丢语义
src = "中景，女人站在门口。【声音低沉无情】【不可能……你怎么可能查得出来？！】"
out = sanitize_video_prompt(src)
check("1 【】被拆除", "【" not in out and "】" not in out, out[:60])
check("2 【】内文字未丢失",
      "声音低沉无情" in out and "不可能" in out and "查得出来" in out)

# 3. 补否定约束
check("3 补入无文字约束", NO_TEXT in out)

# 4. 幂等：重复净化结果不变（jobs 重试 / 用户改后再生成都会二次经过）
check("4 幂等", sanitize_video_prompt(out) == out)

# 5. 已有等价约束时不重复追加
already = "中景，男人抽烟。无字幕，无文字。"
o5 = sanitize_video_prompt(already)
check("5 已有约束不重复追加", o5.count("无字幕") == 1, o5)

# 6. 空/None 原样返回（不能把 None 变成一句约束文本发给模型）
check("6 空值原样返回",
      sanitize_video_prompt(None) is None and sanitize_video_prompt("") == "")

# 6b. 连排【】不能黏成病句：原稿常见【表演提示】【台词】紧挨着
o6 = sanitize_video_prompt("中景。【声音低沉】【你查不出来】")
check("6b 连排括号补分隔符", "低沉，你查" in o6, o6)
check("6c 不产生连续逗号", "，，" not in o6, o6)
o6d = sanitize_video_prompt("女人站在门口【冷冷地】转身离开")
check("6d 句中括号两侧补分隔", "门口，冷冷地，转身" in o6d, o6d)
check("6e 空括号整体丢弃", sanitize_video_prompt("中景。【】") .startswith("中景。无字幕"),
      sanitize_video_prompt("中景。【】"))
check("6f 连排后仍幂等", sanitize_video_prompt(o6) == o6)

# 7-9. 框架层硬规则确实进了 system prompt，且排在 SKILL/参考文档之后
sp = build_system_prompt("seedance2")
idx_rule = sp.find("出品硬规则")
idx_skill = sp.find("技能说明 (SKILL)")
check("7 出品硬规则已注入", idx_rule > 0)
check("8 硬规则排在 SKILL 之后（冲突时后写的赢）",
      idx_rule > idx_skill > 0, f"skill@{idx_skill} rule@{idx_rule}")
check("9 三条规则齐全",
      "机位默认固定" in sp and NO_TEXT in sp and "禁止使用【】" in sp)

# ---- 英文稿（海螺 H3 产出通篇英文，挂中文约束权重不足）----
NO_TEXT_EN = "No subtitles, no captions, no on-screen text, no watermark, no logo"
en_src = ("[Shot 1] Medium shot, eye level. A middle-aged man sits at a desk "
          "under a dim lamp and slowly lifts his head toward the doorway.")
o_en = sanitize_video_prompt(en_src)
check("10 英文稿补英文约束", NO_TEXT_EN in o_en, o_en[-70:])
check("11 英文稿不补中文约束", "无字幕" not in o_en)
check("12 英文稿幂等", sanitize_video_prompt(o_en) == o_en)
# 英文稿内嵌中文台词（H3 规范 <d>[Chinese] …</d>）仍应判为英文
mixed = en_src + ' <d>[Chinese] 你怎么可能查得出来？</d>'
check("13 英文稿含中文台词仍补英文", NO_TEXT_EN in sanitize_video_prompt(mixed))
# 已有英文约束不重复补
check("14 已有英文约束不重复",
      sanitize_video_prompt("A man smokes. No subtitles.").count("No subtitle") == 1)

# ---- minimax_h3 框架层：必须点名推翻它自己那两条冲突条款 ----
sp_h3 = build_system_prompt("minimax_h3")
check("15 H3 硬规则已注入", sp_h3.find("出品硬规则") > sp_h3.find("技能说明 (SKILL)") > 0)
check("16 H3 点名推翻相机运动条款", "第 4 条" in sp_h3 and "相机运动" in sp_h3)
check("17 H3 点名推翻保留屏幕文字条款",
      "第 1 条" in sp_h3 and "第 9 条" in sp_h3 and "禁止画面出现任何文字" in sp_h3)
check("18 H3 要求英文约束句", NO_TEXT_EN in sp_h3)
check("19 seedance 点名推翻逐切片运镜", "只存在一种运镜方式" in sp)
check("20 两框架规则不串味", "第 4 条" not in sp and "只存在一种运镜方式" not in sp_h3)


print()
if FAILS:
    print(f"❌ {len(FAILS)} 项失败: {FAILS}")
    sys.exit(1)
print("✅ 全部通过")
