/**
 * saveStateStore — 顶栏「已保存」背后的真实状态（批次 2 / 2.1）
 *
 * ## 为什么需要它
 *
 * 改之前 `TopBar.tsx` 里那句 `<span>✓ 已保存</span>` 是**写死的字面量**，
 * 不接任何状态：断网、后端 500、token 过期，它照样显示「已保存」。
 * 这是最坏的一类 UI —— 它不是"没有反馈"，而是**主动给出错误的安全感**，
 * 用户据此关掉窗口，改动就真丢了。
 *
 * ## 为什么埋在 api.ts 而不是各个调用点
 *
 * 写请求散落在 25+ 处（`api.ts` 里 11 个 PATCH / 8 个 DELETE / 3 个 PUT / 3 个 POST，
 * 外加走 `post()` 的若干）。逐个调用点去 `try/catch` 再上报，**必然漏**，
 * 而漏掉的那个恰恰会退化成"假的已保存"——正是本条要消灭的东西。
 * 所以计数埋在**唯一的出口** `fetchTracked()` 上：默认所有写方法都算数，
 * 要豁免得显式声明。方向上宁可多报"保存中"，也不少报"失败"。
 *
 * ## 错误为什么不自动消失
 *
 * PATCH 是按字段发的，一次失败 = 那一笔改动没落库。后面别的字段保存成功
 * **并不能**把它救回来。所以 `lastError` 会一直留到用户主动点掉，
 * 让"有东西没存上"这件事必须被看见一次。
 */

import { create } from "zustand";

export interface SaveErrorInfo {
  /** 已经给用户看的人话（不是 raw stack） */
  message: string;
  /** Date.now() */
  at: number;
}

interface SaveState {
  /** 正在飞的写请求数 */
  inFlight: number;
  /** 最近一次写失败；用户点掉之前不会自动清 */
  lastError: SaveErrorInfo | null;
  /** 自上次清除以来累计的失败笔数（连续断网时用来说明"不止一笔"） */
  failedCount: number;
  /** 最近一次写成功的时刻，用于 title 里显示「已保存 · 14:32:05」 */
  lastSavedAt: number | null;

  beginWrite: () => void;
  /** err 为空表示成功。
   *  @param hint 6.8：调用方已经知道得更多时（这一笔是不是进了补发队列）
   *    给出的**替代**文案。`describeSaveError` 只看得见错误对象，
   *    分不出"暂存住了"和"彻底没了"，而这两句话对用户的含义正好相反。 */
  endWrite: (err?: unknown, hint?: string) => void;
  clearError: () => void;
  /** 仅供测试重置 */
  __reset: () => void;
}

/** 把 fetch/HTTP 的原始错误翻成用户看得懂的一句话。
 *
 *  `fetch` 在断网时抛的是 `TypeError: Failed to fetch` —— 直接显示给用户
 *  等于没说。这里把最常见的几类分开，因为**用户能做的动作完全不同**：
 *  断网要等网络、401 要重新登录、409 要刷新后重做（见 2.3 的乐观锁）。 */
export function describeSaveError(err: unknown): string {
  if (err instanceof SaveHttpError) {
    if (err.status === 401 || err.status === 403) return "登录已失效，改动未保存 —— 请重新登录";
    if (err.status === 409) return "该镜头已被其他窗口修改，改动未保存 —— 请刷新后重做";
    if (err.status >= 500) return `服务端错误（${err.status}），改动未保存`;
    return `保存被拒绝（${err.status}），改动未保存`;
  }
  // TypeError 是 fetch 在网络层失败时的统一表现（断网/DNS/证书/被拦截）
  if (err instanceof TypeError) return "连不上服务器，改动未保存 —— 请检查网络";
  const m = err instanceof Error ? err.message : String(err);
  return `保存失败：${m.slice(0, 120)}`;
}

/** 写请求拿到非 2xx 响应时用它带上状态码，好让上面那个函数分类。 */
export class SaveHttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const useSaveState = create<SaveState>((set) => ({
  inFlight: 0,
  lastError: null,
  failedCount: 0,
  lastSavedAt: null,

  beginWrite: () => set((s) => ({ inFlight: s.inFlight + 1 })),

  endWrite: (err?: unknown, hint?: string) => set((s) => {
    // Math.max 兜底：任何一次配对失误都不该把计数带成负数，
    // 负数会让「保存中」的判定 (inFlight > 0) 永久失灵。
    const inFlight = Math.max(0, s.inFlight - 1);
    if (err === undefined || err === null) {
      return { inFlight, lastSavedAt: Date.now() };
    }
    return {
      inFlight,
      failedCount: s.failedCount + 1,
      lastError: { message: hint ?? describeSaveError(err), at: Date.now() },
    };
  }),

  clearError: () => set({ lastError: null, failedCount: 0 }),

  __reset: () => set({ inFlight: 0, lastError: null, failedCount: 0, lastSavedAt: null }),
}));

/** 顶栏要显示的三态。抽成纯函数，好让 verify 脚本不起浏览器就能测。 */
export type SaveStatus = "saving" | "error" | "saved";

export function saveStatusOf(s: { inFlight: number; lastError: SaveErrorInfo | null }): SaveStatus {
  // 失败优先于"保存中"：断网时后续的写会不断进来又不断失败，
  // 若让 saving 压过 error，用户看到的是一个转个不停的圈，
  // 永远等不到那句"没存上"。
  if (s.lastError) return "error";
  if (s.inFlight > 0) return "saving";
  return "saved";
}
