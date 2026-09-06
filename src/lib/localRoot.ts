/**
 * lib/localRoot.ts — 本地素材根的寻址与归属判定（批次 6 / 6.6，纯逻辑）
 *
 * ## 这个文件**不是**安全边界，别把它当安全边界用
 *
 * 真正拦住越权读盘的是 **Tauri fs 插件的 scope**（Rust 侧）。用户在原生对话框里
 * 选中一个目录后，`@tauri-apps/plugin-dialog` 的 `open()` 会把该路径加进
 * filesystem scope（其文档原话：「The selected paths are added to the filesystem
 * and asset protocol scopes」）；scope 之外的路径，`readFile` 会被**插件**拒掉，
 * 与本文件写了什么无关。
 *
 * 本文件存在的理由只有两个，都是体验层的：
 *   1. **挑对根**：一个路径属于哪个已授权的根（决定相对显示名、决定失效时提示重选哪个）；
 *   2. **提前说人话**：在发起注定失败的 `readFile` 之前就告诉用户
 *      「这个素材在授权目录之外」/「授权已随重启失效」，而不是把插件那句
 *      `forbidden path` 原样糊到用户脸上。
 *
 * 所以：**加固这里不会提升安全性**（越过它也过不了 Rust），
 * **弱化这里也不会造成越权**（只是提示变难看）。
 * 写清楚这一点是为了下一个人别在这里做"纵深防御"的加法，
 * 也别以为改了这里就能放宽 capabilities —— capabilities 里 `fs` 的静态 scope
 * 至今仍只有 `$APPDATA/**`，6.6 一个字都没加。
 *
 * ## 授权不跨重启，这是特性不是缺陷
 *
 * 同一段文档下一句：「the scope change is not persisted, so the values are cleared
 * when the application is restarted」。官方给的持久化方案是
 * `tauri-plugin-persisted-scope`，**本项目刻意不引入**：
 *   · 它是新的 Rust 依赖，而本机没有 cargo，加了就只能等 CI，永远验证不了；
 *   · 更要紧的是，它把"用户这一次选了这个目录"变成"重启后依然有效的常驻授权"
 *     —— 那正是 `OPTIMIZATION` 风险表第 12 行要拦的「安全面扩大」。
 *
 * 代价是：重启后老项目里存的 `localPath` 会**读不到**。对策不是偷偷回退云端
 * （见 `model.ts` 里 `localPath` 的字段注释），而是 `explainUnreachable()`
 * 给出一句能照着做的话，让用户重选一次根。
 *
 * ## 路径风格按**路径自己长什么样**判，不按运行平台判
 *
 * 客户端要出 Windows 包，所以必须同时处理 `C:\a\b`、UNC `\\srv\share\a` 和
 * POSIX `/a/b`。用 `process.platform` / `navigator` 去判会让这套逻辑在 node
 * 验证脚本里**测不了**（验证机是 Linux，永远走不到 Windows 分支），
 * 于是 Windows 上的行为就只能靠"应该没问题"来保证 —— 这正是本项目反复
 * 吃过亏的那种"断言在装饰"。改成看路径本身的形状，两条分支在 Linux 上都能真跑。
 */

/** 已授权的素材根（用户在原生对话框里亲手选的那个目录）。 */
export interface LocalRoot {
  /** 规范化后的绝对路径，无尾斜杠（根目录 `/` 与 `C:\` 除外）。 */
  path: string;
  /** 用户看到的短名，默认取末段目录名。 */
  label: string;
  /** 何时授权的（`Date.now()`）。仅用于展示"本次启动后授权的"。 */
  grantedAt: number;
}

/** `C:\...` 或 `c:/...` */
const DRIVE_RE = /^[A-Za-z]:[\\/]/;
/** UNC：`\\server\share\...`（也接受正斜杠写法） */
const UNC_RE = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/;

/**
 * 这条路径是不是 Windows 风格。
 *
 * 只看形状：盘符开头，或 UNC 双斜杠开头。POSIX 路径里 `\` 是**合法文件名字符**，
 * 所以不能靠"含不含反斜杠"来判 —— `/tmp/a\b` 是一个名叫 `a\b` 的文件，
 * 判成 Windows 会把它劈成两段目录。
 */
export function isWindowsPath(p: string): boolean {
  return DRIVE_RE.test(p) || UNC_RE.test(p);
}

/**
 * 规范化一条绝对路径：统一分隔符、折叠重复分隔符、消解 `.` 与 `..`、去尾斜杠。
 *
 * 返回 `null` 表示**这不是一条可用的绝对路径**（空串、相对路径、或 `..` 已经
 * 爬到根之上）。返回 `null` 而不是抛：调用方几乎总是在处理用户/旧数据给的字符串，
 * 那里"不合法"是正常输入而非异常。
 *
 * ⚠️ 不碰符号链接（纯函数，摸不到盘）。所以 `isUnder()` 判 true 不代表
 * 真实文件一定落在根内 —— 那一层由 Rust 侧的 scope 校验兜，见文件头。
 */
export function normalizePath(input: string): string | null {
  const raw = (input ?? "").trim();
  if (!raw) return null;

  const win = isWindowsPath(raw);
  if (!win && !raw.startsWith("/")) return null;   // 相对路径一律不收

  // Windows 前缀（`C:` / `\\server\share`）要**整体保住**：它不是"一段目录"，
  // 被 `..` 弹出去就成了另一台机器上的路径。
  let prefix = "";
  let rest = raw;
  if (win) {
    const unc = UNC_RE.exec(raw);
    if (unc) {
      prefix = "\\\\" + unc[0].replace(/^[\\/]{2}/, "").replace(/[\\/]+/g, "\\");
      rest = raw.slice(unc[0].length);
    } else {
      prefix = raw.slice(0, 2).toUpperCase();      // `C:`；盘符大写便于后面比对
      rest = raw.slice(2);
    }
  }

  const segs: string[] = [];
  for (const s of rest.split(win ? /[\\/]+/ : /\/+/)) {
    if (!s || s === ".") continue;
    if (s === "..") {
      // 爬到根之上 = 这条路径没有意义，不静默夹到根（夹住会把
      // `/a/../../etc` 悄悄变成 `/etc`，那是**扩大**了它指向的范围）
      if (!segs.length) return null;
      segs.pop();
      continue;
    }
    segs.push(s);
  }

  const sep = win ? "\\" : "/";
  if (!segs.length) return win ? prefix + sep : "/";  // 根本身：`C:\` / `\\srv\share\` / `/`
  return prefix + sep + segs.join(sep);
}

/**
 * 比对用的键。Windows 大小写不敏感，POSIX 敏感。
 *
 * 同样按路径形状判：两条**风格不同**的路径永远不该被判成同一个位置，
 * 所以键里带上风格标记，`/C:/x` 之类的怪东西不会意外撞上 `C:\x`。
 */
function key(normalized: string): string {
  return isWindowsPath(normalized)
    ? "w:" + normalized.toLowerCase()
    : "p:" + normalized;
}

/**
 * `child` 是否落在 `root` 之内（含 `child === root`）。
 *
 * 两边都会先规范化；任一不合法则返回 `false`。
 *
 * 这里唯一容易写错、且**错了没有任何现象**的点是**前缀陷阱**：
 * `/data/材料-私密` 以 `/data/材料` 开头，但它显然不在后者之内。
 * 所以比的是「相等」或「root + 分隔符 开头」，不是裸 `startsWith`。
 * 判错的后果是把一个**未授权**目录当成已授权的去读，然后拿到插件的拒绝，
 * 用户看到的是一句不知所云的报错 —— 不是越权（越不过 Rust），是难以排查。
 */
export function isUnder(child: string, root: string): boolean {
  const c = normalizePath(child);
  const r = normalizePath(root);
  if (c === null || r === null) return false;
  // ⚠️ 这一句**不承重**：`key()` 给两种风格加了不同前缀（`w:` / `p:`），
  // 跨风格的两条路径既不可能相等、也不可能互为前缀，所以删掉它行为不变
  // （已用变异测试实测：改掉断言全绿，故未列进变异表，只留作对照组）。
  // 留着是因为它把「风格不同 = 不同位置」这条约束**写在了判定的入口**，
  // 而 `key()` 里那个前缀是为了别的目的（大小写规则）顺带做到的；
  // 哪天有人为了别的需求动 `key()`，这里还能兜住。
  if (isWindowsPath(c) !== isWindowsPath(r)) return false;

  const ck = key(c);
  const rk = key(r);
  if (ck === rk) return true;

  const sep = isWindowsPath(r) ? "\\" : "/";
  // 根若本身以分隔符结尾（`/` 或 `C:\`），再拼一个就成了 `//`，永远匹配不上
  const prefix = rk.endsWith(sep) ? rk : rk + sep;
  return ck.startsWith(prefix);
}

/**
 * 在已授权的根里挑出覆盖 `path` 的那一个；没有则 `null`。
 *
 * 命中多个时取**最深**的那个（路径最长）。理由是用户可能既授权了
 * `D:\素材`，又单独授权了 `D:\素材\本季`；显示相对名时用后者才是有意义的
 * （`第03集.mp4` 而不是 `本季\第03集.mp4`）。
 */
export function rootFor(path: string, roots: readonly LocalRoot[]): LocalRoot | null {
  let best: LocalRoot | null = null;
  for (const r of roots) {
    if (!isUnder(path, r.path)) continue;
    if (!best || r.path.length > best.path.length) best = r;
  }
  return best;
}

/**
 * 相对已授权根的显示名。不在任何根内时退回**末段文件名**。
 *
 * 面板里不显示绝对路径：一是长，二是它会把用户的目录结构（常含真名、公司名）
 * 摊在截图里。真要看全路径有「在文件管理器中显示」。
 */
export function displayName(path: string, roots: readonly LocalRoot[]): string {
  const p = normalizePath(path);
  if (p === null) return path;
  const sep = isWindowsPath(p) ? "\\" : "/";
  const r = rootFor(p, roots);
  if (!r) return p.split(sep).pop() || p;
  const rp = normalizePath(r.path)!;
  if (key(rp) === key(p)) return r.label;
  const cut = rp.endsWith(sep) ? rp.length : rp.length + 1;
  return p.slice(cut);
}

/**
 * 登记一个新授权的根。返回**新数组**（不改入参）。
 *
 * 规则：
 *   · 已被现有根覆盖 → 原样返回（不重复登记子目录）；
 *   · 新根覆盖了若干旧根 → 旧根被**吸收**（删掉），避免列表里堆一串父子重复项；
 *   · 路径不合法 → 原样返回。
 *
 * 「吸收」这条是有意为之：如果用户先选了 `D:\素材\本季`、后选了 `D:\素材`，
 * 列表里留着两条只会让人以为撤销上面那条就收回了权限，实际并没有。
 */
export function addRoot(roots: readonly LocalRoot[], path: string, now: number): LocalRoot[] {
  const p = normalizePath(path);
  if (p === null) return [...roots];
  if (roots.some((r) => isUnder(p, r.path))) return [...roots];
  const sep = isWindowsPath(p) ? "\\" : "/";
  const label = p.split(sep).filter(Boolean).pop() || p;
  const kept = roots.filter((r) => !isUnder(r.path, p));
  return [...kept, { path: p, label, grantedAt: now }];
}

/** 撤销一个根（按规范化后的路径匹配）。返回新数组。 */
export function removeRoot(roots: readonly LocalRoot[], path: string): LocalRoot[] {
  const p = normalizePath(path);
  if (p === null) return [...roots];
  return roots.filter((r) => key(normalizePath(r.path)!) !== key(p));
}

/** `explainUnreachable` 的判定结果。 */
export type UnreachableKind =
  /** 路径本身就不合法（空、相对、`..` 爬过根）—— 多半是脏数据 */
  | "badpath"
  /** 合法，但不在任何已授权根内 —— 典型是重启后授权清空 */
  | "outofscope"
  /** 在授权根内，那就是文件真的没了（被移走/改名/外置盘拔了） */
  | "missing";

/**
 * 一个本地素材读不到时，告诉用户**发生了什么、下一步做什么**。
 *
 * 这个函数是 6.6 的用户可见面。三种原因的处置办法完全不同，
 * 混成一句「素材读取失败」等于什么也没说：
 *   · `outofscope` 要重选目录（而且这是**每次重启后的正常现象**，
 *     必须说清楚"不是坏了"，否则用户会以为项目损坏）；
 *   · `missing` 重选目录没用，得去找文件；
 *   · `badpath` 是数据问题，重选和找文件都没用。
 */
export function explainUnreachable(
  path: string, roots: readonly LocalRoot[], hasRootsThisSession: boolean,
): { kind: UnreachableKind; message: string } {
  const p = normalizePath(path);
  if (p === null) {
    return {
      kind: "badpath",
      message: `素材路径无法识别（${path || "空路径"}），请重新指定这个素材的文件`,
    };
  }
  const name = displayName(p, roots);
  if (!rootFor(p, roots)) {
    return {
      kind: "outofscope",
      message: hasRootsThisSession
        ? `「${name}」不在已授权的素材目录内 —— 点「添加素材目录」把它所在的文件夹选进来`
        : `素材目录的访问授权在关闭软件时已释放（这是正常的），`
          + `点「添加素材目录」重新选一次即可继续编辑「${name}」`,
    };
  }
  return {
    kind: "missing",
    message: `「${name}」在授权目录里没找到 —— 文件可能被移动、改名，或所在磁盘未连接`,
  };
}
