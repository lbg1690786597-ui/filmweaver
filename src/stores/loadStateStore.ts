/**
 * loadStateStore — 读路径失败的可见化（批次 2 / 2.4）
 *
 * ## 要消灭的具体东西
 *
 * §4.4 点名的五处（外加同类的四处）长这样：
 *
 *     try { setSubtitles((await api.listSubtitleClips(id)).clips); }
 *     catch { /* 旧后端无此接口时静默 *\/ }
 *
 * 失败之后 state 停在**空数组**，于是时间轴上字幕轨是空的、音频轨是空的、
 * 素材池是空的 —— 而这跟"确实没有字幕"在界面上**长得一模一样**。
 * 用户的第一反应不是"加载失败了"，是**"我的编辑丢了"**。
 * 比这更糟的是接下来的动作：他会重做一遍，或者干脆重新生成，
 * 于是一次网络抖动变成了一次真实的数据覆盖。
 *
 * ## 为什么不是"把 catch 换成 say(...)"
 *
 * 一开始最省事的写法是每个 catch 里 `say(String(e))`。三个问题：
 *
 *   1. **会刷屏。** `refreshAudio()` 被 TTS 轮询每 5 秒调一次
 *      （`useAudioTrack.ts:32`）。断网时那就是每 5 秒一条 toast，
 *      而项目刚打开时五个资源会一起失败 —— 五条 toast 顶掉彼此。
 *   2. **toast 会消失，屏幕上的谎话不会。** 4 秒后提示没了，空轨道还在。
 *      用户回头再看一眼，看到的仍然是"我的字幕没了"。
 *   3. **`String(e)` 不是人话。** `get()` 以前抛的是 `new Error("404")`，
 *      显示出来就是 `Error: 404`。
 *
 * 所以做成两层：**持久的**顶栏指示器（未加载的项一直挂着，可重试）
 * + **一次性的** toast（让用户当场注意到）。前者纠正屏幕上的谎话，
 * 后者负责"被看见"。这与 2.1 的保存状态是同一套分工。
 *
 * ## 失败条目的存活期 = 那句谎话的存活期
 *
 * 条目不是"记到用户点掉为止"（那是 2.1 的写请求，一笔没存上就是永久损失），
 * 而是**跟着会撒谎的那个界面一起消失**：
 *
 *   · 项目级的五个（音频/字幕/转场/素材池/人物场景）挂在 App 的 hook 上，
 *     整个会话都在 → 条目也一直在，切项目时随注册一起清掉。
 *   · 面板级的四个（音效库/任务/历史版本/导出字幕）随面板卸载 → 面板一关，
 *     "空列表"这句谎话就不在屏幕上了，条目也该走。
 *
 * 反过来做（面板关了还挂着"任务列表未加载 · 重试"）会给出一个点了没用的
 * 重试按钮，比不提示更糟。
 *
 * ## 404 要与断网分开说
 *
 * 那些 catch 原本的理由是**真的**：老客户端连新后端、或反过来，接口可能不存在。
 * 但"不存在"和"连不上"用户能做的动作完全不同（一个是升级/该功能没有，
 * 一个是等网络+重试），混成一句"加载失败"等于没说。所以 `get()` 改抛
 * 带状态码的 `ApiError`，这里按状态码分类。
 */

import { create } from "zustand";

/** 有资格进顶栏的读路径。集中定义，好让文案只有一处、且拼错 key 编译期就报。 */
export const LOAD_LABELS = {
  // 项目级：挂在 App 的 hook 上，整个会话都在
  audio: "音频轨",
  subtitles: "字幕",
  transitions: "转场",
  clips: "素材池",
  stages: "人物与场景",
  // 面板级：随面板卸载一起清
  audioLib: "音效素材库",
  jobs: "任务列表",
  versions: "镜头历史版本",
  exportSrt: "导出用字幕",
} as const;

export type LoadKey = keyof typeof LOAD_LABELS;

/** 分类的意义是"用户接下来能做什么"，不是给错误归档 */
export type LoadKind = "network" | "auth" | "server" | "unsupported" | "unknown";

export interface LoadFailure {
  key: LoadKey;
  label: string;
  message: string;
  kind: LoadKind;
  /** 首次失败时刻 */
  at: number;
  /** 连续失败次数。轮询场景下用来区分"抖了一下"与"一直连不上" */
  count: number;
}

/** 从任意错误里取 HTTP 状态码。
 *
 *  刻意**不** `import { ApiError } from "../api"`：`api.ts` 顶层用了
 *  `import.meta.env`（Vite 的编译期替换），在 node/tsx 下是 `undefined`，
 *  谁 import 它谁就没法被验证脚本加载。2.2/2.3 已经踩过两次，
 *  §0.6 把这条记成了「验证手段决定了模块边界」。
 *  按 `status` 鸭子判断顺带把 `SaveHttpError` 和以后任何带状态码的错误一起覆盖了。 */
function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : undefined;
}

/** 把读失败翻成一句用户能据此行动的话。
 *
 *  与 `describeSaveError` 分开写而不是复用：措辞的落点不同 ——
 *  保存失败说的是「你的改动没存上」，加载失败说的是
 *  **「你看到的是空的，但那不代表真的空」**，后者才是本条要传达的信息。 */
export function describeLoadError(err: unknown, label: string): {
  message: string; kind: LoadKind;
} {
  const status = statusOf(err);
  if (status !== undefined) {
    if (status === 401 || status === 403) {
      return { message: `登录已失效，${label}没能加载 —— 请重新登录`, kind: "auth" };
    }
    if (status === 404) {
      // 这正是原来那些 catch 存在的理由，但它同样不该静默：
      // 用户需要知道"这里是空的"是因为功能不可用，而不是他的数据没了。
      return { message: `当前服务端没有「${label}」这个接口，该功能不可用`, kind: "unsupported" };
    }
    if (status >= 500) {
      return { message: `服务端错误（${status}），${label}没能加载`, kind: "server" };
    }
    return { message: `${label}加载失败（${status}）`, kind: "server" };
  }
  // fetch 在网络层失败时统一抛 TypeError（断网/DNS/证书/被拦截）
  if (err instanceof TypeError) {
    return { message: `连不上服务器，${label}没能加载 —— 请检查网络后重试`, kind: "network" };
  }
  const m = err instanceof Error ? err.message : String(err);
  return { message: `${label}加载失败：${m.slice(0, 100)}`, kind: "unknown" };
}

/** 两条 toast 之间的最小间隔。项目打开时五个资源会同时失败，
 *  逐条提示会互相顶掉（`useToast` 只有一个槽），且五条说的是同一件事。
 *  第一条提示 + 顶栏的「N 项未加载」已经把信息给全了。 */
export const ANNOUNCE_GAP_MS = 2500;

interface LoadState {
  failures: Partial<Record<LoadKey, LoadFailure>>;
  /** 重试回调。**不参与渲染**（放 state 里只为让指示器能取到），
   *  所以更新它时不制造新的 failures 引用。 */
  retries: Partial<Record<LoadKey, () => void>>;
  lastAnnouncedAt: number;

  /** 加载成功：清掉该资源的失败态（如果有） */
  noteLoaded: (key: LoadKey) => void;
  /** 加载失败。**返回 true 表示"值得当场提示用户一次"** —— 调用方据此决定是否 say。 */
  noteFailed: (key: LoadKey, err: unknown) => boolean;
  /** 注册重试动作；返回注销函数（面板卸载时调用，同时清掉该条失败） */
  registerRetry: (key: LoadKey, fn: () => void) => () => void;
  forget: (key: LoadKey) => void;
  /** 切项目 / 退出编辑器 */
  clearAll: () => void;
  __reset: () => void;
}

export const useLoadState = create<LoadState>((set, get) => ({
  failures: {},
  retries: {},
  lastAnnouncedAt: 0,

  noteLoaded: (key) => {
    // 没失败过就不要 set —— 每次成功刷新都 set 一遍会让订阅方无谓重渲染，
    // 而刷新在轮询场景下是每 5 秒一次。
    if (!get().failures[key]) return;
    set((s) => {
      const next = { ...s.failures };
      delete next[key];
      return { failures: next };
    });
  },

  noteFailed: (key, err) => {
    const label = LOAD_LABELS[key];
    const { message, kind } = describeLoadError(err, label);
    const prev = get().failures[key];
    const now = Date.now();
    // 只在"从好变坏"的那一刻考虑提示；持续失败只累加次数，不再打扰
    const isNew = !prev;
    const announce = isNew && now - get().lastAnnouncedAt > ANNOUNCE_GAP_MS;
    set((s) => ({
      failures: {
        ...s.failures,
        [key]: {
          key, label, message, kind,
          at: prev?.at ?? now,
          count: (prev?.count ?? 0) + 1,
        },
      },
      lastAnnouncedAt: announce ? now : s.lastAnnouncedAt,
    }));
    return announce;
  },

  registerRetry: (key, fn) => {
    set((s) => ({ retries: { ...s.retries, [key]: fn } }));
    return () => {
      set((s) => {
        const retries = { ...s.retries };
        delete retries[key];
        const failures = { ...s.failures };
        // 注销 = 那个会显示空列表的界面走了，谎话没了，提示也该走。
        // 留着会给出一个点了没反应的「重试」。
        delete failures[key];
        return { retries, failures };
      });
    };
  },

  forget: (key) => set((s) => {
    const failures = { ...s.failures };
    delete failures[key];
    return { failures };
  }),

  clearAll: () => set({ failures: {}, lastAnnouncedAt: 0 }),

  __reset: () => set({ failures: {}, retries: {}, lastAnnouncedAt: 0 }),
}));

/** 顶栏要显示的汇总。纯函数，好让 verify 脚本不起浏览器就能测。
 *
 *  措辞刻意用「未加载」而不是「加载失败」：用户要判断的是
 *  **"屏幕上这个空列表可不可信"**，「未加载」直接回答了这个问题。 */
export function loadSummaryOf(failures: Partial<Record<LoadKey, LoadFailure>>): {
  list: LoadFailure[]; text: string; kind: LoadKind | null;
} {
  const list = (Object.values(failures) as LoadFailure[])
    .slice()
    .sort((a, b) => a.at - b.at);
  if (!list.length) return { list, text: "", kind: null };
  if (list.length === 1) return { list, text: `${list[0].label}未加载`, kind: list[0].kind };
  // 多项一起失败基本都是同一个原因（断网 / 后端挂了），逐条列在 title 里
  return {
    list,
    text: `${list.length} 项数据未加载`,
    // 取最"可行动"的那一类：网络 > 登录 > 服务端 > 不支持
    kind: (["network", "auth", "server", "unsupported", "unknown"] as LoadKind[])
      .find((k) => list.some((f) => f.kind === k)) ?? "unknown",
  };
}
