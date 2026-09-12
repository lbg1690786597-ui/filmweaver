/**
 * osDrop — 接收**从系统拖进来**的文件（3.11 P0-b）
 *
 * ## 背景
 *
 * Tauri v2 的 `dragDropEnabled` 默认为 `true`，在 WebView2 上挂了一个系统级
 * `IDropTarget`。它把指针整个接管：从资源管理器拖文件进来时，页面收不到任何
 * `dragenter/dragover/drop`，页内自拖（`draggable` 属性那套）也被同一只手截走。
 * 这就是「资产拖不到轨道上」的根因 —— 光标始终是禁止样式，那个光标来自宿主。
 *
 * 用户点名「从资源管理器拖入文件的功能是必要的，不能舍弃」，所以不能靠关掉
 * `dragDropEnabled` 给页内 DnD 让路。分工是：
 *   · **来自系统的文件** → 宿主接住，由 `lib.rs` 的 `on_window_event` 发
 *     `fw://os-drop` 事件（本文件收）
 *   · **页内拖拽**（资产卡、素材、片段） → 走 Pointer Events，见 `pointerDrag.ts`
 *
 * ## 为什么读文件要绕一圈 Rust
 *
 * 事件给的是**路径**（`C:\...\陆沉.png`），不是 File 对象。fs 插件的 readFile
 * 受 capabilities 的 scope 约束（只声明了 `$APPDATA/**`），拖进来的文件在任意
 * 盘符上，读不到；把 scope 放成 `**` 又等于给这个应用开了任意文件读。
 * 所以走 `read_dropped_file`：它只认「本次会话里真的被拖放过」的路径。
 *
 * ## 浏览器里必须优雅退化
 *
 * 网页版（`/fw/app/`）没有 Tauri，`listen` 会直接抛。这不是错误 —— 浏览器本来
 * 就有原生的 HTML5 DnD，用户在网页上用的就是那一套。所以这里静默返回，
 * 绝不能让 `npm run dev` 的控制台刷一片红。
 */
import { invoke } from "@tauri-apps/api/core";
import { clipKind, type ClipKind } from "../types";

export type OsDropKind = ClipKind;

export interface OsDropEvent {
  /** `enter` / `over` / `drop` / `leave` */
  kind: "enter" | "over" | "drop" | "leave";
  paths: string[];
}

/** 路径 → 文件类别。**不自己维护一份扩展名表**：直接把文件名交给
 *  `clipKind`（素材池上传/媒体面板用的是同一份）。两边各写一份的话，
 *  拖进来的 `.gif` 会在这里算成图片、在库里算成 other，或者反过来。 */
export function kindOfPath(path: string): ClipKind {
  return clipKind(baseNameOf(path));
}

/** 路径 → 文件名（末段）。Windows 与 POSIX 两种分隔符都切，取更靠后的那个。 */
export function baseNameOf(path: string): string {
  const s = path.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** base64 → File。IPC 走 JSON，字节只能过 base64（见 lib.rs 的注释）。 */
export function fileFromBase64(b64: string, name: string, mime: string): File {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new File([buf], name, { type: mime });
}

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  bmp: "image/bmp", gif: "image/gif", heic: "image/heic", avif: "image/avif",
  mp4: "video/mp4", mov: "video/quicktime", mkv: "video/x-matroska",
  webm: "video/webm", avi: "video/x-msvideo", m4v: "video/x-m4v",
  mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", aac: "audio/aac",
  flac: "audio/flac", ogg: "audio/ogg", opus: "audio/opus",
};

export function mimeOf(name: string): string {
  const ext = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? "").toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

/** 读一个被拖入的文件（走 Rust 侧的白名单读取）。 */
export async function readDropped(path: string): Promise<File> {
  const b64 = await invoke<string>("read_dropped_file", { path });
  const name = baseNameOf(path);
  return fileFromBase64(b64, name, mimeOf(name));
}

/**
 * 订阅系统拖放事件。**只在 Tauri 里生效**，浏览器里静默返回一个空订阅。
 *
 * `over` 事件在拖拽过程中会以很高的频率触发，调用方**必须**自己节流
 * （见 App.tsx 里用 ref 挡重复值），否则每次都会 setState 重渲染整棵树。
 */
export function subscribeOsDrop(
  onEvent: (e: OsDropEvent) => void | Promise<void>,
): () => void {
  let un: (() => void) | null = null;
  let dead = false;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const u = await listen<OsDropEvent>("fw://os-drop", (ev) => {
        void onEvent(ev.payload);
      });
      // 动态 import 是异步的：如果在它解析完成之前组件就卸载了，
      // 这里必须立刻退订，否则监听器泄漏在 window 上，直到进程结束。
      if (dead) u(); else un = u;
    } catch {
      // 浏览器环境：没有 Tauri 运行时。原生 HTML5 DnD 照常工作，静默即可。
    }
  })();
  return () => { dead = true; un?.(); };
}
