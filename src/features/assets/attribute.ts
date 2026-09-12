/**
 * features/assets/attribute.ts — 上传素材的「这图是谁的」推断（3.11 A1）
 *
 * ## 它解决什么
 *
 * 在此之前，凡是走「上传自己的图」进项目的素材，**一律**被建成
 * `kind: "custom"` 的资产（`LibraryPanel.doCustomUpload`）。而
 * `Timeline.tsx` 对 custom 资产是**明确拒绝注入**的（toast「只有人物、场景资产
 * 可以注入镜头」）。于是用户上传的图全部被倒进了唯一一类不能用的资产里——
 * 「上传的图归错卡」和「资产拖不到轨道上」其实是同一个病根的两面。
 *
 * 归属信息的位置其实早就留好了：`Asset` 表本就有 `kind`(character/location/custom)
 * 和 `name` 两列，缺的只是「从文件名推断它属于谁」这一步。
 *
 * ## 为什么是纯函数
 *
 * 判定规则全是字符串活，没有 DOM、没有网络、没有 React。抽成纯函数意味着
 * `scripts/verify-attribute.ts` 能在 node 里把规则表逐条钉死——包括最容易写错的
 * 「最长匹配优先」和「两个角色都命中要交给人判」。判定错了的代价是用户拿到
 * 一张挂错角色的图（而且不一定会发现），所以规则值得被测试钉住。
 *
 * ## 与"不静默决定"的关系
 *
 * 本模块**只推断，不落库**。调用方拿到结果后必须出确认面板让用户过一眼——
 * 自动归属最坏的失败模式不是归错，而是归错了用户还不知道。所以这里除了
 * `guess` 还返回 `rule`（凭哪条规则判的，显示给用户看）、`confidence`
 * （多确定）和 `review`（是不是必须人工选）。
 */

/** 归属目标。`kind` 用字符串而不是字面量联合，是为了跟 `AssetInfo.kind` 对齐
 *  （后端给的就是 string），少一层转换就少一处类型对不上的机会。 */
export interface AttrTarget {
  /** 资产 id。null = 只有名字（资产还没建）或者压根没推断出来 */
  assetId: string | null;
  kind: string;          // character | location | custom
  name: string;
}

/** 命中了哪条规则——会原样显示在确认面板的行尾小字里 */
export type AttrRule =
  | "name"         // 文件名里出现了某个资产名/角色名（最长匹配优先）
  | "alias"        // 命中的是归一别名（小陆 → 陆明）
  | "keyword"      // 只判出了类别（定妆/日景…），没认出具体是谁
  | "path"         // 文件名没线索，是上级目录名给的
  | "none";

export interface FileLike {
  name: string;
  /** 相对路径（webkitRelativePath 或系统拖入的绝对路径）。
   *  缺省时只按文件名判，规则 5 不生效。 */
  path?: string;
}

/** 判定用的上下文。全部来自已有的 detail / stages / scenes 接口，后端不必改。 */
export interface AttributeContext {
  /** 项目内的资产（**已在用的**，墓碑不要传进来） */
  assets: { id: string; kind: string; name: string }[];
  /** 角色归一字典（`api.listCharacterAliases`） */
  characterGroups?: { canonical: string; members: { raw_name: string }[] }[];
  /** 场景归一字典（`api.listScenes`）：`{归一名: [原始写法...]}` */
  sceneGroups?: { canonical: string; members: { raw_name: string }[] }[];
}

export interface AttrCandidate {
  target: AttrTarget;
  rule: AttrRule;
}

export interface AttrResult {
  file: FileLike;
  /** 推断结果。rule === "none" 时为 null */
  guess: AttrTarget | null;
  rule: AttrRule;
  /** 0~1。规则优先级越高越接近 1 */
  confidence: number;
  /** 除了 guess 之外的其它可能（同名/同长命中） */
  candidates: AttrCandidate[];
  /** true = 推断不唯一或把握不足，**必须**用户手选，不许自动确认 */
  review: boolean;
  /** 认出了角色、且文件名带阶段线索（集数/造型词）→ 走造型阶段而不是改主图 */
  stageHint: { episode: number | null; stageName: string | null } | null;
}

/* ------------------------------------------------------------------ */
/* 词表（集中在这里，改词只改这一处）                                    */
/* ------------------------------------------------------------------ */

/** 角色向的关键词：只判类别时用，也能在"认出了人"时佐证。 */
const CHARACTER_WORDS = [
  "定妆", "造型", "形象", "三视", "三视图", "正面", "侧面", "背面", "半身", "全身",
  "特写", "角色", "人设", "服装",
];

/** 场景向的关键词。`空镜` 是"没有人物的环境镜"，天然属于场景。 */
const LOCATION_WORDS = [
  "场景", "日景", "夜景", "内景", "外景", "空镜", "俯瞰", "远景", "全景", "俯拍",
  "鸟瞰", "白天", "夜晚", "室内", "室外",
];

/** 造型阶段的关键词（认出了角色时才用）。 */
const STAGE_WORDS = [
  ...CHARACTER_WORDS,
  "战损", "婚礼", "校服", "便装", "礼服", "古装", "现代装", "受伤", "伪装",
  "变装", "老年", "少年", "青年",
];

/** 分隔符：切词用。`. _ -` 与空格是最常见的一批，中文间隔号/括号也常出现。 */
const SEPARATORS = /[\s._\-–—·|/\\()[\]（）【】]+/;

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 剥扩展名。
 *  ⚠️ 隐藏文件（`.gitignore`）的"扩展名"其实是整个名字，剥完是空串——
 *  空 needle 会被后续匹配跳过，不至于误归属，但没必要制造空 token。
 *  真的隐藏文件极不可能出现在素材拖入里，这里只是不想留下一个荒谬的返回值。 */
export function stripExt(name: string): string {
  if (/^\.[^.]*$/.test(name)) return name;
  return name.replace(/\.[^./\\]+$/, "");
}

/** 剥掉 Windows verbatim 前缀（`\\?\C:\a` → `C:\a`）。
 *  与 `src-tauri/src/lib.rs::strip_verbatim` 同一套规则——系统拖入的路径
 *  带着这个前缀进来，不剥的话按路径切词会多出一个 `\\?\C:` 段，
 *  正好也是最容易在"目录名匹配"上误命中的一段。两处必须同时改。 */
export function stripVerbatim(p: string): string {
  if (p.startsWith("\\\\?\\UNC\\")) return "\\\\" + p.slice("\\\\?\\UNC\\".length);
  if (p.startsWith("\\\\?\\")) return p.slice("\\\\?\\".length);
  return p;
}

/**
 * 把文件名切成便于匹配的形态。
 *
 * 除了按分隔符切词，还把**整串去掉分隔符**一起返回（`segs[]` 的末位）。
 * 理由：中文文件名常常不带分隔符（`陆沉定妆图.jpg`），只按分隔符切出来是
 * 一整段 `陆沉定妆图`，做子串匹配当然也能命中「陆沉」——但反过来，
 * 用户写 `陆-沉-定妆` 时刻意加了分隔符，我们也得能认出「陆沉」。
 * 所以匹配时**两种形态都试**：整串（去分隔符）优先，其次逐段、以及相邻段的拼接。
 */
export function tokenize(stem: string): string[] {
  const clean = stem.trim();
  const parts = clean.split(SEPARATORS).filter(Boolean);
  const joined = parts.join("");
  const out: string[] = [];
  if (joined) out.push(joined);
  for (const p of parts) if (p !== joined) out.push(p);
  // 相邻两段拼接：`陆` + `沉` → `陆沉`。中文名被误用连字符切开的补救。
  for (let i = 0; i + 1 < parts.length; i++) {
    const pair = parts[i] + parts[i + 1];
    if (pair !== joined) out.push(pair);
    // 三段也要：`陆明` + `第3集` 拆自 `陆-明-第3集` 这种
  }
  for (let i = 0; i + 2 < parts.length; i++) out.push(parts[i] + parts[i + 1] + parts[i + 2]);
  return out;
}

/** 集数线索：`第3集` / `EP03` / `S02E05` / `03集`。 */
export function episodeOf(text: string): number | null {
  const pats = [
    /第\s*(\d{1,4})\s*集/,
    // ⚠️ 不要在这里写 `\bEP`。`\b` 只在「词字符 ↔ 非词字符」之间成立，
    //    而 `_` **算**词字符：`si_EP03_a` 里 `_` 和 `E` 之间根本没有边界，
    //    `\bEP\s*0*(\d)\b` 在真实文件名上直接匹配不到（实测）。
    //    这里改成"前面不是字母/数字"——既放过 `_EP03`，又不会把 `PART3` 认成第 3 集。
    /(?<![A-Za-z0-9])EP?\s*0*(\d{1,4})(?![0-9])/i,
    /(?<![A-Za-z0-9])S\d{1,2}\s*E\s*0*(\d{1,4})(?![0-9])/i,
    /(?:^|[^0-9])0*(\d{1,4})\s*集/,
  ];
  for (const re of pats) {
    const m = text.match(re);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 候选池                                                              */
/* ------------------------------------------------------------------ */

interface PoolEntry {
  target: AttrTarget;
  /** 用来匹配的写法（资产名或别名）。**保留大小写**，比较时统一小写 */
  needle: string;
  /** true = 这条是别名（命中时 rule 记 alias） */
  alias: boolean;
}

/**
 * 把资产 + 两张归一字典摊成一张候选池。
 *
 * 别名要**双向**认：`SceneAlias` 里 `raw_name → canonical`，用户可能写任一侧
 * （`小陆.png` 和 `陆明.png` 都该归到「陆明」）。所以 raw 和 canonical 都进池子，
 * 都指向 canonical 那一条资产。
 *
 * 没有对应资产的归一名也进池子（assetId = null）：至少能告诉用户"这图看起来
 * 是场景「咖啡馆」的"，用户可以据此选择"新建这条资产"，比直接进待归属有用。
 */
export function buildPool(ctx: AttributeContext): PoolEntry[] {
  const out: PoolEntry[] = [];
  const byKey = new Map<string, AttrTarget>();

  for (const a of ctx.assets) {
    const key = `${a.kind}\u0000${a.name}`;
    const t: AttrTarget = { assetId: a.id, kind: a.kind, name: a.name };
    byKey.set(key, t);
    if (a.name) out.push({ target: t, needle: a.name, alias: false });
  }

  for (const g of ctx.characterGroups ?? []) {
    const t = byKey.get(`character\u0000${g.canonical}`)
      ?? { assetId: null, kind: "character", name: g.canonical };
    if (g.canonical) out.push({ target: t, needle: g.canonical, alias: false });
    for (const m of g.members) {
      if (m.raw_name && m.raw_name !== g.canonical) {
        out.push({ target: t, needle: m.raw_name, alias: true });
      }
    }
  }

  for (const g of ctx.sceneGroups ?? []) {
    const t = byKey.get(`location\u0000${g.canonical}`)
      ?? { assetId: null, kind: "location", name: g.canonical };
    if (g.canonical) out.push({ target: t, needle: g.canonical, alias: false });
    for (const m of g.members) {
      if (m.raw_name && m.raw_name !== g.canonical) {
        out.push({ target: t, needle: m.raw_name, alias: true });
      }
    }
  }

  // 长 needle 优先，保证"最长匹配优先"在遍历顺序上就先成立一次
  // （后面还会用长度显式比较，这里是双保险）
  out.sort((a, b) => b.needle.length - a.needle.length);
  return out;
}

/** 两个候选是不是同一个归属对象（同 kind 同名即同一条，assetId 有无不算差异） */
function sameTarget(a: AttrTarget, b: AttrTarget): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/* ------------------------------------------------------------------ */
/* 主函数                                                              */
/* ------------------------------------------------------------------ */

/**
 * 推断一批文件各属于谁。
 *
 * 规则按优先级从高到低（对应文档 §2.2 的六级表）：
 *
 * | 级别 | 规则 | 例子 |
 * |---|---|---|
 * | 1 | 文件名里出现资产名/角色名（**最长匹配优先**） | `陆沉_定妆.jpg` → 「陆沉」 |
 * | 1 | 命中归一别名 | `小陆.png` → 「陆沉」（若小陆是别名） |
 * | 2 | 只有类别关键词 | `定妆-02.jpg` → 角色（不知道是哪个） |
 * | 3 | 上级目录名命中 | `角色/陆沉/a.png` → 「陆沉」 |
 * | 4 | 都不中 | 进「待归属」 |
 *
 * ⚠️ **同级不可辨时不允许自动决定**：文件名叫 `陆沉与陆明.png` 时两人都是
 * 第 1 级、一样长，这时 `review = true`，`guess` 取第一个但**必须**让用户选。
 * 自动归属最坏的失败模式不是归错，是归错了用户不知道。
 */
export function attributeFiles(
  files: FileLike[],
  ctx: AttributeContext,
): AttrResult[] {
  const pool = buildPool(ctx);
  return files.map((f) => attributeOne(f, pool));
}

/** 单文件版（确认面板逐行改判时复用同一套规则，避免两处逻辑漂移） */
export function attributeOne(f: FileLike, pool: PoolEntry[]): AttrResult {
  const stem = stripExt(f.name);
  const lowerStem = stem.toLowerCase();
  const tokens = tokenize(stem);
  const lowerTokens = tokens.map((t) => t.toLowerCase());

  // 路径段（去掉文件名本身 + verbatim 前缀）
  const pathSegs = (f.path ? stripVerbatim(f.path) : "")
    .split(/[\\/]/).filter(Boolean).slice(0, -1)
    .map((s) => s.toLowerCase());

  const hits: { entry: PoolEntry; tier: number; by: string }[] = [];

  for (const e of pool) {
    const n = e.needle.toLowerCase();
    if (!n) continue;
    // tier 1：整串或任一切词形态包含它
    if (lowerTokens.some((t) => t.includes(n))) {
      hits.push({ entry: e, tier: 1, by: "name" });
      continue;
    }
    // tier 3：路径任一目录段包含它（判定上确实弱一级，但规则同一套）
    if (pathSegs.some((s) => s.includes(n))) {
      hits.push({ entry: e, tier: 3, by: "path" });
    }
  }

  // ---- 从命中里选：先按 tier，再按 needle 长度（最长匹配优先） ----
  let best: { entry: PoolEntry; tier: number } | null = null;
  for (const h of hits) {
    if (!best
        || h.tier < best.tier
        || (h.tier === best.tier && h.entry.needle.length > best.entry.needle.length)) {
      best = { entry: h.entry, tier: h.tier };
    }
  }

  // 同级、同长、但指向**不同**对象的 → 名字里同时出现了两个角色，必须人工选
  const tied = best
    ? hits.filter((h) => h.tier === best!.tier
        && h.entry.needle.length === best!.entry.needle.length
        && !sameTarget(h.entry.target, best!.entry.target))
    : [];

  const candidates: AttrCandidate[] = [];
  if (best) {
    for (const h of hits) {
      if (sameTarget(h.entry.target, best.entry.target)) continue;
      if (candidates.some((c) => sameTarget(c.target, h.entry.target))) continue;
      candidates.push({
        target: h.entry.target,
        rule: h.entry.alias ? "alias" : (h.tier === 3 ? "path" : "name"),
      });
    }
  }

  // ---- 关键词兜底：只判类别 ----
  const charWord = CHARACTER_WORDS.find((w) => lowerStem.includes(w.toLowerCase()));
  const locWord = LOCATION_WORDS.find((w) => lowerStem.includes(w.toLowerCase()));

  if (!best) {
    // 关键词也可能两侧都出现（`咖啡馆日景-人物站位`）——那也不算认出谁，只给类别
    const kind = charWord && !locWord ? "character"
      : locWord && !charWord ? "location"
      : charWord && locWord ? (locWord.length > charWord.length ? "location" : "character")
      : null;
    if (!kind) {
      // 「待归属」：明确返回 none，调用方把它放进待归属区，**不许**默默当 custom
      return {
        file: f, guess: null, rule: "none", confidence: 0,
        candidates, review: false, stageHint: null,
      };
    }
    return {
      file: f,
      guess: { assetId: null, kind, name: "" },
      rule: "keyword",
      // 只判出类别不给名字 → 把握低，且**必须**用户挑人（猜不出是谁就别说猜到了）
      confidence: 0.3,
      candidates,
      review: true,
      stageHint: null,
    };
  }

  const e = best.entry;
  const rule: AttrRule = e.alias ? "alias" : (best.tier === 3 ? "path" : "name");
  const confidence = best.tier === 1 ? 1 : best.tier === 3 ? 0.5 : 0.7;

  // ---- 阶段线索：认出了**角色**且文件名带集数/造型词 → 走造型阶段 ----
  let stageHint: AttrResult["stageHint"] = null;
  if (e.target.kind === "character") {
    const episode = episodeOf(stem);
    const stageName = STAGE_WORDS.find((w) => lowerStem.includes(w.toLowerCase())) ?? null;
    if (episode !== null || stageName !== null) {
      stageHint = { episode, stageName };
    }
  }

  return {
    file: f,
    guess: e.target,
    rule,
    confidence,
    candidates,
    // 有并列候选 → 必须人工选
    review: tied.length > 0,
    stageHint,
  };
}
