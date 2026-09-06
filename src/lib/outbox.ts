/**
 * lib/outbox.ts — 离线写入队列的**规则层**（6.8，纯函数 + 可注入 I/O）
 *
 * ## 它补的是 6.7 亲口承认的那个洞
 *
 * 6.7 让断线不再销毁编辑器，代价是必须在横幅上说实话：
 * 「失败的改动**不会**自动重发」。那句话当时是诚实的，但它描述的是一个
 * 半成品状态 —— 用户能继续编辑，编的东西却在悄悄流失。本条目把那半句话
 * 兑现成真的重发，并**同步改掉横幅与恢复文案**（留着旧文案就成了反向的谎）。
 *
 * ## 为什么队列只收 PATCH / PUT / DELETE，**不收 POST**
 *
 * 这不是省事，是正确性：POST 是**创建**，id 由服务端铸造。离线时 POST 失败，
 * 那个实体压根没有 id；把它排进队列、事后补发，会得到一个用户界面上早已
 * "存在"、而所有引用它的后续编辑都指向空的幽灵实体（后续 PATCH 的 URL 里
 * 根本填不出 id）。所以创建在离线时**当场失败并明说要联网**，
 * 这比事后炸开要好得多。离线新建整个项目属同一类问题，见文件末尾。
 *
 * ## 为什么可以「同目标只留最后一笔」
 *
 * 本项目的 PATCH 全是**绝对值**语义（把这些字段设成这些值），不是增量。
 * 所以对同一个目标连改 5 次，只补发第 5 次与补发全部 5 次**结果相同**，
 * 而少发 4 次就少 4 次失败机会。更要紧的是它避免了**陈旧版本号的连锁**：
 * `transform_meta` 带乐观锁（见 `lib/shotRev.ts`），第 2 笔的 `baseTransformRev`
 * 是基于第 1 笔**未被确认**的结果算的，一起补发必然从第 2 笔开始全部 409。
 *
 * ## 补发时遇到 409 绝不重试
 *
 * 409 的含义是"这期间别人改过同一个镜头"。去掉版本号再发一次一定能成功 ——
 * 而那正是**静默覆盖掉别人的修改**，是 2.3 乐观锁存在的唯一理由。
 * 所以 409 一律记为冲突、丢出队列、**告诉用户**，由人来决定要不要重做。
 */

/** 队列里的一笔。`body` 只存字符串（JSON）——见 `canQueue`。 */
export interface QueuedWrite {
  /** 入队序号，决定补发顺序 */
  seq: number;
  method: string;
  url: string;
  body: string | null;
  /** 入队时刻，用于告诉用户"这是什么时候的改动" */
  at: number;
  /** 已补发失败次数（仅 5xx 累加），到 MAX_TRIES 就放弃并如实报告 */
  tries: number;
}

export interface OutboxIO {
  load(): Promise<QueuedWrite[]>;
  save(queue: readonly QueuedWrite[]): Promise<void>;
}

export interface ReplayResult {
  /** 补发成功 */
  applied: number;
  /** 409：期间被别人改过，**没有**覆盖 */
  conflicted: number;
  /** 4xx 或连续 5xx 到顶，放弃 */
  rejected: number;
  /** 仍留在队列里的笔数 */
  remaining: number;
  /** 撞上 401/403：补发中止，等重新登录 */
  authBlocked: boolean;
}

/** 同一笔最多补发几次（仅 5xx 累加）。到顶就放弃并如实报告，不无限重试。 */
export const MAX_TRIES = 3;

/** 队列不收的写端点：文件上传。它们的 body 是 FormData，序列化不了，
 *  而且本来就有独立的进度与错误 UI（与 `UNTRACKED_WRITE_PATHS` 同一批）。 */
export const UNQUEUEABLE_PATHS = ["/v2/media/upload", "/v2/script/import-file"];

/** 可以排队补发的方法。**POST 不在内**，理由见文件头。 */
export const QUEUEABLE_METHODS = new Set(["PATCH", "PUT", "DELETE"]);

/** 去掉查询串的目标。`?force=true` 之类不该让两笔看起来是不同目标。 */
export function targetOf(url: string): string {
  const q = url.indexOf("?");
  return q < 0 ? url : url.slice(0, q);
}

/**
 * 这一笔能不能进队列。
 *
 * `body` 必须是字符串或空：`FormData`/`Blob` 存不进 JSON，硬存会得到 `{}`，
 * 补发出去就是一笔**内容为空的写**——比不补发坏得多。
 */
export function canQueue(url: string, method: string, body: unknown): boolean {
  if (!QUEUEABLE_METHODS.has(method.toUpperCase())) return false;
  if (UNQUEUEABLE_PATHS.some((p) => url.includes(p))) return false;
  return body === null || body === undefined || typeof body === "string";
}

/**
 * 把一笔并入队列，返回**新数组**（不改原数组）。
 *
 * 三条规则，都由"同目标的绝对值写"这一前提推出：
 *   1. 同 method 同目标 → **原地替换**，保留它原来的位置。
 *      移到队尾会打乱它与其他资源之间的相对顺序，而那是有意义的
 *      （例如先改镜头时长、再改依附其上的字幕）。
 *   2. DELETE → 先删掉同目标的所有既有笔，再追加。
 *      删都删了，之前那些改字段的补发只会得到 404。
 *   3. 目标已排了 DELETE，再来非 DELETE → **丢弃新的这笔**。
 *      往一个即将被删的资源上补字段没有意义。
 */
export function coalesce(
  queue: readonly QueuedWrite[], entry: QueuedWrite,
): QueuedWrite[] {
  const t = targetOf(entry.url);
  const method = entry.method.toUpperCase();

  if (method !== "DELETE"
      && queue.some((w) => targetOf(w.url) === t && w.method.toUpperCase() === "DELETE")) {
    return [...queue];
  }
  if (method === "DELETE") {
    return [...queue.filter((w) => targetOf(w.url) !== t), entry];
  }
  const i = queue.findIndex(
    (w) => targetOf(w.url) === t && w.method.toUpperCase() === method,
  );
  if (i < 0) return [...queue, entry];
  const next = [...queue];
  // 保留原位置和原 seq：这一笔在队列里的"资历"没变，变的只是它要写的值。
  next[i] = { ...entry, seq: queue[i].seq, tries: queue[i].tries };
  return next;
}

/**
 * 按顺序补发整个队列。
 *
 * `send` 返回 HTTP 状态码；返回 `null` 表示**又断了**（网络层 reject）。
 * 一旦又断，立刻停下并把剩下的原样留在队列里 —— 继续发只是把每一笔
 * 都撞成失败，还会白白累加 `tries`。
 */
export async function replayQueue(
  queue: readonly QueuedWrite[],
  send: (w: QueuedWrite) => Promise<number | null>,
): Promise<{ result: ReplayResult; remaining: QueuedWrite[] }> {
  let applied = 0, conflicted = 0, rejected = 0, authBlocked = false;
  const remaining: QueuedWrite[] = [];
  let stopped = false;

  for (const w of queue) {
    if (stopped) { remaining.push(w); continue; }

    const status = await send(w);

    if (status === null) { stopped = true; remaining.push(w); continue; }
    if (status >= 200 && status < 300) { applied++; continue; }
    if (status === 401 || status === 403) {
      // 票过期了。**留着**：重新登录之后这些改动仍然是有效的、想要的。
      // 丢掉才是真损失，而这是用户唯一无法自己补救的一类。
      authBlocked = true; stopped = true; remaining.push(w); continue;
    }
    if (status === 409) { conflicted++; continue; }   // 见文件头：绝不去掉版本号重发
    if (status >= 500) {
      const tries = w.tries + 1;
      if (tries >= MAX_TRIES) { rejected++; continue; }
      remaining.push({ ...w, tries });
      continue;
    }
    rejected++;   // 其余 4xx：请求本身就不合法，发一百次也一样
  }

  return {
    result: { applied, conflicted, rejected, remaining: remaining.length, authBlocked },
    remaining,
  };
}

/**
 * 恢复连接时对用户说的那一句。
 *
 * ⚠️ 措辞规则（承重，`verify-outbox` 钉着）：
 *   · 有冲突或有放弃时，**不许**出现「全部」「已同步」这类把结果说圆的字眼。
 *     6.7 的教训原样适用 —— 说圆一次，用户就不会去核对，而那几笔是真没了。
 *   · 没有任何待补发时才可以只说「已恢复连接」。
 */
export function describeReplay(r: ReplayResult): string {
  const parts: string[] = [];
  if (r.applied > 0) parts.push(`已补发 ${r.applied} 处离线改动`);
  if (r.conflicted > 0) parts.push(`${r.conflicted} 处期间被其他窗口改过，未覆盖，请核对后重做`);
  if (r.rejected > 0) parts.push(`${r.rejected} 处补发失败，需要手动重做`);
  if (r.authBlocked) parts.push(`登录已失效，剩余 ${r.remaining} 处待重新登录后补发`);
  else if (r.remaining > 0) parts.push(`还有 ${r.remaining} 处待补发`);
  if (parts.length === 0) return "已恢复与服务器的连接";
  return `已恢复连接 —— ${parts.join("；")}`;
}

/**
 * 断线横幅里那句「你现在改的东西会怎样」。
 *
 * 与 `describeReplay` 一样是承重文案：它必须与本模块**真正的行为**一致。
 * 6.7 时这里写的是「不会自动重发」，因为当时确实不会；现在会了，就必须改口。
 * 反过来也一样 —— 哪天队列被摘掉，这句话要跟着改回去。
 */
export function offlineBannerText(pending: number): string {
  const tail = pending > 0 ? `已暂存 ${pending} 处改动，` : "";
  return `${tail}改动会先记在本机，联网后自动补发；补发结果会逐条告诉你。`;
}

/**
 * 一笔写在断线时失败了，顶栏该显示哪句话。
 *
 * 分三种，因为**用户能做的事完全不同**：
 *   · 进了队列 → 什么都不用做，联网自己会补 → 必须说出来，否则用户会去重做，
 *     等补发跑完就成了做两遍（PATCH 是绝对值语义，做两遍不至于出错，
 *     但白干一遍还提心吊胆）；
 *   · 没进队列且是 POST → **必须联网**，而且要说清为什么，不然用户只会反复点
 *     那个按钮。理由（编号由服务端分配）写在提示里是刻意的：它同时解释了
 *     "为什么别的改动能暂存、偏偏新建不行"；
 *   · 不是断线（500 / 409 …）→ 交给 `describeSaveError` 按状态码分类，这里不插嘴。
 */
export function offlineWriteHint(
  unreachable: boolean, queued: boolean, method: string,
): string | undefined {
  if (!unreachable) return undefined;
  if (queued) return "连不上服务器 —— 改动已暂存在本机，联网后会自动补发";
  if (method.toUpperCase() === "POST") {
    return "连不上服务器 —— 新建类操作必须联网（新条目的编号由服务端分配，无法离线补发），请连上后重试";
  }
  return "连不上服务器，改动未保存 —— 请检查网络";
}

/*
 * ## 本模块**不做**的事（写在这里免得下次有人以为它坏了）
 *
 * · **离线新建项目**。它不是"再排一种队"就能解决的：项目、镜头、片段、资产的
 *   id 全部由服务端铸造，离线新建需要一整套本地 id 命名空间 + 联网后的
 *   id 重映射，波及全部 25 个写端点，规模比批次 7 还大。当前 localStorage 里
 *   只有 `fw_project` 的一个 id，连一个字节的项目内容都没有。
 *   本条目改为：**离线时创建类操作当场明说要联网**，不给假按钮。
 * · **合并冲突**。409 只报告、不自动解决。自动解决必然要么丢自己的、
 *   要么丢别人的，而这个决定不该由程序替用户做。
 */
