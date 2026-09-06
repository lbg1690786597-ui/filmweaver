/**
 * appGate — 「现在该给用户看哪一屏」的唯一判据（6.7）
 *
 * ## 为什么要有这个文件
 *
 * 这些规则原本是 `App.tsx` 里四段顺序 `if`（旧 995/1015 行附近）。放在 `.tsx` 里
 * 有两个后果：一是 node 下 import 不进来（`App.tsx` 一路 import 到 `api.ts`，
 * 那边顶上就是 `import.meta.env`），于是**门禁这种"错了就整个软件进不去"的逻辑
 * 反而是全仓唯一没有测试的部分**；二是顺序 `if` 的分支关系只存在于阅读顺序里，
 * 加一个条件很容易把上一个分支挡掉，而症状是"某种状态下白屏"，很难复现。
 *
 * 所以规则全在这里，`App.tsx` 只负责按 `decideScreen` 的返回值渲染。
 *
 * ## 本条目改掉的那个行为（核心）
 *
 * 旧规则第一句是「`backendOk === false` → 一律渲染断线页」。它写的时候是对的
 * （见 `useAuth.ts` 里那段注释：不能把人放进空项目列表然后每个操作都失败），
 * 但它是在「后端探测只在启动时跑一次」的前提下写的 —— 那时 `backendOk` 只可能在
 * **还没进编辑器**的时候变成 false，所以"一律渲染断线页"不会伤到任何人。
 *
 * 本条目让断线在会话中途也能被察觉（见 `lib/backendReach.ts`）之后，这条前提没了：
 * 同一句代码会在用户编了半小时的项目上突然把整个编辑器换成一张「连不上后端」，
 * 选中态、播放头、未落库的调整**全部销毁**，而这一切只因为某一次 PATCH 超时。
 * 那比原来的"假装没事"更糟。
 *
 * 所以断线时分两种情况，判据是**手上有没有真数据**：
 *   · 已经拿到过项目详情（`hasProjectData`）→ 留在编辑器，挂一条横幅说实话
 *   · 只有一个 localStorage 里的 id、详情从没拿到过 → 才是断线页
 * 第二种正是"启动即断网"，它跟旧注释担心的场景逐字相同，故那条保护完整保留。
 *
 * ## 这里**不做**的事
 *
 * 不做「离线也能新建/编辑本地项目」——那需要项目内容真的落在本机（当前
 * localStorage 里只有 `fw_project` 的 id，一个字节的内容都没有），属 6.8。
 * 本文件只负责把门禁从"一刀切"改成"分得清情况"，不假装已经有离线数据。
 *
 * > 6.8 追记：那两件事**只做了一件**。`lib/snapshot.ts` 让项目详情真的落盘，
 * > 于是断网启动时 `hasProjectData` 可以为真，上面那个分叉才算在冷启动下也成立。
 * > **离线新建**仍然不做，理由见 `lib/outbox.ts` 末尾（id 由服务端铸造）。
 * > 门禁本身一个字没改：它的输入变得更常为真，而不是判据变了。
 */

/** 五种互斥的顶层屏。互斥是刻意的：任何时刻只有一个成立，避免"两个都想渲染"。 */
export type Screen = "probing" | "offline" | "login" | "projects" | "editor";

export interface GateState {
  /** null = 还在探测；false = 确认连不上 */
  backendOk: boolean | null;
  /** null = 还没结论（探测中，或后端不可达时无从判断） */
  loginRequired: boolean | null;
  /** localStorage 恢复的当前项目 id */
  projectId: string | null;
  /**
   * 是否**真的拿到过**这个项目的详情。
   *
   * ⚠️ 不能用 `projectId != null` 代替：id 是从 localStorage 恢复的，
   * 断网启动时它照样在，而 `detail` 还是 null。用 id 判断会把一个
   * 空壳编辑器摆到用户面前（没有镜头、没有时间轴、每个按钮都失败），
   * 正是旧代码那段注释要防的事。
   */
  hasProjectData: boolean;
}

export function decideScreen(s: GateState): Screen {
  if (s.backendOk === false) {
    // ★ 6.7 的核心分叉。手上有数据就继续编辑（配横幅），否则才是断线页。
    return s.projectId !== null && s.hasProjectData ? "editor" : "offline";
  }
  // 两个 null 都表示"还没结论"。分开写而不是只判 loginRequired：
  // 后台重探(见 useAuth)不会把 loginRequired 清成 null，只有 backendOk 会先动，
  // 少判一个就会在重探期间把已登录的用户闪到登录页。
  if (s.backendOk === null || s.loginRequired === null) return "probing";
  if (s.loginRequired) return "login";
  if (s.projectId === null) return "projects";
  return "editor";
}

/**
 * 一次请求失败，能不能算「后端不可达」。
 *
 * 这是本条目最容易写错、且写错代价最大的一条：判宽了，一次 500 或者用户
 * 取消一个预取就会让整个软件宣布离线（甚至在没数据时跳到断线页）；判窄了，
 * 真断网察觉不到，回到本条目要修的那个 bug。
 *
 * 判据只有一条：**后端有没有回话**。
 *   · 回了状态码（任何 4xx/5xx）→ 它活着，只是这次请求不行 → false
 *   · 主动取消（AbortError）→ 是我们自己撤的，与后端无关 → false
 *   · `fetch` 在网络层直接 reject（TypeError：断网/DNS/证书/被拦截）→ true
 *
 * 用鸭子类型看 `status` 而不是 `instanceof SaveHttpError`：那个类在
 * `stores/saveStateStore.ts` 里，import 它会把 zustand 拖进这个纯模块。
 * 判据本来也是"有没有状态码"，不是"是哪个类"——`ApiError` 同样该被放过。
 */
export function isUnreachable(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const e = err as { name?: unknown; status?: unknown };
  // ⚠️ 这一行今天是**冗余**的（变异测试实测逃逸）：真的 AbortError 是
  // DOMException，本来就过不了末行的 `instanceof TypeError`。留着是因为末行
  // 是最容易被放宽的一行（比如某天有人改成"凡是没有 status 的都算断线"），
  // 那时取消一个预取就会误报离线，而预取在本项目里随时都在 abort。
  // 删它省不了什么，留它挡住的是一整类回归。
  if (e.name === "AbortError") return false;
  if (typeof e.status === "number") return false;
  return err instanceof TypeError;
}

/**
 * 把「上一次健康探测的结论」和「最近一次真实请求的结果」合成一个 backendOk。
 *
 * 只允许**向下**覆盖：真实请求刚刚网络层失败（reach=false）就判离线，因为它比
 * 上一次探测新。反过来 reach=true **不能**把 probeOk 顶成 true —— 某个 GET 通了
 * 只证明后端在，不证明我们已经知道登录状态；那时 `loginRequired` 还是 null，
 * 硬判 true 会让 `decideScreen` 从 probing 掉进 projects，闪一下空列表。
 */
export function mergeBackendOk(
  probeOk: boolean | null, reach: boolean | null,
): boolean | null {
  return reach === false ? false : probeOk;
}

/**
 * 后台重探时 `authMe` 失败了，该不该把用户登出。
 *
 * 只有 401/403 才是"这张票真的不认了"。断网恢复的头一两秒后端常回 502/503，
 * 按那个把人踢回登录页 = 一次网络抖动导致重新扫码，而扫码在本项目里还是飞书流程。
 */
export function shouldLogoutOnProbeError(err: unknown): boolean {
  const st = (err as { status?: unknown } | null | undefined)?.status;
  return st === 401 || st === 403;
}

/*
 * 🪦 `reconnectNotice(failedCount)` 曾在这里，6.8 删除。**不是清理，是它的前提没了。**
 *
 * 它当时说的是「离线期间有 N 处改动没能保存，请核对后重做」，依据是
 * `saveStateStore.failedCount`。这句话在 6.7 时逐字为真 —— 那时确实没人重放。
 * 6.8 上了补发队列之后它有两处会骗人：
 *   · 断线失败的写现在**会**被补发，还说"没能保存"是反向的谎（比乐观的谎更
 *     难纠正：用户照着它去重做，就把已经补发上去的改动又做了一遍）；
 *   · `failedCount` 把已入队的那几笔也算在内，与补发结果一起报就是重复计数。
 *
 * 现在这句话由 `lib/outbox.ts` 的 `describeReplay(result)` 讲 —— 只有它知道
 * 每一笔究竟是补发成功、撞了 409、还是彻底放弃。
 * **没入队的失败**（500、上传类）不在那句话里，但它们照样有交代：
 * `saveStateStore.lastError` 是不自动消失的，用户点掉之前一直挂在顶栏。
 */
