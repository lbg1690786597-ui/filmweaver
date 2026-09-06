/**
 * verify-clipedit.ts — 音频/字幕「拖 · 修剪 · 删」的规则层（批次 6 / 6.9）
 *
 * ## 这个脚本要防的是"把三套语义合并成一套"
 *
 * 6.9 之前，`Timeline.tsx` 的三个入口开头都是 `if (!clip.shotId) return;` ——
 * 音频/字幕拖不动。E3 审计（doc:1113）记的就是这个。看起来删掉那一行就完事，
 * 批次 3 差点这么干，停手的理由记在 doc:1754：删了之后是「拖得动、一刷新弹回去」，
 * 或者更糟 ——「拖得动、存下去了、3 分钟的背景音乐被截成 15 秒」。
 *
 * 所以真正的工作不是删 gate，是**把三种实体各自的语义写清楚**。而这三套语义
 * 极易被后来的人"顺手统一"，因为它们长得一模一样（都是拖边缘、都改时长）：
 *
 *   · 上下限的**依据**不同：镜头是"AI 一次能生成多长"（业务），
 *     音频是"素材就这么长"（物理），字幕是"没有素材，多长都行"。
 *     合并成一套常量 = 15 秒那个坑原样复发，且没有任何测试会红。
 *   · 拖**左**边缘做的是相反的事：镜头无缝顺排（左边缘不动、后面前移），
 *     音频锚在「第 N 镜 + 偏移」上（左边缘真的右移、后面不动）。
 *     合并 = 拖一次音频把整条音轨都拽过去。
 *   · 写通路是**三个不同的端点**，字段名都不一样
 *     （音频 clip_dur_sec / 字幕 duration / 镜头走 3.1 老路）。
 *
 * 这三件事全都不会在运行时报错，只会写出错的数据。所以逐条钉在这里。
 *
 * ## 另外两件被单独钉住的事
 *
 * ① **左边缘不是单向阀**。只允许正 delta 的话，剪掉的开头永远拖不回来 ——
 *    撤销栈跨不了会话，关掉软件再打开，那段音频的开头就永久没了
 *    （后端数据还在，UI 上没有任何路径能还原）。第 ⑤/⑥ 段钉的就是负余量。
 * ② **还原修剪写的是 `clearClip` 不是 `in=0`**。写 0 留下一个假窗口，
 *    等 TTS 重合成出更长的音频时会被这个窗口截回旧长度，用户完全看不出原因。
 *    这与 3.1 在镜头上踩过、并写进 `verify-trim.ts` 的是同一个坑。
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Clip, ClipEntity } from "../src/types/timeline";
import {
  durationBounds, clampDuration, trimOutPatch, trimInPatch, trimInDeltaBounds,
  movePatch, canDeleteFromTimeline, canDrag, hasTrim, clearTrimPatch,
} from "../src/features/timeline/clipEdit";
import { audioPlaySec, AUDIO_FALLBACK_SEC } from "../src/lib/audioClip";
import { MIN_CLIP_SEC, MIN_WINDOW_SEC, MAX_CLIP_SEC_FALLBACK } from "../src/features/timeline/trim";
import { normalize } from "../src/render/normalize";
import type { RenderOutput } from "../src/render/model";
// 只当类型用：`src/api.ts` 顶上读 `import.meta.env`，值导入会让本脚本在 node 下炸。
import type { ShotInfo, AudioClipInfo } from "../src/api";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

let failed = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const okEq = JSON.stringify(actual) === JSON.stringify(expected);
  if (!okEq) failed++;
  console.log(`  ${okEq ? "✅" : "❌"} ${name}`);
  if (!okEq) console.log(`      期望 ${JSON.stringify(expected)}  实际 ${JSON.stringify(actual)}`);
}
function ok(name: string, cond: boolean, detail = "") {
  if (!cond) failed++;
  console.log(`  ${cond ? "✅" : "❌"} ${name}`);
  if (!cond && detail) console.log(`      ${detail}`);
}

/** 造一个最小 Clip。必填字段一次性给齐，用例里只写"这一条要说的那几个字段"。 */
function clip(entity: ClipEntity, over: Partial<Clip> = {}): Clip {
  return {
    id: "x1", trackId: "t1", startSec: 10, durationSec: 5, entity,
    label: "x", disabled: false, isSpecial: false, status: "done",
    refsStale: false, characters: [],
    ...(entity === "shot" ? { shotId: "s1" } : {}),
    ...over,
  };
}

/* ================================================================== */
console.log("\n① audioPlaySec：时间轴宽度与成片长度的**唯一**公式");
// 两个调用者在两个层（时间轴 adapter + 导出 normalize）。公式抄两份的后果是
// 「时间轴上 5 秒、成片里 8 秒」——两边都不报错，只有导完看片才发现。

check("有窗口 → 用窗口长度", audioPlaySec({ duration: 180, clip_dur_sec: 12 }), 12);
check("无窗口 → 用素材总长", audioPlaySec({ duration: 180, clip_dur_sec: null }), 180);
check("窗口为 0 视同没有窗口（后端不该写 0，写了也不能让它变成零长片段）",
      audioPlaySec({ duration: 180, clip_dur_sec: 0 }), 180);
check("素材长度还没探出来 → 兜底常量，不是 0",
      audioPlaySec({ duration: 0, clip_dur_sec: null }), AUDIO_FALLBACK_SEC);
ok("兜底不是 0（0 宽的格子在时间轴上点不到、也拖不动）", AUDIO_FALLBACK_SEC > 0);

/* ================================================================== */
console.log("\n② durationBounds：三套上下限，依据互不相干");

check("镜头：下限 MIN_CLIP_SEC，上限取项目的生成上限",
      durationBounds(clip("shot"), 30), { min: MIN_CLIP_SEC, max: 30 });
check("镜头：没传项目上限时退回 MAX_CLIP_SEC_FALLBACK",
      durationBounds(clip("shot")), { min: MIN_CLIP_SEC, max: MAX_CLIP_SEC_FALLBACK });
// ⚠️ 这一条是本条目被推迟时记下的原坑：拿 15 秒去卡 3 分钟的 BGM。
check("音频：上限是素材长度，**不受**镜头生成上限影响（哪怕传了 15）",
      durationBounds(clip("audio", { sourceDurSec: 180 }), 15),
      { min: MIN_WINDOW_SEC, max: 180 });
check("音频：已剪掉开头 30s → 上限只剩 150s",
      durationBounds(clip("audio", { sourceDurSec: 180, clipInSec: 30 })),
      { min: MIN_WINDOW_SEC, max: 150 });
check("音频：素材长度未知 → 不设上限（宁可让后端夹，也不凭空编一个数字锁死）",
      durationBounds(clip("audio")), { min: MIN_WINDOW_SEC, max: Infinity });
check("音频：素材长度为 0（还没探出来）同样不设上限",
      durationBounds(clip("audio", { sourceDurSec: 0 })),
      { min: MIN_WINDOW_SEC, max: Infinity });
ok("音频：入点已越过素材末尾时上限不为负（坏数据也不能算出负长度）",
   durationBounds(clip("audio", { sourceDurSec: 10, clipInSec: 99 })).max >= MIN_WINDOW_SEC);
check("字幕：没有素材，也就没有上限",
      durationBounds(clip("subtitle"), 15), { min: MIN_WINDOW_SEC, max: Infinity });
ok("音频/字幕的下限比镜头低一个量级（0.1 vs 1）—— 拿镜头那套去卡字幕，"
   + "一句 0.5s 的短字幕就写不出来", MIN_WINDOW_SEC < MIN_CLIP_SEC);

console.log("\n  clampDuration");
check("低于下限抬到下限", clampDuration(0.01, { min: 0.1, max: 9 }), 0.1);
check("高于上限压到上限", clampDuration(99, { min: 0.1, max: 9 }), 9);
check("Infinity 上限下是 no-op（无需特判）",
      clampDuration(9999, { min: 0.1, max: Infinity }), 9999);

/* ================================================================== */
console.log("\n③ trimOutPatch：拖右边缘。三实体写**三个不同的字段**");

check("音频写 clipDurSec",
      trimOutPatch(clip("audio", { sourceDurSec: 180 }), 12),
      { entity: "audio", id: "x1", clipDurSec: 12 });
check("字幕写 durationSec（字幕没有窗口，duration 本身就是时长）",
      trimOutPatch(clip("subtitle"), 12),
      { entity: "subtitle", id: "x1", durationSec: 12 });
check("镜头写 clipDurSec（由 App 转交 3.1 老路，维持 duration_sec 不变式）",
      trimOutPatch(clip("shot"), 12, 30),
      { entity: "shot", id: "x1", clipDurSec: 12 });
check("音频：拖过素材末尾被夹回素材长度",
      trimOutPatch(clip("audio", { sourceDurSec: 180 }), 999),
      { entity: "audio", id: "x1", clipDurSec: 180 });
check("字幕：拖到 999s 不夹（没有上限就是没有上限）",
      trimOutPatch(clip("subtitle"), 999),
      { entity: "subtitle", id: "x1", durationSec: 999 });
check("没变就不发（空 PATCH = 一次白刷新；拖动时每帧一次就是刷新风暴）",
      trimOutPatch(clip("audio", { durationSec: 5, sourceDurSec: 180 }), 5), null);
check("变动小于半个量化步（<0.005s）也不发",
      trimOutPatch(clip("audio", { durationSec: 5, sourceDurSec: 180 }), 5.001), null);
check("结果取两位小数（后端也 round 2，不一致会让松手后回跳一丁点）",
      trimOutPatch(clip("audio", { sourceDurSec: 180 }), 12.3456),
      { entity: "audio", id: "x1", clipDurSec: 12.35 });

/* ================================================================== */
console.log("\n④ trimInPatch：拖左边缘 —— 三实体做的是**不同的事**");

// 音频：三件事必须一起发。少一件的症状分别是：
// 声音跑了 / 格子长度不对 / 格子原地不动。
check("音频：素材推进 + 变短 + 锚点偏移右移，三件一起",
      trimInPatch(clip("audio", {
        durationSec: 20, sourceDurSec: 180, clipInSec: 5, anchorOffsetSec: 2,
      }), 3),
      { entity: "audio", id: "x1", clipInSec: 8, clipDurSec: 17, startOffsetSec: 5 });
check("字幕：只有「晚点出现 + 短一点」，**没有** clipInSec（它没有素材可推）",
      trimInPatch(clip("subtitle", { durationSec: 20, anchorOffsetSec: 2 }), 3),
      { entity: "subtitle", id: "x1", durationSec: 17, startOffsetSec: 5 });
check("镜头：返回 null，交回 3.1 老路（老路有测试且正在用，不在这里重写）",
      trimInPatch(clip("shot", { durationSec: 20 }), 3), null);
check("剪到只剩下限就停（不会算出负长度）",
      trimInPatch(clip("audio", {
        durationSec: 5, sourceDurSec: 180, clipInSec: 0, anchorOffsetSec: 99,
      }), 999),
      { entity: "audio", id: "x1", clipInSec: 4.9, clipDurSec: 0.1, startOffsetSec: 103.9 });
check("没动就不发", trimInPatch(clip("audio", { anchorOffsetSec: 1 }), 0), null);

/* ================================================================== */
console.log("\n⑤ trimInDeltaBounds：左边缘**不是单向阀**");
// 只允许正 delta 的话，剪掉的开头永远拖不回来：撤销栈跨不了会话，
// 关掉软件再打开就永久没了。这一段钉的是"还得回来多少"。

check("音频：素材余量 5s、位置余量 9s → 最多还回 5s（取小）",
      trimInDeltaBounds(clip("audio", {
        durationSec: 20, clipInSec: 5, anchorOffsetSec: 9, sourceDurSec: 180,
      })).min, -5);
check("音频：位置余量更小时取位置余量（再往左要改锚到上一镜，那是「拖整段」）",
      trimInDeltaBounds(clip("audio", {
        durationSec: 20, clipInSec: 9, anchorOffsetSec: 2, sourceDurSec: 180,
      })).min, -2);
check("音频：没剪过（clipInSec 缺省）→ 没得还，min = 0",
      trimInDeltaBounds(clip("audio", { anchorOffsetSec: 9 })).min, 0);
check("字幕：素材余量恒为 0 → 左边缘只能往右（它没有素材可还）",
      trimInDeltaBounds(clip("subtitle", { anchorOffsetSec: 9 })).min, 0);
check("镜头：min 恒为 0（它压根不走这条路）",
      trimInDeltaBounds(clip("shot", { clipInSec: 5, anchorOffsetSec: 9 })).min, 0);
check("上限 = 时长 - 下限（剪完至少要剩得下一个合法片段）",
      trimInDeltaBounds(clip("audio", { durationSec: 20 })).max, 20 - MIN_WINDOW_SEC);

console.log("\n  负 delta 真的把素材还回来了");
check("往左拖 3s：入点回退、变长、左边缘左移",
      trimInPatch(clip("audio", {
        durationSec: 20, sourceDurSec: 180, clipInSec: 5, anchorOffsetSec: 9,
      }), -3),
      { entity: "audio", id: "x1", clipInSec: 2, clipDurSec: 23, startOffsetSec: 6 });
check("还过头被夹在余量上（不会出现负入点或负偏移）",
      trimInPatch(clip("audio", {
        durationSec: 20, sourceDurSec: 180, clipInSec: 5, anchorOffsetSec: 9,
      }), -999),
      { entity: "audio", id: "x1", clipInSec: 0, clipDurSec: 25, startOffsetSec: 4 });
ok("任何合法输入都不会产出负的 clipInSec / startOffsetSec",
   [-999, -5.5, -0.1, 0, 0.1, 7, 999].every((d) => {
     const r = trimInPatch(clip("audio", {
       durationSec: 20, sourceDurSec: 180, clipInSec: 5, anchorOffsetSec: 9,
     }), d);
     return !r || ((r.clipInSec ?? 0) >= 0 && (r.startOffsetSec ?? 0) >= 0
                   && (r.clipDurSec ?? 1) >= MIN_WINDOW_SEC);
   }));

/* ================================================================== */
console.log("\n⑥ movePatch：整段拖动 = 改锚点，换算**必须**来自调用方");
// 这条时间轴上曾同时存在三套各自累加镜头时长的换算，症状是
// "线画在一处、片段跳到另一处"。在这里再写第四套就是第四个会漂的真源。

const s2p = (sec: number) => ({ order: Math.floor(sec / 10) + 1, offsetSec: sec % 10 });
check("音频：换算结果原样写进锚点",
      movePatch(clip("audio"), 25, s2p),
      { entity: "audio", id: "x1", startShotOrder: 3, startOffsetSec: 5 });
check("字幕：同一套换算，只是 entity 不同",
      movePatch(clip("subtitle"), 25, s2p),
      { entity: "subtitle", id: "x1", startShotOrder: 3, startOffsetSec: 5 });
check("镜头：返回 null（拖镜头是「换位」，不是「移动到某一秒」）",
      movePatch(clip("shot"), 25, s2p), null);
check("负秒数先夹到 0 再换算（拖出时间轴左边缘不该算出负偏移）",
      movePatch(clip("audio"), -8, s2p),
      { entity: "audio", id: "x1", startShotOrder: 1, startOffsetSec: 0 });
ok("换算函数只被调用一次（调两次 = 两个可能不同的答案）",
   (() => {
     let n = 0;
     movePatch(clip("audio"), 25, (s) => { n++; return s2p(s); });
     return n === 1;
   })());

/* ================================================================== */
console.log("\n⑦ 能力判据 + 还原修剪");

check("音频可删", canDeleteFromTimeline(clip("audio")), true);
check("字幕可删", canDeleteFromTimeline(clip("subtitle")), true);
// 镜头删掉意味着要重新生成才拿得回来，所以它走的是「停用」。
check("镜头**不**从这里删（它走停用）", canDeleteFromTimeline(clip("shot")), false);
check("外部素材镜头也不从这里删（它在 Timeline 有自己的确认弹窗）",
      canDeleteFromTimeline(clip("shot", { isSpecial: true })), false);
check("音频可拖", canDrag(clip("audio")), true);
check("字幕可拖", canDrag(clip("subtitle")), true);
check("镜头不可拖（拖镜头是换位，走既有通路）", canDrag(clip("shot")), false);

check("有窗口 → 「还原修剪」可用", hasTrim(clip("audio", { clipDurSec: 12 })), true);
check("没窗口 → 不可用（没什么可还原）", hasTrim(clip("audio")), false);
check("窗口为 0 视同没有", hasTrim(clip("audio", { clipDurSec: 0 })), false);
// 字幕的 duration 就是时长，改短了就是改短了，没有"原长"可还 ——
// 给它一个还原按钮只能还成一个编出来的数字。
check("字幕没有「还原修剪」", hasTrim(clip("subtitle", { clipDurSec: 12 })), false);
check("镜头不走这条（它的还原在 3.1 的 clearWindowPatch）",
      hasTrim(clip("shot", { clipDurSec: 12 })), false);

// ⚠️ 与 3.1 同一个坑：写 in=0 留下一个"入点 0、长度=素材"的**假窗口**，
// 等 TTS 重合成出更长的音频时会被它截回旧长度，用户完全看不出原因。
check("还原写的是 clearClip，**不是** in=0 / dur=素材长",
      clearTrimPatch(clip("audio", { clipDurSec: 12, clipInSec: 3, sourceDurSec: 180 })),
      { entity: "audio", id: "x1", clearClip: true });
ok("还原 patch 里不含 clipInSec / clipDurSec（含了就等于写假窗口）",
   (() => {
     const p = clearTrimPatch(clip("audio", { clipDurSec: 12, clipInSec: 3 }));
     return !!p && p.clipInSec === undefined && p.clipDurSec === undefined;
   })());
check("没窗口时不发（免得白刷一次）", clearTrimPatch(clip("audio")), null);

/* ================================================================== */
console.log("\n⑧ 静态钉：三个入口真的按实体分流了");

const tl = read("src/features/timeline/Timeline.tsx");
ok("拖右边缘按实体分流",
   /beginTrim = useCallback[\s\S]{0,600}?clip\.entity !== "shot"[\s\S]{0,60}?beginTrimNonShot/.test(tl),
   "合流回镜头那套 = 3 分钟 BGM 被夹成 15 秒");
ok("拖左边缘按实体分流",
   /clip\.entity !== "shot"[\s\S]{0,60}?beginTrimInNonShot/.test(tl));
ok("拖整段按实体分流",
   /clip\.entity !== "shot"[\s\S]{0,60}?beginMoveNonShot/.test(tl));
ok("左边缘的可拖范围来自 trimInDeltaBounds（含负余量），不是写死的 0",
   tl.includes("trimInDeltaBounds(clip)")
     && /Math\.max\(db\.min, Math\.min\(db\.max, raw\)\)/.test(tl),
   "写死 Math.max(0, …) 的话，剪掉的开头在 UI 上永远拖不回来");
ok("非镜头段不共用镜头的右键菜单",
   /clip\.entity !== "shot"\) return otherMenuItems\(clip\)/.test(tl),
   "镜头菜单 11 项里有 10 项的判据是 !clip.shotId —— 音频右键会得到一整屏灰项");
ok("非镜头菜单里有「从时间轴移除」且接的是 onDeleteClip",
   /otherMenuItems[\s\S]{0,1400}?onDeleteClip\(clip\)/.test(tl),
   "onDeleteClip 声明了却没有调用点 = 这条通路只是看起来做完了");
ok("移除的措辞说「可撤销」（它真的可撤销，与镜头那条「不可撤销」不是一回事）",
   /从时间轴移除\$\{name\}段（可撤销）/.test(tl));
ok("「还原修剪」走 clearTrimPatch，且没窗口时是灰的",
   tl.includes("clearTrimPatch(clip)") && tl.includes("disabled: !hasTrim(clip)"));
// Timeline 只负责"鼠标位置 → 秒"。撤销一律在 App 入栈，两边都推的话
// 一次拖动进两条栈，Ctrl+Z 要按两下才回到原状（P2-2 记过这个坑）。
ok("三个 NonShot 处理器都不自己 pushUndo",
   !/beginTrimNonShot[\s\S]{0,3000}?beginMoveNonShot[\s\S]{0,900}?pushUndo/.test(tl));

const cv = read("src/features/timeline/ClipView.tsx");
ok("左手柄：字幕不受 canTrimIn 门禁（它没有 mediaUrl，照搬就永远不渲染）",
   /c\.entity === "subtitle" \|\| canTrimIn\(\{ video_url: c\.mediaUrl/.test(cv));
ok("左手柄：镜头仍要求已出片（3.1 的判据没有被放宽）",
   cv.includes("canTrimIn({ video_url: c.mediaUrl"));
ok("右手柄提示按实体分（对 3 分钟 BGM 说「1–15s」是纯粹的谎话）",
   /fw-clip-trim"[\s\S]{0,400}?c\.entity === "shot"[\s\S]{0,200}?c\.entity === "audio"/.test(cv));
ok("音频的右手柄提示报的是素材总长，不是镜头生成上限",
   /sourceDurSec \?\? dur\)\.toFixed\(1\)\}s＝素材总长/.test(cv));

const app = read("src/App.tsx");
ok("editClip 转发 clearClip",
   /patch\.clearClip \? \{ clearClip: true \} : \{\}/.test(app));
ok("clearClip 也算「动过窗口」（不算的话撤销不会把旧窗口写回去）",
   /touchedWindow = patch\.clearClip === true/.test(app));
ok("撤销回写：旧行没窗口时用 clearClip 而不是写 0",
   /hadWindow[\s\S]{0,160}?\{ clearClip: true \}/.test(app));
ok("删除是「重建」式撤销，且 redo 删的是**新** id",
   app.includes("curId = r.id") && /deleteAudioClip\(curId\)/.test(app),
   "redo 去删旧 id 会报 404，用户看到「重做失败」而那一段其实还在");
ok("重建后补发窗口 PATCH 的失败不上抛（段已经回来了，不该整条撤销判失败）",
   /clipDurSec: old\.clip_dur_sec,[\s\S]{0,120}?\} catch \{/.test(app));

const py = read("../backend/app/routes_v2.py");
ok("后端收 clear_clip", py.includes("clear_clip"));
ok("后端把两列写回 NULL 而不是 0",
   /clear_clip[\s\S]{0,400}?clip_in_sec = None[\s\S]{0,120}?clip_dur_sec = None/.test(py));
ok("窗口长度有成对夹持（入点变了但长度没变时，也要重新夹一次）",
   /room = max\(0\.1, src - float\(a\.clip_in_sec or 0\.0\)\)/.test(py));
// TTS 重合成出来的是**另一段音频**，旧窗口的坐标对它没有意义 ——
// 不清的话新旁白会被截回旧长度，且全程零报错。与 3.1 的「换素材必须清窗口」同源。
const jobs = read("../backend/app/jobs.py");
ok("TTS 写回时清掉修剪窗口",
   /status="done",\s*\n?\s*clip_in_sec=None, clip_dur_sec=None/.test(jobs));

/* ================================================================== */
console.log("\n⑨ 导出侧：修剪窗口真的传到了成片");
// ⚠️ 这一段是**运行时**的，不能只靠 ⑧ 的静态钉。理由：导出基线
// （`scripts/__baseline__/export-argv.json`）是从 `model.ts` 的 RenderClip
// 直接拼出来的，**根本不经过 `normalize()`** —— 也就是说 6.9 改了 normalize
// 的音频映射，基线一个字节都不会动。基线没动是**预期**的（它测的是编译器，
// 不是映射层），但代价是这一层没有任何既有网兜着，只能在这里补上。

const OUT: RenderOutput = {
  width: 1080, height: 1920, fps: 30, vcodec: "libx264", crf: 23, withAudio: true,
};
const shots = [{ id: "s1", order: 1, prompt: "", video_url: "/m/s1.mp4",
                 duration_sec: 30 }] as unknown as ShotInfo[];
const mkAudio = (over: Partial<AudioClipInfo>): AudioClipInfo => ({
  id: "a1", kind: "music", text: null, url: "/m/bgm.mp3", duration: 180,
  start_shot_order: 1, start_offset_sec: 2, voice_ref_url: null,
  status: "done", error: null, ...over,
} as AudioClipInfo);
const audioOf = (a: AudioClipInfo) =>
  normalize({ projectId: "p", shots, audioClips: [a], output: OUT })
    .tracks.filter((t) => t.kind === "audio").flatMap((t) => t.clips)[0];

const whole = audioOf(mkAudio({}));
check("没剪过：从素材第 0 秒起、取满全长",
      [whole.sourceInSec, whole.sourceDurationSec, whole.durationSec], [0, 180, 180]);
const cut = audioOf(mkAudio({ clip_in_sec: 12.5, clip_dur_sec: 8 }));
check("剪过：入点与长度都进了 RenderClip（否则导出仍是整段 3 分钟）",
      [cut.sourceInSec, cut.sourceDurationSec, cut.durationSec], [12.5, 8, 8]);
ok("轨上时长与取片长度一致（两者分叉 = 时间轴 8s、成片 180s）",
   cut.durationSec === cut.sourceDurationSec);
// mediaId 是"这是哪个文件"的身份，与"这次播多少"无关。
// 跟着修剪走的话，同一段 BGM 剪过之后会变成另一个 mediaId，缓存/去重全失效。
ok("mediaId 不随修剪变化（它是文件身份，不是播放长度）",
   cut.mediaId === whole.mediaId);
check("锚点偏移仍然照常生效（修剪不该顺手挪走起点）", cut.timelineStartSec, 2);

/* ================================================================== */
console.log(failed === 0
  ? "\n✅ 轻剪辑规则全部通过：三种实体各自的上下限/左边缘语义/写通路都没有被合并；"
    + "剪掉的开头拖得回来，还原走的是清窗口而不是假窗口"
  : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
