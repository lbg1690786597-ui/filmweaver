/**
 * lib/formState.ts — 表单/乐观更新的纯判定逻辑
 *
 * 这两段判定原本内联在组件里，各自都踩过坑（F17/F18），提出来是为了
 * **能被脚本直接验证**：它们不碰 DOM、不碰 React，输入输出都是普通值。
 */

/** 乐观覆盖：`base` 记录"做覆盖时服务端是什么值"，用于判断 props 是否已追上 */
export type Override = { base: string | null; url: string } | null;

/** 首帧图该显示哪一张（F17）。
 *
 * 单镜重生首帧后要立即显示新图（不等整树 refreshDetail），但覆盖**必须能自愈**：
 * 列表 key 是 shot.id，卡片实例整个会话都活着，一个无条件的
 * `override ?? serverUrl` 会永久压住 props —— 之后批量首帧 job 重生了这一镜，
 * 服务端的新图永远显示不出来。
 *
 * 判据：服务端值还等于覆盖时记下的 base，说明 props 没追上，用覆盖；
 * 一旦服务端值变了（props 追上了，或别的任务改了它），立刻让服务端赢。
 */
export function effectiveUrl(override: Override, serverUrl: string | null): string | null {
  if (override && override.base === serverUrl) return override.url;
  return serverUrl;
}

/** 集数输入框的失焦判定结果 */
export type EpParse =
  | { kind: "save"; value: number }      // 合法且有变化 → 发 PATCH
  | { kind: "noop" }                     // 值没变 → 不打扰后端
  | { kind: "reject"; message: string }; // 非法 → 回填旧值并说明原因

/** 解析「起始集/结束集」输入（F18）。
 *
 * 原来是 `saveStage({ ep_from: Number(e.target.value) })`，三个坑都会被碰到：
 *   1) 没改值也发 PATCH → 每次都 onChanged() 重拉资产，点几下就是好几次全量刷新
 *   2) 删空 → `Number("")` 是 **0** → 后端 400「ep_from 不能小于 1」，
 *      用户看到一句技术报错，框里还是空的
 *   3) 填非数字 → `Number("abc")` 是 **NaN** → JSON.stringify 成 `null` →
 *      后端当成"没传该字段"直接忽略 → **静默无操作**：不报错、不保存，
 *      框里还留着 abc，下次打开弹窗才发现没改上
 */
export function parseEpisodeInput(raw: string, current: number): EpParse {
  const s = raw.trim();
  if (!s) return { kind: "reject", message: "集数不能为空" };
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
    return { kind: "reject", message: `集数要填 1 以上的整数（“${s}”无效）` };
  }
  if (n === current) return { kind: "noop" };
  return { kind: "save", value: n };
}
