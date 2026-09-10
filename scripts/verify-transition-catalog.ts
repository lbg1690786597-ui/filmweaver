/**
 * verify-transition-catalog.ts — 转场目录只有一份，且界面上不再露出 ffmpeg 的 id（3.9）
 *
 * ## 这个脚本要防的是「fadeblack」再次跑到用户脸上
 *
 * 转场的中文名表原先是 `EffectsPanel.tsx` 的私有常量。时间轴拿不到它，
 * 于是 `seamHint` 与转场弹窗直接把 `m.type` 拼进文案，用户在轨道上看到的是
 *
 *     #5 #6「fadeblack」3.7s（成片会缩短 3.7s）
 *
 * ——中文界面里突然冒出 ffmpeg 的内部标识符。这类问题的特点是**不报错**：
 * 类型检查过得去、功能也正常，只是难看且看不懂，只能靠断言守住。
 *
 * ① 目录自身自洽（id 唯一、名字非空、motion 齐全）
 * ② `seamHint` 六种状态的文案里都是中文名，一个 raw id 都不许出现
 * ③ 未知 id 原样返回，不造假名字也不抛错（库里存了个我们不认识的转场时，
 *    id 是唯一的排查线索，擦掉它比露出来更糟）
 * ④ 静态钉住：EffectsPanel 与 timeline 都不许再自建一份转场名表
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TRANSITIONS, transitionName, transitionDef }
  from "../src/features/effects/transitionCatalog";
import { seamHint } from "../src/features/timeline/transitions";
import type { SeamMarker } from "../src/features/timeline/transitions";

const SRC = join(import.meta.dirname, "..", "src");
let pass = 0;
let fail = 0;
const ok = (c: boolean, m: string) => {
  if (c) { pass++; console.log(`  ✅ ${m}`); }
  else { fail++; console.log(`  ❌ ${m}`); }
};

console.log("① 目录自洽");
{
  const ids = TRANSITIONS.map((t) => t.id);
  ok(new Set(ids).size === ids.length, "id 无重复");
  ok(TRANSITIONS.every((t) => t.name.trim().length > 0), "每条都有中文名");
  ok(TRANSITIONS.every((t) => !/^[a-z]+$/.test(t.name)),
     "名字不是纯小写英文（那就是忘了翻译）");
  ok(TRANSITIONS.every((t) => !!t.motion && !!t.motion.kind),
     "每条都有 motion（播放器预览要用）");
  ok(TRANSITIONS.every((t) => t.preview.includes("gradient")),
     "每条都有卡片色板");
  // 用户点名要的三个（剪映口径）
  ok(transitionName("fade") === "叠化", "fade → 叠化");
  ok(transitionName("fadeblack") === "闪黑", "fadeblack → 闪黑");
  ok(transitionName("fadewhite") === "闪白", "fadewhite → 闪白");
  // 闪黑/闪白必须是 flash 而不是 crossfade，否则预览演出来是叠化
  ok(transitionDef("fadeblack")?.motion.kind === "flash", "闪黑的预览是闪色而非叠化");
  ok(transitionDef("fadewhite")?.motion.kind === "flash", "闪白的预览是闪色而非叠化");
}

console.log("\n② seamHint 里没有 raw id");
{
  const states: SeamMarker["state"][] =
    ["ok", "missing", "disabled", "notAdjacent", "offMain", "tooLong"];
  for (const st of states) {
    const m = {
      id: "t1", type: "fadeblack", state: st, durationSec: 3.7, maxSec: 2,
      atSec: 10, fromOrder: 5, toOrder: 6, foldSec: 0,
    } as unknown as SeamMarker;
    const s = seamHint(m);
    ok(s.includes("闪黑"), `state=${st} 用中文名`);
    ok(!s.includes("fadeblack"), `state=${st} 不含 raw id`);
  }
}

console.log("\n③ 未知 id 的退化");
{
  ok(transitionName("wipetl") === "wipetl", "未知 id 原样返回，不编名字");
  ok(transitionDef("wipetl") === undefined, "未知 id 查不到定义（不造假对象）");
  const m = {
    id: "t9", type: "wipetl", state: "ok", durationSec: 1, maxSec: 2,
    atSec: 1, fromOrder: 1, toOrder: 2, foldSec: 0,
  } as unknown as SeamMarker;
  ok(seamHint(m).includes("wipetl"), "未知转场仍能生成文案（不抛错、不留空）");
}

console.log("\n④ 静态：不许再各存一份名表");
{
  const panel = readFileSync(join(SRC, "features/effects/EffectsPanel.tsx"), "utf8");
  ok(panel.includes("transitionCatalog"), "EffectsPanel 从共享目录取表");
  ok(!/id:\s*"fadeblack"/.test(panel), "EffectsPanel 里没有自建的 fadeblack 条目");

  const tl = readFileSync(join(SRC, "features/timeline/transitions.ts"), "utf8");
  ok(tl.includes("transitionName"), "transitions.ts 用 transitionName 出名字");
  ok(!/\$\{m\.type\}/.test(tl), "transitions.ts 不再把 m.type 直接拼进文案");

  const timeline = readFileSync(join(SRC, "features/timeline/Timeline.tsx"), "utf8");
  ok(!/\{seamEdit\.m\.type\}/.test(timeline), "转场弹窗标题不再直接渲染 m.type");
}

console.log(`\n转场目录：${pass} ✅ / ${fail} ❌`);
if (fail) process.exit(1);
console.log("\n✅ 转场目录全部通过：名表只有一份，"
  + "时间轴与特效面板读同一个来源；六种接缝状态的文案都是中文名；"
  + "未知 id 原样露出而不是被抹成「未知转场」");
