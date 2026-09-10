/**
 * 清洗成可用的文件名片段。
 *
 * 按集导出的文件名里要拼集标题，而集标题来自剧本，常含 `：`「/」「?」这类
 * 字符 —— Windows 上 `\ / : * ? " < > |` 一律非法，路径里出现就直接写盘失败；
 * 首尾空格和结尾的点在 Windows 上也会被静默吞掉，导致文件名对不上。
 * 另外限长，避免集标题过长把整条路径顶过 260 字符上限。
 */
export function safeFileName(raw: string, maxLen: number): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_")  // Windows 非法字符 + 控制字符
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.\s]+$/, "");
  return cleaned.slice(0, maxLen).trim();
}

/** 集号补零：第 3 集 → "03"，让文件管理器里按名排序与集号顺序一致 */
export const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * 按集导出的单个文件名（含扩展名）。
 *
 * 导出对话框的路径预览与 App 里真正拼盘的地方**必须调同一个函数**——
 * 各写一份的话，预览显示的路径和实际落盘的文件名迟早会对不上，
 * 而用户是照着预览去文件夹里找文件的。
 */
export function episodeFileName(base: string, ep: number, title?: string): string {
  const t = safeFileName(title ?? "", 40);
  return `${base}_第${pad2(ep)}集${t ? `_${t}` : ""}.mp4`;
}

/** 镜号补零到 3 位：第 7 镜 → "007"。
 *  项目动辄 600+ 镜（9301 项目 601 镜），补 2 位在文件管理器里排序就乱了
 *  （`镜10` 会排到 `镜9` 前面）。 */
export const pad3 = (n: number) => String(n).padStart(3, "0");

/**
 * 按片段导出的单个文件名（含扩展名）——**一个镜头一个文件**。
 *
 * 命名要同时满足两件事：
 *  · 在文件管理器里按名排序 = 剧情顺序（所以集号与镜号都补零）；
 *  · 光看文件名就知道是哪一集第几镜（用户拿单个片段去投流/送审时要对得上）。
 *
 * `Shot.order` 在整个项目内连续且唯一（后端按集重拆时"order 接在其他集之后"），
 * 所以不会出现两个片段撞同一个文件名。
 *
 * 与 `episodeFileName` 同理：对话框的路径预览和 App 里真正拼盘的地方**必须**
 * 调这同一个函数，否则预览显示的路径和实际落盘的名字迟早对不上。
 */
export function clipFileName(base: string, order: number,
                             episode?: number | null): string {
  const ep = episode != null ? `_第${pad2(episode)}集` : "";
  return `${base}${ep}_镜${pad3(order)}.mp4`;
}

/**
 * 拆分系统保存对话框返回的完整路径。
 *
 * 分隔符按路径本身判断而不是用 Tauri 的 `sep()`：save() 在 Windows 上回的是
 * `C:\Users\x\片名.mp4`，只认 `/` 会把整条路径当成文件名，于是"记住的导出目录"
 * 变成一串带盘符的垃圾，下次导出全落到错的地方。
 */
const sepIdx = (full: string) =>
  Math.max(full.lastIndexOf("/"), full.lastIndexOf("\\"));

/** 目录部分。没有分隔符（纯文件名）或分隔符在首位（POSIX 根目录）时原样返回 */
export function dirOf(full: string): string {
  const i = sepIdx(full);
  return i > 0 ? full.slice(0, i) : full;
}

/** 文件名部分（含扩展名） */
export function baseOf(full: string): string {
  return full.slice(sepIdx(full) + 1);
}

/** 去掉 .mp4 扩展名——回填到"文件名"输入框时不该带扩展名，
 *  否则用户再导一次就成了 `片名.mp4.mp4`。大小写不敏感（Windows 上可能是 .MP4）。 */
export function stripMp4(name: string): string {
  return name.replace(/\.mp4$/i, "");
}
