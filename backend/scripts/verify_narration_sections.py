"""verify_narration_sections.py — 解说剧各版块的进程内验收

不签发任何令牌（CLAUDE.md）：直连路由函数 / 纯函数，自己构造入参。
只读为主；确需写入的用一个**当场新建、跑完就删**的临时项目，不碰任何真实项目。

覆盖的版块（对应 UI 从左到右的流程）：
  ① 剧本导入      strip_script_markup / smart_split_chapters / split_narration
  ② 拆镜时长      shot_seconds_cap（分辨率 × 视频模型 → 单镜上限）
  ③ 解说旁白切分  generate_narration（符号剥离、镜头补建、replace 幂等）
  ③b 声画对齐     旁白 == 该镜 script_ref（**内容层**，见下）
  ④ 解说音色      set_narration_voice
  ⑤ 字幕          bulk 落库 / replace_kind 幂等 / SRT 导出 / 项目级样式往返
  ⑥ 一键成片      收尾语义（不再服务端拼接）+ 逐集拆解回归 + RUNNERS 在册

## 为什么加了 ③b 与 audit_project（上一轮验收漏掉的那一层）

上一轮我报"全部通过"，用户随后在**我刚测过的那个项目**里看到严重声画错位。
原因是全部断言都停在"时间层"：e2e 里那条「字幕时间码与旁白时间码同源（无漂移）」
比较的是**我自己算的两个时间**，两者都源自库里同一个 duration_sec ——
只证明了内部自洽，从未比对过**旁白文本与该镜画面所依据的原文**。
于是"画面在演第 6 集、声音在念第 5 集"照样满分通过。

内容层断言从此是硬要求。

## 单独审计一个真实项目

    python3 scripts/verify_narration_sections.py --project 69f8276b1101
"""
import sys, os, json, re, inspect, subprocess

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

failed = 0


def ok(cond, label, detail=""):
    global failed
    if cond:
        print(f"  ✓ {label}" + (f"  ({detail})" if detail else ""))
    else:
        failed += 1
        print(f"  ✗ {label}" + (f"  — {detail}" if detail else ""))


def warn(label, detail=""):
    """只报不失败：用于"已知、且不影响观感"的偏差（见 audit_project 里的时长漂移）。"""
    print(f"  ⚠ {label}" + (f"  — {detail}" if detail else ""))


from app.db import get_session, Project, Shot, AudioClip, SubtitleClip
from app import routes_v2 as R
from app import script_import as SI
from app.media import DATA_DIR

cn = lambda s: sum(1 for ch in s if "一" <= ch <= "龥")
sp = lambda s: len(SI.spoken_chars(s))
PID = None


def _probe_seconds(url):
    """媒体地址 → 实测秒数；取不到返回 None（ffprobe 缺失/文件不在都算取不到）。"""
    if not url:
        return None
    p = DATA_DIR / str(url).replace("/fw/media/", "", 1).lstrip("/")
    if not p.exists():
        return None
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", str(p)],
            capture_output=True, text=True, timeout=20).stdout.strip()
        return float(out) if out else None
    except (OSError, ValueError, subprocess.SubprocessError):
        return None


def audit_project(pid: str, probe: bool = True) -> None:
    """对一个**真实项目**跑声画对齐的内容层不变式。

    这些断言各自直接对应一个已发生的事故：
      A1 集号分布   ← 一键成片不传 episode，全部镜头被打成 episode=1，
                      generate_narration 只看得见第 1 集正文（项目 930）
      A2 文本一致   ← 旁白曾由 split_narration 把整集正文**重新切一遍**，
                      与画面的 script_ref 是两套边界，对不齐是必然的
      A3 覆盖率     ← 整整一集的旁白凭空消失（930 实测 0.48）
      A4 读得完     ← 一镜 116 字要读 26s，而 720p 海螺 H3 只有 19.1s
      A5 锚点       ← start_shot_order 是普通整数不是外键，重排后会整体错位
      A6 时长漂移   ← 只告警：库里时长与真实文件差几秒，但成片实测只漂 0.35s
    """
    print(f"\n[audit] 项目 {pid}")
    with get_session() as s:
        proj = s.get(Project, pid)
        if not proj:
            ok(False, "项目存在", pid)
            return
        raw = proj.raw_script or ""
        mode = proj.production_mode or ""
        max_sec, mp = R.shot_seconds_cap(R.profile_of(proj))
        shots = [x for x in s.query(Shot).filter(Shot.project_id == pid)
                 .order_by(Shot.episode, Shot.order).all() if not x.disabled]
        clips = (s.query(AudioClip)
                 .filter(AudioClip.project_id == pid,
                         AudioClip.kind == "narration")
                 .order_by(AudioClip.start_shot_order).all())
        by_id = {x.id: x for x in shots}
        order_of = {x.id: x.order for x in shots}
        rows = [(c.text or "", c.source_shot_id, c.start_shot_order,
                 c.url, c.duration) for c in clips]
        shot_rows = [(x.id, x.order, x.episode, x.script_ref or "",
                      x.duration_sec, x.video_url) for x in shots]

    ok(mode == "narration", "是解说剧项目", mode or "(未设置)")
    ok(bool(shots) and bool(clips), "有镜头且有旁白",
       f"{len(shots)} 镜 / {len(clips)} 段")
    if not shots or not clips:
        return

    # A1 集号分布 == 剧本里真正有正文的集
    chapters = SI.smart_split_chapters(raw)
    want_eps = {c["order"] for c in chapters if not SI.too_short_to_break_down(c)}
    got_eps = {e for _i, _o, e, _r, _d, _v in shot_rows}
    ok(got_eps == want_eps, "镜头集号覆盖剧本全部正片集（拦「整集旁白消失」）",
       f"镜头 {sorted(got_eps)} vs 剧本 {sorted(want_eps)}")

    # A2 每段旁白 == 该镜 script_ref（剥标记后）
    bad = []
    for text, sid, _so, _u, _d in rows:
        ref = (by_id[sid].script_ref or "") if sid in by_id else None
        if ref is None:
            bad.append("旁白没有 source_shot_id")
            continue
        if SI.spoken_chars(text) != SI.spoken_chars(SI.strip_script_markup(ref)):
            bad.append(f"#{order_of.get(sid)}: 旁白「{text[:14]}…」"
                       f"≠ 画面「{ref[:14]}…」")
    ok(not bad, "每段旁白逐字等于该镜画面所依据的原文（拦声画错位）",
       f"{len(bad)} 处不一致：" + " | ".join(bad[:3]) if bad else "")

    # A3 覆盖率：剧本有多少字最终进了旁白
    want_chars = sum(sp(c["content"]) for c in chapters
                     if not SI.too_short_to_break_down(c))
    got_chars = sum(sp(t) for t, *_ in rows)
    cov = got_chars / want_chars if want_chars else 0.0
    ok(cov >= 0.98, "旁白覆盖剧本 ≥98%（没有整段文字没人念）",
       f"{got_chars}/{want_chars} = {cov:.2%}")

    # A4 每镜读得完
    cap_chars = int(max_sec * SI._CHARS_PER_SEC_SLOW)
    over = [(o, sp(r)) for _i, o, _e, r, _d, _v in shot_rows if sp(r) > cap_chars]
    ok(not over, f"每镜文字都读得完（≤{cap_chars} 字 / {max_sec:.1f}s @ {mp}MP）",
       f"{len(over)} 镜超长，最长 #{max(over, key=lambda x: x[1])[0]} "
       f"{max(o[1] for o in over)} 字" if over else "")

    # A5 锚点：旁白挂的镜号 == 它 source_shot 的实际 order
    mis = [f"#{so}≠#{order_of.get(sid)}" for _t, sid, so, _u, _d in rows
           if sid in order_of and order_of[sid] != so]
    ok(not mis, "旁白锚点与镜头 order 一致（重排后没有整体错位）",
       " ".join(mis[:5]) if mis else "")

    # A6 时长漂移：只告警。库里 duration_sec 与真实媒体有几秒累计差，
    # 但成片实测只漂 +0.35s（逐镜帧边界取整），改它反而会让画面与音频分家。
    if probe:
        drift = []
        for _t, sid, _so, url, dur in rows:
            real = _probe_seconds(url)
            if real is not None and abs(real - (dur or 0.0)) > 0.5:
                drift.append(f"#{order_of.get(sid)} 库{dur:.2f}s vs 实{real:.2f}s")
        if drift:
            warn(f"{len(drift)} 段旁白库内时长与真实文件差 >0.5s（不影响对齐，只记录）",
                 " ".join(drift[:3]))
        else:
            print("  ✓ 旁白库内时长与真实文件一致（±0.5s）")


if "--project" in sys.argv:
    audit_project(sys.argv[sys.argv.index("--project") + 1])
    print("\n" + ("✅ 项目审计通过\n" if failed == 0
                  else f"❌ 项目审计：{failed} 项失败\n"))
    sys.exit(0 if failed == 0 else 1)

print("\n══ 解说剧各版块进程内验收 ══")

# ---------------------------------------------------------------- ① 剧本导入
print("\n[1] 剧本导入 / 符号剥离 / 切分")
SCRIPT_BODY = (
    "△林语推开门，屋里一片漆黑。\n"
    "林语【冷笑】：你以为我不敢？\n"
    "陆沉(OS)：我等你这句话很久了。\n"
    "△两人对视，空气凝固。窗外的雨下得越来越大，\n"
    "远处传来一声闷雷，像是要把这栋老宅整个掀翻。\n"
)
RAW = "第1集\n" + SCRIPT_BODY

stripped = SI.strip_script_markup(SCRIPT_BODY)
ok(cn(stripped) == cn(SCRIPT_BODY), "剥离后汉字数不变",
   f"{cn(stripped)} vs {cn(SCRIPT_BODY)}")
ok("△" not in stripped and "【" not in stripped and "(OS)" not in stripped,
   "△ /【】/(OS) 全部消失")

chapters = R.smart_split_chapters(RAW)
ok(len(chapters) >= 1, "剧本能切出章节/集", f"{len(chapters)} 集")
ok(cn(chapters[0]["content"]) > 0, "第 1 集有正文")

segs = SI.split_narration(stripped, 3, max_sec=8.0)
ok(len(segs) >= 3, "旁白按句子边界切分", f"{len(segs)} 段")
ok(all(s.strip() for s in segs), "没有空段")
ok(cn("".join(segs)) == cn(stripped), "切分不丢字",
   f"{cn(''.join(segs))} vs {cn(stripped)}")
ok(all(SI.estimate_tts_seconds(s) <= 8.0 + 1e-6 for s in segs),
   "每段不超过单镜时长上限",
   f"最长 {max(SI.estimate_tts_seconds(s) for s in segs):.1f}s")

# ---------------------------------------------------------------- ② 拆镜时长
print("\n[2] 拆镜：单镜时长上限随分辨率变化")
caps = {}
for res in ("480p", "720p", "1080p"):
    sec, mp = R.shot_seconds_cap({"resolution": res})
    caps[res] = round(sec, 1)
    ok(sec > 0, f"{res} 有上限", f"{sec:.1f}s / {mp}MP")
ok(caps["480p"] >= caps["720p"] >= caps["1080p"],
   "分辨率越高单镜越短（显存包线）", json.dumps(caps))

# --------------------------------------------------------- ③④⑤ 临时项目
print("\n[3] 临时项目：旁白切分 → 音色 → 字幕 → SRT")
try:
    # id 由路由层现取（uuid4[:12]），模型没有 default——照同一套来
    import uuid
    PID = uuid.uuid4().hex[:12]
    with get_session() as s:
        s.add(Project(id=PID, title="__verify_narration__",
                      production_mode="narration", raw_script=RAW,
                      default_profile=json.dumps({"resolution": "480p"})))
        s.flush()
        for i in range(1, 3):
            s.add(Shot(id=uuid.uuid4().hex[:12], project_id=PID, order=i,
                       episode=1, script_ref=f"第{i}镜", duration_sec=5.0))
        s.commit()
    ok(PID is not None, "临时项目已建", PID)

    # ③ 旁白切分落库（只建段，不合成，不花钱）
    r = R.generate_narration(PID, R.GenNarrationIn(project_id=PID, replace=True))
    ok(r.get("created", 0) > 0, "旁白段已建", json.dumps(r, ensure_ascii=False))
    # 这两个镜头的 script_ref 只有「第1镜」三个字，覆盖不到剧本的 5%，
    # 属于"AI 没回填 script_ref 的老项目"——必须走按集重切的兜底路径，
    # 且**如实标出来**，不能静默走一条对齐质量完全不同的路。
    ok(r.get("mode") == "by_chapter_fallback",
       "script_ref 覆盖率过低时退回按集切分，并如实标 mode", str(r.get("mode")))

    with get_session() as s:
        clips = (s.query(AudioClip)
                 .filter(AudioClip.project_id == PID,
                         AudioClip.kind == "narration")
                 .order_by(AudioClip.start_shot_order).all())
        texts = [c.text or "" for c in clips]
        n_shots = s.query(Shot).filter(Shot.project_id == PID).count()

    ok(len(clips) > 0, "落库 kind=narration", f"{len(clips)} 条")
    ok(all("△" not in t and "【" not in t and "(OS)" not in t for t in texts),
       "落库文本已剥离符号（TTS 不会把符号念出来）")
    ok(cn("".join(texts)) == cn(stripped), "旁白总字数 == 剥离后剧本（一个字没丢）",
       f"{cn(''.join(texts))} vs {cn(stripped)}")
    # 段数多于原镜头数时必须补镜头，而不是把读不完的文字丢掉
    ok(n_shots >= len(clips), "镜头数已补足到不少于旁白段数",
       f"镜头 {n_shots} / 旁白 {len(clips)}（原建 2 镜）")
    ok(all(c.source_shot_id for c in clips),
       "每段旁白都锚定了镜头（成片时镜头原声才会被静音）")

    # 幂等：replace=True 再跑一次不应叠加
    R.generate_narration(PID, R.GenNarrationIn(project_id=PID, replace=True))
    with get_session() as s:
        n2 = (s.query(AudioClip)
              .filter(AudioClip.project_id == PID,
                      AudioClip.kind == "narration").count())
    ok(n2 == len(clips), "replace=true 幂等（不叠加）", f"{len(clips)} → {n2}")

    # ④ 解说音色
    rv = R.set_narration_voice(PID,
                               R.NarrationVoiceIn(voice_url="/fw/media/voice/x.wav"))
    ok(bool(rv.get("ok")) and rv.get("voice_url"), "解说音色可设置")
    with get_session() as s:
        ok(s.get(Project, PID).narration_voice_url == "/fw/media/voice/x.wav",
           "音色已落库")

    # ⑤ 字幕 bulk + SRT
    payload = R.SubtitleBulkIn(project_id=PID, replace_kind="subtitle", clips=[
        R.SubtitleClipIn(project_id=PID, text="第一条字幕", kind="subtitle",
                         start_shot_order=1, start_offset_sec=0.0, duration=1.5),
        R.SubtitleClipIn(project_id=PID, text="第二条字幕", kind="subtitle",
                         start_shot_order=1, start_offset_sec=1.6, duration=1.4),
        R.SubtitleClipIn(project_id=PID, text="跨到第二镜", kind="subtitle",
                         start_shot_order=2, start_offset_sec=0.2, duration=2.0),
    ])
    b = R.bulk_create_subtitle_clips(payload)
    ok(b.get("created") == 3, "bulk 落库 3 条", json.dumps(b))
    b2 = R.bulk_create_subtitle_clips(payload)
    ok(b2.get("deleted") == 3 and b2.get("created") == 3,
       "replace_kind 幂等（先删同类再建）", json.dumps(b2))

    # 手工字幕（normal）不该被自动对齐清掉
    R.bulk_create_subtitle_clips(R.SubtitleBulkIn(project_id=PID, clips=[
        R.SubtitleClipIn(project_id=PID, text="手打标题", kind="title",
                         start_shot_order=1, start_offset_sec=0.0, duration=2.0)]))
    R.bulk_create_subtitle_clips(payload)      # 再来一次 replace_kind="subtitle"
    with get_session() as s:
        kept = (s.query(SubtitleClip)
                .filter(SubtitleClip.project_id == PID,
                        SubtitleClip.kind == "title").count())
    ok(kept == 1, "replace_kind 只清同类，手工 title 不动", f"{kept} 条")

    srt = R.export_subtitles_srt(PID)
    body = srt.get("srt", "")
    ok(srt.get("count") == 4, "SRT 导出条数正确（3 自动 + 1 手工）",
       str(srt.get("count")))
    ok("-->" in body and "第一条字幕" in body, "SRT 内容与格式正确")
    starts = re.findall(r"(\d{2}:\d{2}:\d{2},\d{3}) -->", body)
    ok(starts == sorted(starts), "SRT 时间码单调递增", " ".join(starts))

    # 项目级字幕样式往返
    R.set_project_subtitle_style(PID, R.SubtitleStyleIn(style={
        "fontSize": 52, "color": "#ffee00", "position": "bottom",
        "fontFamily": "Noto Sans CJK SC", "fontSource": "bundled", "marginV": 80,
    }))
    got = R.get_project_subtitle_style(PID).get("style") or {}
    ok(got.get("fontSize") == 52 and got.get("fontFamily") == "Noto Sans CJK SC",
       "项目级字幕样式 GET/PUT 往返一致",
       json.dumps(got, ensure_ascii=False))

finally:
    if PID:
        with get_session() as s:
            s.query(SubtitleClip).filter(SubtitleClip.project_id == PID).delete()
            s.query(AudioClip).filter(AudioClip.project_id == PID).delete()
            s.query(Shot).filter(Shot.project_id == PID).delete()
            s.query(Project).filter(Project.id == PID).delete()
            s.commit()
        with get_session() as s:
            ok(s.get(Project, PID) is None, "临时项目已清理干净（不留垃圾数据）")

# --------------------------------------------------- ③b 声画对齐（内容层）
print("\n[3b] 声画对齐：旁白 == 该镜画面所依据的原文")
PID2 = None
try:
    import uuid
    # 两集、每集 ~250 字，且**镜头的 script_ref 就是正文的连续切片**——
    # 这正是修好后的拆解会产出的形状。用它来验"旁白严格跟着画面走"。
    EP1 = ("林语站在老宅门前，铁门锈得几乎推不开。她伸手一按，门轴发出刺耳的响声。"
           "屋里的味道和十二年前一模一样，霉味混着檀香。她把行李箱放在玄关，"
           "抬头看见墙上那张全家福，照片里父亲的脸被人用刀划掉了一半。"
           "她伸手去摸，指尖沾到一层灰。楼上忽然传来一声闷响，像有人踩空了台阶。"
           "林语屏住呼吸，一步一步往楼梯口挪。")
    EP2 = ("陆沉在书房里等了整整一夜，桌上的茶早就凉透了。他听见楼下的门响，"
           "却没有起身。十二年了，他一直在等这一天。脚步声停在门口，"
           "门被推开一条缝，光从走廊漏进来，把他半张脸照亮。"
           "林语看着他，一句话都说不出来。陆沉先开的口，声音很轻：你终于回来了。"
           "窗外的雨忽然大了起来，把整座城市砸得噼啪作响。")
    RAW2 = f"第1集\n{EP1}\n第2集\n{EP2}\n"

    PID2 = uuid.uuid4().hex[:12]
    # 720p + 海螺 H3：这正是项目 930 的档案，单镜 19.1s ≈ 85 字
    PROF2 = {"resolution": "720p", "video_model": "minimax-h3-ref2v"}
    cap2, _mp2 = R.shot_seconds_cap(PROF2)
    cap_chars2 = int(cap2 * SI._CHARS_PER_SEC_SLOW)

    def _slice(text, n):
        """把一集正文切成 n 份（模拟 AI 拆解的叙事节拍边界），只在句末下刀。"""
        import math as _m
        sents, buf = [], ""
        for ch in text:
            buf += ch
            if ch in "。！？":
                sents.append(buf)
                buf = ""
        if buf:
            sents.append(buf)
        per = _m.ceil(len(sents) / n)
        return ["".join(sents[i:i + per]) for i in range(0, len(sents), per)]

    with get_session() as s:
        s.add(Project(id=PID2, title="__verify_by_shot__",
                      production_mode="narration", raw_script=RAW2,
                      default_profile=json.dumps(PROF2)))
        s.flush()
        n = 0
        for ep, body in ((1, EP1), (2, EP2)):
            # 故意只切 2 份（每份 ~128 字，超过 720p 的 85 字上限）——
            # 就是要让 generate_narration 去做"读不完就拆成更多镜"这件事
            for ref in _slice(body, 2):
                n += 1
                s.add(Shot(id=uuid.uuid4().hex[:12], project_id=PID2,
                           order=n, episode=ep, script_ref=ref))
        s.commit()

    r2 = R.generate_narration(PID2, R.GenNarrationIn(project_id=PID2, replace=True))
    ok(r2.get("mode") == "by_shot", "走 by_shot 路径（旁白跟着画面走）",
       json.dumps(r2, ensure_ascii=False))
    ok((r2.get("coverage") or 0) >= 0.98, "旁白覆盖剧本 ≥98%",
       f"{r2.get('coverage')}")
    ok(r2.get("split_shots", 0) > 0, "读不完的镜头被拆成了更多镜",
       f"拆开 {r2.get('split_shots')} 镜，新增 {r2.get('added_shots')} 镜")

    # 内容层：逐条比对旁白与它所锚定镜头的 script_ref
    audit_project(PID2, probe=False)

    with get_session() as s:
        sh = (s.query(Shot).filter(Shot.project_id == PID2)
              .order_by(Shot.order).all())
        orders = [x.order for x in sh]
        eps = [x.episode for x in sh]
        refs = [x.script_ref or "" for x in sh]
    ok(orders == list(range(1, len(sh) + 1)), "镜号重排为连续 1..N",
       f"{len(sh)} 镜")
    ok(eps == sorted(eps), "集号随镜号单调不减（克隆镜插在原镜之后）")
    ok(max(sp(x) for x in refs) <= cap_chars2,
       f"每镜文字都读得完（≤{cap_chars2} 字 @720p H3）",
       f"最长 {max(sp(x) for x in refs)} 字")
    ok(sp("".join(refs)) == sp(EP1 + EP2), "拆镜前后一个字没丢",
       f"{sp(''.join(refs))} vs {sp(EP1 + EP2)}")

    # 幂等：再跑一次不该继续拆（上一次已经拆到读得完了）
    r3 = R.generate_narration(PID2, R.GenNarrationIn(project_id=PID2, replace=True))
    ok(r3.get("split_shots") == 0 and r3.get("added_shots") == 0,
       "replace 再跑一次不再重复拆镜（收敛）",
       f"split={r3.get('split_shots')} added={r3.get('added_shots')}")

finally:
    if PID2:
        with get_session() as s:
            s.query(AudioClip).filter(AudioClip.project_id == PID2).delete()
            s.query(Shot).filter(Shot.project_id == PID2).delete()
            s.query(Project).filter(Project.id == PID2).delete()
            s.commit()
        with get_session() as s:
            ok(s.get(Project, PID2) is None, "by_shot 临时项目已清理干净")

# ---------------------------------------------------------------- ⑥ 一键成片
print("\n[4] 一键成片：收尾语义")
from app import jobs as J

src = inspect.getsource(J.run_one_click_film)
ok("mix_audio" not in src, "不再服务端混音")
ok("concat" not in src.lower(), "不再服务端拼接（收尾交给桌面端）")
ok('"film": None' in src, "result.film 恒为 None（前端据此提示导出）")
ok("ready_shots" in src and "next_step" in src, "result 带镜头数与下一步提示")
ok(J.RUNNERS.get("compose") is None, "compose runner 已下线")
ok(J.RUNNERS.get("one_click_film") is not None, "one_click_film runner 在册")
ok(J.RUNNERS.get("auto_subtitles") is not None, "auto_subtitles runner 在册")

# 回归：一键成片必须**逐集**拆解。
# 它曾经自己另写一行 do_breakdown(整本剧本)，不传 episode，于是全部镜头
# 被打成 episode=1，generate_narration 只看得见第 1 集正文——项目 930
# 因此变成"画面在演第 6 集、声音在念第 5 集"。两条路径各写一遍正是成因，
# 所以这里既查"调了共用实现"，也查"没有绕过它直接调 do_breakdown"。
ok("breakdown_by_episode" in src, "一键成片走逐集拆解（拦「整集旁白消失」）")
# 只查调用点，不查注释——上面那段注释里就写着"不能直接 do_breakdown(整本剧本)"
ok("await do_breakdown(" not in src, "一键成片没有绕过共用实现直调 do_breakdown")
ok("episode=ch[\"order\"]" in inspect.getsource(J.breakdown_by_episode),
   "逐集拆解把集号传给了 do_breakdown")
ok("max_chars=max_chars" in inspect.getsource(J.breakdown_by_episode),
   "拆解时把「一镜最多多少字」带进了提示词（解说剧读得完）")
# `or` 会把前言的 episode=0 静默变成 1，让前言镜头混进第 1 集
bd = inspect.getsource(R.do_breakdown)
ok("ep = episode or 1" not in bd, "集号判空用 is not None，不用 or（前言 episode=0）")

print("\n" + ("✅ 解说剧各版块：全部通过\n" if failed == 0
              else f"❌ 解说剧各版块：{failed} 项失败\n"))
sys.exit(0 if failed == 0 else 1)
