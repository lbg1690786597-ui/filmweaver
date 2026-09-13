/**
 * command.ts — 可撤销操作的**命令模型**（批次 C / C1）
 *
 * ## 要解决的问题：撤销栈里现在是不透明闭包
 *
 * C1 之前，栈里存的是 `{label, undo, redo}` 三个东西，两步操作放进去之后，
 * 除了**把它执行一遍**，没有任何办法知道它要干什么。直接后果：
 *
 *   - 做不了"撤销历史"面板 —— 用户不记得自己做过什么，但看得懂列表。
 *   - 写不了一条断言 —— 想验"正向再反向之后状态还原"，得先把整个 React
 *     应用跑起来，因为闭包在 App 里。
 *   - `redo` 是**可选的**：不写就静默塞一个"暂不支持重做"的桩。于是
 *     「暂不支持重做」这种缺口只能靠人肉发现，类型系统管不着。
 *
 * 命令模型把这三件事一次性解决：`kind` 给分类、`at` 给时间线、`affected`
 * 给影响面、`run`/`unrun` **都必须写**。**没有**「暂不支持」这个态。
 *
 * ## `reversible` 是尺子，不是待还的债
 *
 * 初稿把 `reversible: false` 写成"存量缺口的进度尺"。**实测下来这个说法是错的**：
 * C1 落地时用 TS 解析器数过实参个数（正则会被模板字符串里的逗号骗到），
 * App.tsx 的 18 处调用点**全都配了 `redo`**，store 里那一处已经是新形状。
 * 也就是说**一条不可重做的命令都没有**，`irreversibleCount()` 起点就是 0。
 *
 * 那为什么还留这个字段？因为它让「没有重做」这件事**第一次可以被表达**：
 * 以前 `redo` 缺失是类型上的静默，现在是一个显式布尔值、能落进命令、能被数出来。
 * 它是**给 C2 之后新写的命令用的**——谁再写出不带重做的操作，那就不再是"没人知道"，
 * 而是一个会出现在计数里的 1。
 *
 * ## 为什么 `run` / `unrun` 而不是 `apply` / `revert`
 *
 * 计划文档 §2.2 写的草案是 `apply` / `revert`。这里改名成 `run` / `unrun`，
 * 只为一件事：**在 18 个调用点上"撤销"和"重做"是并排写的**，`undo` /
 * `redo` 这对旧名字一眼能对上，`apply` / `revert` 得先在心里翻译一次。
 * `unrun` 与 `redo` 的反义关系也更直白。**语义与草案完全一致**
 * （`run` = 正向，`unrun` = 反向，两者必须互补），只是词换了，记在
 * 方案文档 §8 变更登记里。
 *
 * ## ⚠️ 稳定 id，不是 index（Shotcut PR #1466 的教训）
 *
 * `shots.order` 是整个项目里最热的可变值：删一个镜头，后面全部 -1；拖一次
 * 顺序，一段区间全变。**任何"第 N 条记录对应第 N 个镜头"的设计都必然指错**，
 * 而且错得安静 —— 撤销后看着像是"撤了但撤错了行"，比报错难查得多。
 *
 * 所以命令里的 `affected.shots` 一律是 **uid**（镜头 id），栈本身的定位
 * 也一律用 `id`（本模块的 `find`），全模块**不提供按位置定位某条命令的 API**。
 * 唯一按位置取的是 `peek()` —— 那是"栈顶"这个语义本身，不是"第 N 个镜头"。
 *
 * ## 为什么单独一个无依赖模块
 *
 * 与 `lib/shotRev.ts` / `lib/stagedWrite.ts` 同理：`api.ts` 顶上是
 * `import.meta.env`，在 node 下取不到，验证脚本 import 不进来。命令模型
 * 必须能被 `verify-command.ts` 在 node 下真的跑一遍（正向→反向还原、
 * 反向抛异常时栈不被吃掉），而不是靠读代码相信它。
 */

// ⚠️ 与 `agent/ledger.ts` 的依赖方向：**命令栈 → 台账**（单向）。
// 入栈时顺手记一笔是刻意的 —— "AI 改了东西但台账里查不到"这种缺口，
// 靠"每个调用方自觉记账"是堵不住的（18 个调用点，漏一个就漏一条），
// 所以记账是 `push` 的**副作用**，不提供手动入口。
// 反方向（台账 → 命令栈）**不存在**：ledger.ts 只 `import type { CommandScope }`，
// 类型在编译后擦除，运行时没有环。
import { newTurnId, record, clear as ledgerClear } from "./agent/ledger";

/** 一条命令改的是**哪一类**东西。给撤销历史面板分组用，也给将来按类限流用。 */
export type CommandKind =
  | "shot"        // 增删镜头、改时长/顺序、启停用、分割、划区间
  | "transform"   // 画面 / 调色 / 特效 / 马赛克
  | "transition"  // 转场增删改
  | "asset"       // 外部素材轨的增删移
  | "audio"       // 音频段
  | "subtitle"    // 字幕段
  | "track"       // 轨道开关（锁定 / 隐藏 / 静音 / 独奏）
  | "other";      // 还没归类 —— 见下方 `commandKindOf`

/**
 * 命令是**谁**发起的（批次 E1，PLAN §2.5.3 ①）。
 *
 * 人还是 AI、以及是 AI 的**哪一轮**。这一栏决定两件事：
 *   - 撤销历史怎么分组显示（`AI：按节奏重排第 3 场（改动了 12 个镜头）`）；
 *   - 撤销时按不按 `turnId` 合并（见 `lib/agent/ledger.ts` 文件头）。
 *
 * ⚠️ 为什么是**对象**而不是 `by: "user" | "agent"` 加一个可选的 `turnId`：
 * 后者允许 `by: "agent"` 而 `turnId` 缺失这个非法态存在，运行期再判一次。
 * 判别联合让"Agent 的命令一定有 turnId"成为类型事实 ——
 * 台账、分组、`E4` 的分组撤销全都建立在这条事实上。
 */
export type CommandOrigin = { by: "user" } | { by: "agent"; turnId: string };

/** 影响面。**用 uid**，不用 order / index（见文件头）。 */
export interface CommandScope {
  shots?: string[];
  assets?: string[];
}

/** 命令执行时能拿到的东西。
 *
 *  目前是空的：存量 18 个命令的闭包各自捕获了自己需要的一切（镜头 id、旧值、
 *  写入函数），这正是 C1 要维持的现状 —— C1 只负责**把形状立起来**，逐个
 *  迁移其中需要 ctx 的那几个是 C2 的事。
 *
 *  留一个空接口而不是干脆不传参数，是为了 C2 迁移时**不用再改一次签名**
 *  （那会再动一遍 18 个调用点）。E3 的 dry-run 也会用到它。
 */
export type EditCtx = Record<string, never>;

export interface EditCommand {
  /** 稳定 id（`uid()` 生成）。⚠️ 不是 index —— 理由见文件头 */
  id: string;
  /** 给用户看的一句话，如「镜头 #3 移到 #5」 */
  label: string;
  kind: CommandKind;
  /** 入栈时刻（`Date.now()`）。撤销历史面板按它排序、显示"几分钟前" */
  at: number;
  /** 影响面（可推导）。C1 阶段长度可为 0，C2 逐个补齐 */
  affected: CommandScope;
  /**
   * 这条命令能否**真的重做**。
   *
   * C1 之前，调用方不传 `redo` 时 `useUndo` 会静默塞一个「暂不支持重做」的
   * 桩 —— 按钮是亮的、点了只出一行提示，而且**没有任何办法知道栈里有多少
   * 条这种命令**。改成显式布尔值之后：
   *   - `verify-command.ts` 能把「不可重做的条数」数出来；
   *   - C3 的历史面板可以据此把重做按钮画灰，而不是点完才告诉用户不行。
   *
   * ⚠️ **别指望这个数现在在降。** C1 实测 18 处旧调用点全都配了 `redo`，
   * 起点就是 0 —— 它不是一条还款曲线，是给新命令用的一把尺子
   * （详见文件头「尺子，不是待还的债」一节）。
   */
  reversible: boolean;

  // ── E1（PLAN §2.5.3）：让命令**能被 AI 调用**，也能被人读懂 ─────────────

  /** 谁发起的。人缺省 `{by:"user"}`；Agent 发起时**必须**带 `turnId`。 */
  origin: CommandOrigin;
  /**
   * 给 **AI** 读的一句话说明（`desc`）。与 `label` 分开的理由：
   * `label` 是写给用户看的（「镜头 #3 移到 #5」），会被压缩得很短；
   * `desc` 是写给模型看的，要说清"这个操作什么时候该用、边界在哪"。
   * 一个字符串同时服务两种读者，最后一定两边都不满意。
   */
  desc?: string;
  /**
   * 这条命令**执行时实际用到的入参**（纯数据，可 JSON 序列化）。
   *
   * ⚠️ 为什么要存：撤销历史面板光有 `label` 只能说"改了画面"，
   * 有 `params` 才能说"亮度 1.2 → 1.5"。更要紧的是 E5 —— 能力表的
   * `params` schema 与这里的实际值**必须能对上**，否则模型照 schema
   * 填的参数和人手填的对不上号，验证脚本就没法比对。
   *
   * ⚠️ **必须是纯数据**：不放函数、不放 class 实例。E5 要把能力表连同
   * 参数原样序列化给模型看，混进函数会在 `JSON.stringify` 时静默消失
   * （函数被丢掉、Map 变 `{}`），而这里丢掉的东西没人会发现。
   */
  params?: Record<string, unknown>;
  /**
   * 能不能交给 Agent 调用。**缺省 false** —— 白名单，不是黑名单。
   *
   * 为什么必须缺省关闭：能出现在撤销栈里的命令有 18 个入口，绝大多数是
   * 人机交互的产物（比如"把这段拖到那里"本身就依赖鼠标位置）。默认全开
   * 等于把整个命令面暴露给模型，其中任何一个写错，用户看到的是"AI 自己
   * 乱动了我的工程"。反过来，默认全关最坏也就是"这个功能 AI 还不会"，
   * 那是可接受的、能被渐进修好的状态。
   */
  agentCallable?: boolean;

  /** 正向。**必须**能独立完成一次完整的改变（含落库） */
  run: (ctx: EditCtx) => Promise<void> | void;
  /** 反向。**必须与 run 互补**。`reversible: false` 时它是一个只出声的桩，
   *  但**桩本身也要显式写出来**（由 `notReversibleRun` 生成），不是省略 */
  unrun: (ctx: EditCtx) => Promise<void> | void;

  /**
   * 一轮 AI 里被合并进来的子命令（E4）。用户看到的是一条记录，
   * 撤销时按**逆序**逐个 `unrun`。
   *
   * ⚠️ 合并**在入栈时**发生，不在撤销时（理由见 `lib/agent/ledger.ts` 文件头）。
   * 有 `steps` 的命令，它自己的 `run`/`unrun` 是**整轮**的正向/反向，
   * 不是单条 —— 两者必须一致，否则"撤销一条 = 撤销 12 个镜头"这句
   * 在面板上的承诺就落空了。
   */
  steps?: readonly EditCommand[];
}

/** 命令的**作者**给的东西：id / at / kind 由 store 补，不用手写。
 *
 *  C2 之前这里还有一层"旧三参数 → 本形状"的适配（`draftFromLegacy`），
 *  服务于历史调用点；18 处全改成对象字面量之后适配层已删除，现在每个入口
 *  都直接写这个形状 —— 少一个形状，就少一处"写错了但能跑"的地方。 */
export interface CommandDraft {
  label: string;
  run: (ctx: EditCtx) => Promise<void> | void;
  unrun: (ctx: EditCtx) => Promise<void> | void;
  kind?: CommandKind;
  affected?: CommandScope;
  reversible?: boolean;
  /** 谁发起的。**人写的调用点不传**（缺省 user）；Agent 侧一律传 */
  origin?: CommandOrigin;
  desc?: string;
  params?: Record<string, unknown>;
  agentCallable?: boolean;
}

/** 进程内唯一 id。**不用 index、不用 shots.order** —— 理由见文件头。
 *
 *  优先 `crypto.randomUUID()`（Node 19+ / 浏览器 / WebView2 都有）；
 *  没有就退回 `时间戳 + 自增 + 随机`：三者合起来在一个进程内不会撞，
 *  而撤销栈本来就不跨进程（切项目时 `clearUndo` 清空）。
 */
let seq = 0;
export function uid(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (typeof g.crypto?.randomUUID === "function") return g.crypto.randomUUID();
  seq += 1;
  return `c${Date.now().toString(36)}-${seq.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 从 label 推 `kind`。**只用于 C1 的适配**，C2 迁移时每类命令自己声明 `kind`。
 *
 * 为什么不干脆一律 `other`：撤销历史面板（C3）要按 kind 分组，而 C1 落地后
 * 到 C2 迁完之间会有一段"新命令已经带 kind、旧命令全是 other"的中间态。
 * 这段时间面板要是把九成记录归进「其他」，那它一开始就是废的。所以先按
 * label 的字面词推一遍，**推不出来才落 `other`**。
 *
 * ⚠️ 这是**有损**的（label 是人写的、会变），所以它只在这一个地方用，
 * 且 C2 每迁一类就少依赖它一点。C2 做完后本函数只剩兜底职责。
 */
export function commandKindOf(label: string): CommandKind {
  if (/轨道|锁定|隐藏|静音|独奏/.test(label)) return "track";
  if (/转场/.test(label)) return "transition";
  if (/字幕/.test(label)) return "subtitle";
  if (/音频/.test(label)) return "audio";
  if (/素材/.test(label)) return "asset";
  if (/画面|调色|特效|马赛克|调整/.test(label)) return "transform";
  if (/镜头|分割|划出|粘贴/.test(label)) return "shot";
  return "other";
}

/** 给界面用的分类名。C3 的历史面板直接读它，避免 UI 里散落一套中文映射。 */
export const KIND_LABEL: Record<CommandKind, string> = {
  shot: "镜头",
  transform: "画面",
  transition: "转场",
  asset: "素材",
  audio: "音频",
  subtitle: "字幕",
  track: "轨道",
  other: "其他",
};

/**
 * 不可重做时的正向桩。**唯一允许 `reversible: false` 的成因**，而且必须由
 * 调用方**显式构造** —— 不能是"忘了写 run"的默认值，那正是 C1 之前的病根
 * （`redo` 可选 ⇒ 不传就静默退化成"撤得回、重做点了没反应"，且栈里数不出来）。
 *
 * 现状：C2 迁完后 18 个入口全都写了 `run`，`irreversibleCount()` 恒为 0，
 * 本函数**暂无调用点**。留着是因为它是"这条命令确实不可逆"在类型层的表达 ——
 * 真出现时应当明写 `reversible: false, run: notReversibleRun(label, say)`，
 * 而不是让 `run` 缺省成空函数。
 *
 * @param onTry 用户真的去点重做时怎么办。传提示函数，不要传空函数：
 *   按钮可点却毫无反应，比按钮灰着更让人困惑。
 */
export function notReversibleRun(
  label: string,
  onTry: (label: string) => void,
): (ctx: EditCtx) => void {
  return () => onTry(label);
}

export interface CommandStore {
  /** 入栈。**调用时机是"已经改完了"**（与旧 `pushUndo` 一致）——
   *  命令本身就是记录，不是执行器。C2 之后才考虑"执行器"那一半。
   *
   *  ⚠️ E4：若当前正处于一轮 Agent 里（`beginTurn` 之后、`endTurn` 之前），
   *  且栈顶那条**同属这一轮**，本条会被**合并**进栈顶，`push` 返回的就是
   *  那条被合并后的命令。调用方拿到的 `cmd.id` 因此可能是**上一条**的 id ——
   *  不要拿它当"我这步的 id"去存，需要稳定身份就往 `params` 里写业务 id。 */
  push: (draft: CommandDraft) => EditCommand;
  /** 栈顶（下次撤销会执行的那条）。不执行、不移动指针 */
  peek: () => EditCommand | undefined;
  /** 按 id 找（两端都找）。**不要加"按位置找"的重载** —— 见文件头。
   *  E4 之后也会在合并命令的 `steps` 里找一层，这样"子命令的 id"同样能定位。 */
  find: (id: string) => EditCommand | undefined;
  /** 撤销一条：执行 `unrun`，成功后移到重做栈。
   *
   *  ⚠️ **失败的条目会留在原处**，不会被吃掉。旧实现是先 `slice(0,-1)`
   *  再 `await entry.undo()`：闭包一旦抛异常（网络断了、后端 500），
   *  那条记录**已经从撤销栈里没了**，用户再按 Ctrl+Z 撤的是上一条 ——
   *  表现为"跳着撤"，而且中间丢的那条永远回不去。
   */
  undo: () => Promise<EditCommand | undefined>;
  redo: () => Promise<EditCommand | undefined>;
  /** 撤销栈的只读视图（老→新，栈顶在末尾） */
  undoEntries: () => readonly EditCommand[];
  /** 重做栈的只读视图（老→新，栈顶在末尾） */
  redoEntries: () => readonly EditCommand[];
  undoCount: () => number;
  redoCount: () => number;
  /** 栈里 `reversible: false` 的条数。**C1 实测起点是 0**（旧调用点全都配了
   *  `redo`），所以它衡量的是"新写的命令有没有漏"，不是"旧账还了多少" */
  irreversibleCount: () => number;
  clear: () => void;
  /** 栈深度上限，供验证脚本断言 */
  limit: () => number;

  // ── E4：一轮 Agent = 一条可撤销记录 ──────────────────────────────────

  /**
   * 开一轮 Agent 修改。返回 `turnId`，之后到 `endTurn` 之间的所有 `push`
   * 都会被合并成**一条**记录。
   *
   * ⚠️ **必须成对调用**（try/finally）。一轮里某条命令抛了异常、忘了
   * `endTurn`，后续**人**的操作会被继续并进 AI 那一轮 —— 用户按一次
   * Ctrl+Z，连自己手动改的那几笔一起没了。所以 `endTurn` 要走 finally。
   */
  beginTurn: () => string;
  /** 收尾一轮。传 `turnId` 是为了防串轮（旧一轮迟到的 endTurn 不能关掉新的） */
  endTurn: (turnId: string) => void;
  /** 当前是否在某轮里。面板据此显示"AI 正在修改…"，期间禁掉撤销 */
  currentTurn: () => string | null;
}

/** @param limit 撤销深度上限。C1 阶段由 `timelineStore` 传 50（与旧实现一致），
 *  C4 再统一改 100 —— **本模块不写死**，否则 C4 要改的是这里而不是调用方。 */
export function createCommandStore(limit: number): CommandStore {
  // 栈用模块内变量 + 纯函数读写：没有 get/set 的 store 包袱，node 下可直接跑
  let undoStack: EditCommand[] = [];
  let redoStack: EditCommand[] = [];
  // 当前正在进行的 Agent 轮次（null = 人手动操作中）
  let turnId: string | null = null;
  // 所有命令的 ctx 都是同一个空对象：它是只读的，共用一个实例不会串味
  const ctx: EditCtx = {};

  /** 合并两条命令的影响面。去重 —— 一轮里 12 条命令改的多半是同一批镜头，
   *  不去重的话面板会显示"改动了 47 个镜头"而实际只有 6 个。 */
  const mergeScope = (a: CommandScope, b: CommandScope): CommandScope => ({
    shots: a.shots || b.shots
      ? [...new Set([...(a.shots ?? []), ...(b.shots ?? [])])]
      : undefined,
    assets: a.assets || b.assets
      ? [...new Set([...(a.assets ?? []), ...(b.assets ?? [])])]
      : undefined,
  });

  return {
    push(draft) {
      // ── E4 的**另一半**：谁把 `origin` 标上去 ───────────────────────
      // 合并窗口的判据是 `top.origin.turnId === turnId`，而 `turnId` 只在
      // 轮次进行中非 null —— 所以"在轮次里推的命令就是这一轮的命令"这个
      // 推断，和 `beginTurn` 的语义是**同一件事**，不需要第三个信息源。
      //
      // ⚠️ 不能指望调用方自己标：`dispatch.ts` 把 handler 收到的 draft 定成
      //    `Omit<CommandDraft, "origin">`（**故意**的，见那里的注释），于是
      //    12 个 handler 都标不了；`host.pushCommand` 又直接转发。结果就是
      //    这个推断**必须**落在 push 里 —— 否则 `turnId` 永远在等一个没人
      //    会写的 `origin`，合并是死代码：AI 改 12 个镜头 = 12 条撤销记录。
      //
      // ⚠️ 人手动操作不会被误标：`host.agentTurnInFlight()` 为真时界面把
      //    撤销/编辑都禁掉了，轮次期间不会有 `by:"user"` 的 push 进来。
      //    真进来了（比如轮次抛异常漏了 `endTurn`），那反而是**该**并进这一
      //    轮的 —— 它确实发生在这一轮的时间里。
      const origin: CommandOrigin =
        draft.origin ?? (turnId ? { by: "agent", turnId } : { by: "user" });
      const cmd: EditCommand = {
        id: uid(),
        label: draft.label,
        kind: draft.kind ?? commandKindOf(draft.label),
        at: Date.now(),
        affected: draft.affected ?? {},
        reversible: draft.reversible ?? true,
        origin,
        desc: draft.desc,
        params: draft.params,
        agentCallable: draft.agentCallable,
        run: draft.run,
        unrun: draft.unrun,
      };

      // ── E4：入栈即记账 ──────────────────────────────────────────────
      // 每条命令（人的和 AI 的都算）都要在台账里留一笔：**一个 id 一条账**，
      // 合并后的整轮不再补记（它的 id 就是栈顶那条的 id）。
      // 组号由 `record` 分配 —— 同一个 `turnId` 恒返回同一个组号，这就是
      // "人在哪、AI 在哪"在一条时间线上的先后标记（见 `ledger.ts` 的 `nextGroup`）。
      record({
        commandId: cmd.id,
        turnId: origin.by === "agent" ? origin.turnId : null,
        label: cmd.label,
        kind: cmd.kind,
        affected: cmd.affected,
        at: cmd.at,
      });

      // ── E4：同轮合并 ────────────────────────────────────────────────
      // 只在「当前有轮次」且「栈顶属于同一轮」时才并。两个条件缺一不可：
      // 少了前者，人的操作会跟上一个 AI 轮次粘在一起；少了后者（比如中间
      // 被 clear 过再开一轮），合并会把两轮揉成一条。
      const top = undoStack[undoStack.length - 1];
      if (turnId && top && top.origin.by === "agent" && top.origin.turnId === turnId) {
        const steps = [...(top.steps ?? [top]), cmd];
        // 整轮的 unrun 是**逆序**逐个反向 —— 顺序反了，后一步依赖前一步
        // 结果的命令会失败（比如先改时长再依赖新时长划区间）。
        const merged: EditCommand = {
          ...top,
          // label 取首步 + 步数。不拼成 "a、b、c…"，12 步拼出来没人看得完
          label: `${top.steps ? top.steps[0].label : top.label} 等 ${steps.length} 处修改`,
          at: Date.now(),
          affected: mergeScope(top.affected, cmd.affected),
          // 只要有一条不可重做，整轮就不可重做 —— 反过来会把不可逆的
          // 操作藏进一条"看起来能重做"的记录里
          reversible: top.reversible && cmd.reversible,
          steps,
          run: async () => { for (const s of steps) await s.run(ctx); },
          unrun: async () => { for (const s of [...steps].reverse()) await s.unrun(ctx); },
        };
        undoStack = [...undoStack.slice(0, -1), merged];
        redoStack = [];
        // 合并后**不补记**：`merged.id === top.id`，台账里已经有这一条了。
        // 补记会让同一个 id 出现两条账，`groupOf` 取最后一条虽然侥幸还是同组，
        // 但复盘视图会重复计数。
        return merged;
      }

      undoStack = [...undoStack, cmd].slice(-limit);
      // 新操作使 redo 分支失效（标准 NLE 行为，与旧实现一致）
      redoStack = [];
      return cmd;
    },

    peek: () => undoStack[undoStack.length - 1],
    find: (id) => {
      const hit =
        undoStack.find((c) => c.id === id) ?? redoStack.find((c) => c.id === id);
      if (hit) return hit;
      // 合并命令的子步骤：面板上点"AI 那一步里的第 3 条"要能定位到
      for (const c of [...undoStack, ...redoStack]) {
        const sub = c.steps?.find((s) => s.id === id);
        if (sub) return sub;
      }
      return undefined;
    },

    async undo() {
      const cmd = undoStack[undoStack.length - 1];
      if (!cmd) return undefined;
      // 先执行、成功了才出栈 —— 失败留在原处，理由见接口注释
      await cmd.unrun(ctx);
      undoStack = undoStack.slice(0, -1);
      redoStack = [...redoStack, cmd];
      return cmd;
    },

    async redo() {
      const cmd = redoStack[redoStack.length - 1];
      if (!cmd) return undefined;
      // 与 undo 同款：抛了就留在重做栈里，重试还是这一条
      await cmd.run(ctx);
      redoStack = redoStack.slice(0, -1);
      undoStack = [...undoStack, cmd].slice(-limit);
      return cmd;
    },

    undoEntries: () => undoStack,
    redoEntries: () => redoStack,
    undoCount: () => undoStack.length,
    redoCount: () => redoStack.length,
    irreversibleCount: () => undoStack.filter((c) => !c.reversible).length,
    /** 清空命令栈。**台账一起清** —— 两者是同一份历史的两种表示，
     *  只清一边会留下"台账里有、栈里找不到"的孤儿记录（`groupOf` 靠回查
     *  台账判断同组，孤儿记录会让下一轮的合并判断读到上一轮的组号）。
     *  调用方因此**不需要**再单独调 `ledger.clear()`。 */
    clear() { undoStack = []; redoStack = []; turnId = null; ledgerClear(); },
    limit: () => limit,

    beginTurn() {
      // 上一轮没关就再开一轮 = 调用方漏了 endTurn。**直接顶掉**而不是
      // 抛异常：抛出去会把用户正在做的修改卡在半路，而顶掉的后果只是
      // 那一轮不再合并（退化成一堆独立记录），是可接受的降级。
      turnId = newTurnId();
      return turnId;
    },
    endTurn(id) { if (turnId === id) turnId = null; },
    currentTurn: () => turnId,
  };
}
