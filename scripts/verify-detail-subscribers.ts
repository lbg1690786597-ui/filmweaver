/**
 * scripts/verify-detail-subscribers.ts — B2 的契约钉：detail 的字段只能有**一个**来源
 *
 * ## 这条钉住的是什么
 *
 * B1 把 `detail` 搬进 `projectStore` 之后，B2 要做的事只有一件：
 * 让消费组件**自己订阅 store**，而不是由 `App.tsx` 逐字段经 props 转运下去。
 *
 * 搬家本身不会因为少传一个字段就编译失败 —— 这正是它危险的地方：
 *
 *  · `assets={detail?.assets ?? []}` 这类写法里，**`?? []` 是合法的兜底值**。
 *    把 prop 漏在 App 里又忘了在组件里接上 store，类型检查过、构建过、
 *    界面照常渲染，只是资产候选池永远是空的（"归属到资产"里一个候选都没有）。
 *  · 反向漏更隐蔽：组件接了 store，App 那行 `assets={detail?.assets ?? []}`
 *    却忘了删。看着无害，实则是**两处事实来源**——将来谁改了 store 的取数口径
 *    （比如加一层过滤），App 那一行会把旧口径原样盖回去，而且改的人根本不知道
 *    还有这一行存在。B2 的整个价值就建立在这里：消灭"同一份数据两条路径"。
 *
 * 所以这条脚本同时钉**两个方向**：
 *
 *  ① `App.tsx` 里**不许再有**这些字段的 props 转运（正向：来源唯一）
 *  ② 每个已迁移组件内**必须有**对应的 store 订阅（反向：别把兜底删了）
 *
 * ## 为什么是"字段 × 组件"的白名单，而不是"扫所有 props"
 *
 * 只有**挂在 `detail` 上**的字段受这条约束。像 `shots={shots}` 这种
 * **不能**迁的反而必须留着 —— App 传的是 `stagedTransform.applyPending(...)`
 * 合成过的镜头（含尚未落盘的暂存变换），store 里根本没有那份数据，迁了就丢功能。
 * 列白名单是为了让"哪些能迁、哪些不能"这件事在源码里有个明确的账本，
 * 而不是靠下一个人凭感觉判断。
 *
 * 迁移进度见 `docs/PLAN-编辑核心架构收敛.md` §12.3（原稿 18 个组件，
 * 2026-09-11 实核后按"字段最窄的先迁"逐个落地）。
 */

import { readFileSync, existsSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (c: boolean, name: string, extra = "") => {
  if (c) { pass++; console.log(`   ✅ ${name}`); }
  else { fail++; console.log(`   ❌ ${name}${extra ? `  — ${extra}` : ""}`); }
};

const DESKTOP = "src";

/**
 * 每个已迁移组件：文件 + 它从 store 自取的字段 + 这些字段在 App 侧不许出现的 prop 名。
 *
 * `prop` 与 `field` 分开列是因为两者**经常不同名**：
 * · `LibraryPanel` 的资产 prop 叫 `assetsMeta`（历史命名，页面内还有别的 `assets`），
 *   对应的 detail 字段是 `assets`；
 * · `Rail` / `LibraryPanel` 等组件的生产模式 prop 叫 `productionMode`，
 *   字段是 `production_mode`。
 * 只按字段名去 App 里 grep 会两边都漏 —— 这正是这张表存在的理由。
 */
const MIGRATED: {
  file: string;
  /** App.tsx 里不许再出现的 prop 名（`= value` 形式的 JSX 属性） */
  forbiddenProps: string[];
  /** 组件内必须出现的 store 取值片段（宽松匹配：`s.detail?.<字段>` 或 `s.detail`） */
  storeReads: string[];
  /**
   * 这个组件的 `shots` **确实**从 store 自取（B2 已迁）。
   *
   * 缺省 `false` —— 那代表 `shots` 还在由 App 转运（暂存合成版，见 APP_ALLOWED），
   * 此时组件里出现 `p.shots ?? d?.shots` 是**对的**（store 那份排在后面兜底）。
   * 置 `true` 的组件则反过来：必须 `!== undefined`，否则显式传入的 `[]` 会被
   * store 的旧值盖住 —— 空镜头列表是真实状态，不是"没传"。
   */
  ownsShots?: boolean;
  /** 这个字段传 `null` 与"没传"同义（集合类）—— [3] 不强制 `!== undefined` */
  nullSafe?: string[];
  note: string;
}[] = [
  {
    file: "components/LibraryPanel.tsx",
    forbiddenProps: ["assetsMeta", "episodes"],
    storeReads: ["s.detail"],
    nullSafe: ["assetsMeta", "episodes"],
    note: "资产条目 + 分集列表",
  },
  {
    file: "features/media/MediaPanel.tsx",
    forbiddenProps: ["assets"],
    storeReads: ["s.detail?.assets"],
    nullSafe: ["assets"],
    note: "资产候选池（归属确认）",
  },
  {
    file: "features/editor/Rail.tsx",
    forbiddenProps: ["productionMode"],
    storeReads: ["s.detail?.production_mode"],
    note: "剧型（决定 ai-voice 的叫法）",
  },
  {
    file: "features/script/ScriptPanel.tsx",
    forbiddenProps: ["episodes"],
    storeReads: ["s.detail?.episodes"],
    nullSafe: ["episodes"],
    note: "分集列表",
  },
  {
    file: "features/settings/SettingsDialog.tsx",
    forbiddenProps: ["productionMode"],
    storeReads: ["s.detail?.production_mode"],
    note: "剧型（只读展示）",
  },
  {
    file: "components/ShotAdvanced.tsx",
    forbiddenProps: ["productionMode"],
    storeReads: ["s.detail?.production_mode"],
    note: "剧型（「继承：项目·X 模式」文案）",
  },
  {
    file: "features/generation/VideoPanel.tsx",
    forbiddenProps: ["productionMode"],
    storeReads: ["s.detail?.production_mode"],
    note: "剧型（高级区只读行）",
  },
  {
    file: "features/audio/AudioPanel.tsx",
    forbiddenProps: ["assets", "productionMode", "narrationVoiceUrl"],
    nullSafe: ["assets"],
    storeReads: ["s.detail"],
    note: "资产（音色候选）+ 剧型 + 解说音色",
  },
  {
    file: "features/editor/TopBar.tsx",
    forbiddenProps: ["projectTitle", "baseAspect", "productionMode"],
    nullSafe: ["projectTitle", "baseAspect"],
    storeReads: ["s.detail"],
    note: "项目名 / 画幅 / 剧型",
  },
  {
    file: "features/editor/LeftPanel.tsx",
    forbiddenProps: ["productionMode"],
    storeReads: ["s.detail?.production_mode"],
    note: "剧型（只用来改标题）",
  },
  {
    file: "features/editor/Player.tsx",
    forbiddenProps: ["baseAspect"],
    storeReads: ["s.detail?.base_aspect"],
    note: "画幅",
  },
  {
    file: "features/inspector/Inspector.tsx",
    forbiddenProps: ["projectTitle", "baseAspect", "maxDurationSec", "assets"],
    nullSafe: ["assets"],
    storeReads: ["s.detail"],
    note: "项目名 / 画幅 / 单镜时长上限 / 资产候选池",
  },
  {
    file: "features/subtitles/TextPanel.tsx",
    forbiddenProps: ["fromVideo"],
    storeReads: ["s.detail"],
    ownsShots: true,
    note: "镜头列表 + 真人剧判定",
  },
  {
    file: "features/timeline/Timeline.tsx",
    forbiddenProps: ["assets", "maxClipSec"],
    storeReads: ["s.detail?.assets"],
    nullSafe: ["assets"],
    note: "资产候选池 + 单镜时长上限（低频只读，单独窄订阅）",
  },
  {
    file: "features/export/ExportDialog.tsx",
    forbiddenProps: ["baseAspect", "projectTitle", "episodeTitles"],
    nullSafe: ["episodeTitles"],
    storeReads: ["s.detail"],
    note: "画幅 / 项目名 / 集标题（`shots` 例外：App 传的是暂存合成版）",
  },
  {
    file: "components/PreflightDialog.tsx",
    forbiddenProps: ["hasScript", "productionMode", "narrationVoiceUrl"],
    storeReads: ["s.detail"],
    note: "有无剧本 / 剧型 / 解说音色",
  },
];

/**
 * App.tsx 里**允许**继续传的、名字撞上白名单的 prop —— 每条都要写清为什么。
 *
 * 这是"漏改"与"故意不改"的分界线：没有这张表，下一个人分不清
 * `shots={shots}` 是 B2 没做完，还是本来就该这样。
 */
const APP_ALLOWED: { prop: string; component: string; why: string }[] = [
  {
    prop: "shots", component: "Timeline / Inspector 之外",
    why: "App 传的是 stagedTransform.applyPending(…) 合成过的镜头（含未落盘的暂存变换），store 里没有那份数据 —— 迁了会丢暂存态。",
  },
];

console.log("\n[1] 正向：App.tsx 不再转运这些 detail 字段");

const appSrc = readFileSync(`${DESKTOP}/App.tsx`, "utf8");
const appLines = appSrc.split("\n");

for (const m of MIGRATED) {
  for (const prop of m.forbiddenProps) {
    // 只在 App.tsx 的 JSX 属性位找 `prop={…}`（缩进后紧跟名字与 `=`），
    // 不去碰 `prop:` 这类对象字面量键 —— osPipeline 那种 hook 入参是合理的。
    const hits: number[] = [];
    appLines.forEach((l, i) => {
      const re = new RegExp(`^\\s+${prop}=\\{`);
      if (re.test(l)) hits.push(i + 1);
    });
    ok(
      hits.length === 0,
      `App.tsx 未传 ${prop}（→ ${m.file}）`,
      hits.length ? `仍在第 ${hits.join(", ")} 行转运，与本组件的 store 订阅构成两处事实来源` : "",
    );
  }
}

console.log("\n[2] 反向：每个已迁移组件确实订阅了 store");

for (const m of MIGRATED) {
  const p = `${DESKTOP}/${m.file}`;
  if (!existsSync(p)) { ok(false, `文件存在：${m.file}`); continue; }
  const src = readFileSync(p, "utf8");
  const imports = src.includes('from "../stores/projectStore"')
    || src.includes('from "../../stores/projectStore"');
  ok(imports, `${m.file} 引入了 projectStore`);
  for (const read of m.storeReads) {
    ok(src.includes(read), `${m.file} 从 store 读 ${read}`,
      `没找到 \`${read}\` —— 组件会永远拿到兜底值（空数组 / null），界面不报错但功能静默失效`);
  }
}

console.log("\n[3] 反向：可选 prop 的兜底写法与字段的 null 语义相符");

// 判据是**这个字段的 null 有没有独立含义**，不是"哪种写法更流行"：
//
//   · 标量 / 可空 / 布尔（`productionMode?: string | null`、`hasScript?: boolean`）
//     —— `null` 和 `false` 都是**真实状态**（"没设剧型"、"不是真人剧"）。
//     `p.productionMode ?? mode` 会把显式传入的 `null` 当成"没传"，
//     于是这个真实状态被 store 里的旧值盖住。判定"传没传"只能靠 `!== undefined`。
//
//   · 集合（`assets?: AssetInfo[]`）—— 传 `null` 与"没传"下游是同一个结果（都是空表），
//     两种写法等价；这里不强制。但**真要用 `??` 也得把 store 那份写进去**
//     （`p.assets ?? assets`），否则就是迁了一半。
//
// 分类显式登记在 MIGRATED[].nullSafe，不靠字段名猜。
const fallbackOffenders: { file: string; line: number; text: string }[] = [];
for (const m of MIGRATED) {
  const p = `${DESKTOP}/${m.file}`;
  if (!existsSync(p)) continue;
  readFileSync(p, "utf8").split("\n").forEach((l, i) => {
    for (const prop of m.forbiddenProps) {
      if (m.nullSafe?.includes(prop)) continue;
      // `shots` 仍在 App 天上转运（见 APP_ALLOWED）时，store 那份排在 `??` 后面就是兜底；
      // 这种字段不该出现 `p.shots`，App 那边已经禁掉了，这里只管"禁了的那些"。
      if (prop === "shots" && !m.ownsShots) continue;
      // `p.<prop> ?? ` / `p.<prop> || ` 都是错的兜底形态（`||` 还会把 `""` 当没传）
      if (new RegExp(`p\\.${prop}\\s*(\\?\\?|\\|\\|)`).test(l)
          && !new RegExp(`p\\.${prop}\\s*!==\\s*undefined`).test(l)) {
        fallbackOffenders.push({ file: m.file, line: i + 1, text: l.trim().slice(0, 90) });
      }
    }
  });
}
ok(
  fallbackOffenders.length === 0,
  "可空 / 布尔字段走 `!== undefined`（显式传入的 null / false / \"\" 能生效）；集合字段至少接上了 store 那份",
  fallbackOffenders.map((o) => `${o.file}:${o.line}  ${o.text}`).join("\n       "),
);

console.log("\n[4] 稳定空数组：`?? []` 不能出现在**已迁移字段的取值链**上（每次渲染换引用会打穿下游 memo）");

// `const assets = d?.assets ?? []` 每渲染造一个新数组，作为 useMemo/useEffect 的
// 依赖时**永远判不等** —— MediaPanel 的 useAttribution、ScriptPanel 的 load()
// 都会因此空转。必须提成模块级常量（`EMPTY_ASSETS` 这种）。
//
// 只查"这条赋值本身就在给已迁移字段兜底"，不查组件里所有 `?? []`：
// `byName.get(x) ?? []`（Map 查询）、`e.target.files ?? []`（DOM FileList）、
// `new Set(ov.remove ?? [])`（即时构造的局部量）都不作依赖，提成常量反而更难读。
const emptyArrayOffenders: { file: string; line: number; text: string }[] = [];
for (const m of MIGRATED) {
  const p = `${DESKTOP}/${m.file}`;
  if (!existsSync(p)) continue;
  const src = readFileSync(p, "utf8");
  const readNames = m.storeReads.flatMap((r) => {
    const mm = /s\.detail\??\.(\w+)/.exec(r);
    if (mm) return [mm[1]];
    // 只写 `s.detail` 的组件：字段名就是 forbiddenProps 自己（camel 转 snake 后比对）
    return m.forbiddenProps.map((f) => f);
  });
  for (const name of readNames) {
    // `const x = <...>assets... ?? []` —— 不要求变量名与字段名一致（有重命名）
    const re = new RegExp(`^\\s*const\\s+\\w+\\s*=\\s*[^;]*\\b${name}\\b[^;]*\\?\\?\\s*\\[\\]\\s*;`);
    src.split("\n").forEach((l, i) => {
      const t = l.trim();
      if (t.startsWith("*") || t.startsWith("//")) return;
      if (re.test(l)) emptyArrayOffenders.push({ file: m.file, line: i + 1, text: t.slice(0, 90) });
    });
  }
}
ok(
  emptyArrayOffenders.length === 0,
  "组件内没有 `某处 ?? []` 的字面空数组（应提成模块级常量）",
  emptyArrayOffenders.map((o) => `${o.file}:${o.line}  ${o.text}`).join("\n       "),
);

console.log("\n[5] 账本：App 侧残留的、名字撞白名单但**故意**保留的 prop 有据可查");

for (const a of APP_ALLOWED) {
  ok(true, `允许保留：${a.prop}（${a.component}）—— ${a.why}`);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} verify-detail-subscribers：${pass} 通过 / ${fail} 失败`);
console.log(`   已迁移组件 ${MIGRATED.length} 个（见 docs/PLAN-编辑核心架构收敛.md §12.3）\n`);
process.exit(fail === 0 ? 0 : 1);
