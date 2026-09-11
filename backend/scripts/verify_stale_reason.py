"""verify_stale_reason.py — 「已过期」原因的状态机进程内实测（P2-15）

## 这个脚本要防的是「片子重出了、内容还是旧的，全程零报错」

`Shot.stale` 原本是个裸 bool，四个写入点要求用户做的事完全不同（重拆本集 /
重出提示词 / 只需重出片），UI 却只有一句话、只给一个按钮。更要命的是
`run_shot_videos` **从来不清 `stale`**，而且会把 `shot.gen_prompt`（旧提示词）
当优化基线——用户改完剧本点「重新生成」，钱花了、片子换了、内容一字未变。

所以本脚本盯的不是"字段存不存在"，而是**四条真实分支**：

  ① 每个写入点写的原因，与它真正要求的补救动作一致（真路由、真库）
  ② 原因**只升不降**：先改正文(rebreak)、又改旁白时长(regen)，
     不能把"该重拆"这件事悄悄降级成"重出片就行"——重出片救不了错的切分
  ③ `needs_prompt_rebuild`：rebreak/reprompt/老数据(NULL) 必须丢弃旧 gen_prompt，
     只有 regen 可以照用。这一条就是本条目的病因所在
  ④ `clears_on_regen`：reprompt/regen 出片后要能洗掉；rebreak 与老数据不许洗
     （否则用户以为治好了，实际切分还是错的）

外加两道**静态交叉钉**（⑥）：新增的写入点若绕过 `app.stale`，或 jobs.py 里
那两处关键分支被人删掉，本脚本立即失败——它们没有任何运行时症状，只能这么守。

直连路由函数、自建临时行，**不签发任何令牌**；跑完删干净（finally）。

用法：`python3 backend/scripts/verify_stale_reason.py`（跑在 dev 库上）
"""
import re
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app import stale as st                                      # noqa: E402
from app.db import Project, Shot, get_session                     # noqa: E402
from app.routes_v2 import (EpisodeContentIn, ShotBreakdownIn,     # noqa: E402
                           patch_shot_breakdown, project_detail,
                           update_episode_content)

fails = []


def ck(name, actual, expected):
    good = actual == expected
    if not good:
        fails.append(name)
    print(f"  {'✅' if good else '❌'} {name}")
    if not good:
        print(f"      期望 {expected!r}  实际 {actual!r}")


def _raises(fn, exc) -> bool:
    """fn 是否抛出指定异常（写错原因必须当场炸，不能静默写进库）。"""
    try:
        fn()
    except exc:
        return True
    except Exception:  # noqa: BLE001 抛错了但类型不对，同样算不合格
        return False
    return False


class _Row:
    """mark_stale 只要求 .stale / .stale_reason 两个属性，纯逻辑用假行更快。"""

    def __init__(self, stale=0, reason=None):
        self.stale, self.stale_reason = stale, reason

    def __repr__(self):
        return f"({self.stale}, {self.stale_reason!r})"


# ---------- ① 纯状态机 ----------
print("\n① 状态机（纯函数）")
ck("严重度 rebreak > reprompt > regen",
   [st.rank(st.REBREAK) > st.rank(st.REPROMPT),
    st.rank(st.REPROMPT) > st.rank(st.REGEN)], [True, True])
# NULL 是"老数据/原因未知"，按最严重处理是全脚本的基调
ck("NULL 按最严重处理", st.rank(None), st.rank(st.REBREAK))

ck("needs_prompt_rebuild：只有 regen 可以照用旧提示词",
   {r: st.needs_prompt_rebuild(r)
    for r in (st.REBREAK, st.REPROMPT, st.REGEN, None)},
   {st.REBREAK: True, st.REPROMPT: True, st.REGEN: False, None: True})
ck("clears_on_regen：只有 reprompt/regen 能被出片洗掉",
   {r: st.clears_on_regen(r)
    for r in (st.REBREAK, st.REPROMPT, st.REGEN, None)},
   {st.REBREAK: False, st.REPROMPT: True, st.REGEN: True, None: False})
ck("after_reprompt：reprompt→regen，其余不动",
   [st.after_reprompt(x) for x in (st.REPROMPT, st.REBREAK, st.REGEN, None)],
   [st.REGEN, st.REBREAK, st.REGEN, None])
ck("label：三档都有人话，NULL 返回 None（前端回落兜底）",
   [bool(st.label(x)) for x in (st.REBREAK, st.REPROMPT, st.REGEN, None)],
   [True, True, True, False])
ck("未知原因直接报错（不许悄悄写进库）",
   _raises(lambda: st.mark_stale(_Row(), "script_changed"), ValueError), True)


# ---------- ② 只升不降 ----------
print("\n② 原因只升不降（16 种组合全枚举）")
LEVELS = [st.REGEN, st.REPROMPT, st.REBREAK]
downgrades = []
for old in LEVELS:
    for new in LEVELS:
        row = _Row(1, old)
        st.mark_stale(row, new)
        want = old if st.rank(old) >= st.rank(new) else new
        if row.stale_reason != want or row.stale != 1:
            downgrades.append((old, new, row.stale_reason))
ck("已标记的行：新原因更轻时保留旧原因", downgrades, [])
# 现实中最危险的那一对：改了正文之后旁白重算把它降级 → 用户再也看不到"该重拆"
row = _Row(1, st.REBREAK)
st.mark_stale(row, st.REGEN)
ck("改正文(rebreak)后旁白时长变(regen)：仍是 rebreak", row.stale_reason, st.REBREAK)
row = _Row(1, None)
st.mark_stale(row, st.REGEN)
ck("老数据(NULL)不被 regen 覆盖成可洗状态", row.stale_reason, None)
row = _Row(0, None)
st.mark_stale(row, st.REGEN)
ck("未标记的行：直接采用新原因", (row.stale, row.stale_reason), (1, st.REGEN))
row = _Row(1, st.REPROMPT)
st.clear_stale(row)
ck("clear_stale 同时清掉 stale 与原因（不留矛盾状态）",
   (row.stale, row.stale_reason), (0, None))


# ---------- ③④ 真路由 + 真库 ----------
pid = "vstale-" + uuid.uuid4().hex[:8]
sids = ["vstales%d-" % i + uuid.uuid4().hex[:6] for i in range(3)]
try:
    with get_session() as s:
        s.add(Project(id=pid, title="vstale 临时项目",
                      raw_script="第1集 临时\n甲：一句话。\n\n第2集 临时二\n乙：另一句。"))
        for i, sid in enumerate(sids):
            s.add(Shot(id=sid, project_id=pid, episode=1, order=9100 + i,
                       script_ref="原始拆解片段 %d" % i,
                       gen_prompt="旧提示词 %d" % i,
                       video_url="/fw/media/generated/fake_%d.mp4" % i,
                       duration_sec=5.0))
        s.commit()

    print("\n③ 写入点：改集正文 → rebreak（真路由）")
    r = update_episode_content(pid, 1, EpisodeContentIn(content="甲：改过的一句话。"))
    ck("响应报了受影响镜头数", r.get("stale_shots"), 3)
    with get_session() as s:
        rows = [(x.stale, x.stale_reason)
                for x in s.query(Shot).filter(Shot.project_id == pid)
                          .order_by(Shot.order).all()]
    ck("三镜全部 stale=1 且原因=rebreak", rows, [(1, st.REBREAK)] * 3)

    print("\n③ 写入点：改单镜拆解 → reprompt（真路由）")
    # 先洗干净，单独看这个写入点
    with get_session() as s:
        x = s.get(Shot, sids[0])
        st.clear_stale(x)
        s.commit()
    r = patch_shot_breakdown(sids[0], ShotBreakdownIn(script_ref="换掉的拆解片段"))
    ck("响应 changed 记了字段", r.get("changed"), ["script_ref"])
    ck("响应直接带出原因（前端不必再猜）",
       (r.get("stale"), r.get("stale_reason")), (True, st.REPROMPT))
    with get_session() as s:
        x = s.get(Shot, sids[0])
        ck("库里也是 reprompt", (x.stale, x.stale_reason), (1, st.REPROMPT))
        # ④ 这才是本条目的病因：reprompt 必须让出片弃用旧 gen_prompt
        ck("reprompt 下必须丢弃旧 gen_prompt", st.needs_prompt_rebuild(x.stale_reason), True)
        ck("旧 gen_prompt 仍在库里（不删，只是出片时不用它——用户还要能看见对比）",
           x.gen_prompt, "旧提示词 0")

    print("\n④ 真实叠加：改正文 + 单镜改拆解，仍应报最严重的那个")
    r = patch_shot_breakdown(sids[1], ShotBreakdownIn(location="新场景"))
    ck("已是 rebreak 的镜头不被降级为 reprompt", r.get("stale_reason"), st.REBREAK)

    print("\n⑤ API 曝面：detail 必须同时给出原因与人话")
    d = project_detail(pid)
    one = next(x for x in d["shots"] if x["id"] == sids[0])
    ck("detail 带 stale_reason", one.get("stale_reason"), st.REPROMPT)
    ck("detail 带 stale_hint（后端出文案，前后端不各拼一份）",
       one.get("stale_hint"), st.label(st.REPROMPT))
    ck("未过期的镜头 stale_hint 为 None",
       [x["stale_hint"] for x in d["shots"] if not x["stale"]] or [None], [None])
finally:
    with get_session() as s:
        s.query(Shot).filter(Shot.project_id == pid).delete()
        s.query(Project).filter(Project.id == pid).delete()
        s.commit()


# ---------- ⑥ 静态交叉钉 ----------
print("\n⑥ 静态交叉钉（这些错误没有运行时症状，只能这么守）")
src = {p.name: p.read_text(encoding="utf-8")
       for p in (ROOT / "app").rglob("*.py")}
# 除 stale.py 自己，谁都不许再直接给 stale 赋值 —— 绕过模块就绕过了"只升不降"
direct = []
for name, text in src.items():
    if name == "stale.py":
        continue
    for m in re.finditer(r"^\s*\w+\.stale\s*=\s*[01]", text, re.M):
        if "refs_stale" in m.group(0):
            continue
        direct.append(f"{name}:{text[:m.start()].count(chr(10)) + 1}")
ck("没有绕过 app.stale 的直接赋值", direct, [])
jobs = src["jobs.py"]
ck("run_shot_videos 保留了「stale 时弃用旧 gen_prompt」这条分支",
   bool(re.search(r"needs_prompt_rebuild\(stale_reason\)[\s\S]{0,900}?pregen = None", jobs)),
   True)
# needs_prompt_rebuild(None) 为 True（老数据按最严重处理），所以**必须**先判 stale：
# 漏了这一句就会给每一个正常镜头凭空加一次文本模型调用。
ck("而且先判了 shot_is_stale（否则全部正常镜头都会被判成要重建提示词）",
   "shot_is_stale and stale_mod.needs_prompt_rebuild(stale_reason)" in jobs, True)
ck("run_shot_videos 采用成功后会按原因清 stale",
   bool(re.search(r"clears_on_regen\(shot\.stale_reason\)\s*:\s*\n\s*"
                  r"stale_mod\.clear_stale\(shot\)", jobs)), True)
ck("旁白时长同步写的是 regen（最轻一档）",
   bool(re.search(r"shot\.video_url:[\s\S]{0,400}?mark_stale\(shot, stale_mod\.REGEN\)",
                  jobs)), True)
ck("重新生成提示词后会降级 reprompt",
   "stale_mod.after_reprompt(sh.stale_reason)" in jobs, True)
# 前端文案必须与后端逐字一致，否则同一状态两处说法不同
fe = (ROOT.parent / "desktop" / "src" / "lib" / "stale.ts").read_text(encoding="utf-8")
for r in (st.REBREAK, st.REPROMPT, st.REGEN):
    ck(f"前端兜底文案与后端一致（{r}）", st.label(r) in fe, True)


# ---------- ⑦ 存量体检 ----------
print("\n⑦ 存量体检（库里已有的那些对不对）")
with get_session() as s:
    allshots = s.query(Shot).all()
    dist: dict = {}
    for x in allshots:
        if x.stale:
            dist[x.stale_reason] = dist.get(x.stale_reason, 0) + 1
    # stale=0 却留着原因 = 矛盾状态：读的地方会按"有原因"分支走，但徽标不显示
    contradict = [x.id for x in allshots if not x.stale and x.stale_reason]
    unknown = [x.stale_reason for x in allshots
               if x.stale and x.stale_reason not in (None, st.REBREAK,
                                                     st.REPROMPT, st.REGEN)]
    leftover = [x.id for x in allshots if x.id.startswith("vstale")]
print(f"  共 {len(allshots)} 镜，其中过期 {sum(dist.values())} 镜，原因分布 {dist}")
ck("没有 stale=0 却带原因的矛盾行", contradict, [])
ck("没有取值以外的原因", unknown, [])
ck("没有历史遗留的临时行", leftover, [])

print("\n✅ 进程内实测全部通过" if not fails else f"\n❌ {len(fails)} 项失败：{fails}")
sys.exit(1 if fails else 0)
