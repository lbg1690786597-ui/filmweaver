/**
 * bench/shotsBenchEntry.tsx — 镜头列表渲染成本基准（浏览器侧被测体）
 *
 * 由 `scripts/bench-shots.ts` 用 esbuild 打包、再用 playwright 装进无头
 * chromium 跑。之所以要真浏览器：U2 问的是"1424 张卡片重渲染一次要多久"，
 * 这个数字只能由真的 React 提交 + 真的 DOM 给出，node 里模拟不了。
 *
 * 量三件事：
 *   mount   首次挂载 N 张卡（打开大项目的代价，虚拟化省的就是它）
 *   one     只有 1 个镜头换了对象引用（= 修好之后的一次 refreshDetail）
 *   all     每个镜头都是新对象（= 修之前的每一次 refreshDetail）
 *
 * `one` 与 `all` 的差值就是 `lib/reconcileDetail.ts` + ShotsPanel 稳定回调
 * 这两处改动的全部收益；`mount` 与 DOM 节点数则决定"还需不需要虚拟化"。
 *
 * ⚠️ 用 `flushSync` + `performance.now()` 而不是 `<Profiler>` 的 actualDuration：
 *    Profiler 的计时只在 React 的 **开发/profiling** 构建里有值，生产构建下恒为 0
 *    （第一次跑就踩到了：三行数字全是 0.0 ms）。而"用户装的软件"跑的正是生产构建，
 *    所以这里改成强制同步提交再量墙钟时间 —— 量的就是生产构建的真实成本。
 *    代价是把 React 的并发切片关掉了，这对"一次提交多贵"的测量反而更干净。
 *
 * ⚠️ 墙钟只含 React 渲染+提交，**不含浏览器布局与绘制**。所以另外量一次强制布局
 *    （读 offsetHeight）并报 DOM 节点数，否则会低估"卡"的实际来源。
 */

import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import ShotsPanel from "../../src/components/ShotsPanel";
import type { ShotInfo } from "../../src/api";
import "../../src/styles/tokens.css";
import "../../src/styles.css";

const STATUSES: ShotInfo["status"][] = ["pending", "prompting", "generating", "review", "adopted", "failed"];

/** 造一镜。字段尽量贴真实载荷（1424 镜项目实测 1672 KB ≈ 每镜 1.2 KB）。 */
function makeShot(i: number): ShotInfo {
  const ep = Math.floor(i / 24) + 1;
  return {
    id: `shot${String(i).padStart(5, "0")}`,
    order: i + 1,
    episode: ep,
    script_ref: `第${ep}集 第${i % 24 + 1}镜：${"人物对话与动作描写".repeat(3)}`,
    link_to_prev: i % 3 === 0 ? "continuous" : "cut",
    characters: i % 2 ? ["林夏", "陈默"] : ["林夏"],
    location: `楚家公馆-客厅${i % 7}`,
    location_canonical: `楚家公馆-客厅${i % 7}`,
    video_url: i % 3 ? `/fw/media/generated/v${i}.mp4` : null,
    thumb_url: i % 3 ? `/fw/media/generated/t${i}.jpg` : null,
    status: STATUSES[i % STATUSES.length],
    fail_reason: i % 11 === 0 ? "渠道返回 500" : null,
    fail_kind: i % 11 === 0 ? "channel" : null,
    adopted_version: i % 3 ? 1 : null,
    is_special: false,
    gen_prompt: `${"中景，林夏站在客厅落地窗前，暖调侧逆光，浅景深。".repeat(2)}`,
    stale: i % 17 === 0,
    stale_reason: i % 17 === 0 ? "regen" : null,
    stale_hint: i % 17 === 0 ? "旁白时长变了，重出片即可" : null,
    prompt_state: (["draft", "aligned", "sent", "manual"] as const)[i % 4],
    duration_sec: 3 + (i % 9),
    disabled: false,
    special_name: null,
    ref_overrides: null,
    refs_stale: false,
    first_frame_url: i % 2 ? `/fw/media/generated/ff${i}.jpg` : null,
    profile_override: null,
    track_index: 0,
    transform_meta: null,
    transform_rev: null,
  };
}

const noop = () => {};

let setShots: ((s: ShotInfo[]) => void) | null = null;

function Harness({ initial }: { initial: ShotInfo[] }) {
  const [shots, set] = useState(initial);
  setShots = set;
  return (
    /* projectId 故意给空串：ShotsPanel 的 loadRd 在没有 projectId 时
       直接 setRd(null) 返回，不会往 8002 发请求 —— 基准要量的是渲染，
       不该把网络往返混进来（也不该在验证脚本里真连后端）。 */
    <ShotsPanel projectId="" shots={shots} episodes={[]}
      selectedShotId={null} cursorOrder={null}
      onSelect={noop} onGenerate={noop} onSwitchVersion={noop} onAdvanced={noop}
      generating={false} onBreakdown={noop} breakdownProgress={null}
      hasScript onFirstFrames={noop} onReprompt={noop} onPipeline={noop}
      onGotoAssets={noop} onCostumeScan={noop} onToast={noop} />
  );
}

export interface BenchApi {
  mount(n: number): Promise<{ ms: number; nodes: number; layoutMs: number }>;
  update(mode: "one" | "all"): Promise<{ ms: number; layoutMs: number; cards: number }>;
}

const bench: BenchApi = {
  async mount(n) {
    const host = document.getElementById("root")!;
    host.innerHTML = "";
    const shots = Array.from({ length: n }, (_, i) => makeShot(i));
    const root = createRoot(host);
    const t0 = performance.now();
    flushSync(() => root.render(<Harness initial={shots} />));
    const ms = performance.now() - t0;
    // 强制一次同步布局：React 提交完只是 DOM 建好了，浏览器还得排版 N 张卡
    const t1 = performance.now();
    void host.offsetHeight;
    const layoutMs = performance.now() - t1;
    return { ms, nodes: host.querySelectorAll("*").length, layoutMs };
  },
  async update(mode) {
    const host = document.getElementById("root")!;
    const cards = host.querySelectorAll(".sp-shot").length;
    if (!cards || !setShots) throw new Error("先 mount");
    const base = Array.from({ length: cards }, (_, i) => makeShot(i));
    let next: ShotInfo[];
    if (mode === "all") {
      // 每一项都是新对象 = 修复前 refreshDetail 的产物
      next = base;
    } else {
      // 先把这批引用坐实成"上一轮"，再只换第 0 镜 —— 这正是 reconcileDetail 的产物
      flushSync(() => setShots!(base));
      next = base.slice();
      next[0] = { ...base[0], video_url: "/fw/media/generated/NEW.mp4", status: "adopted" };
    }
    const t0 = performance.now();
    flushSync(() => setShots!(next));
    const ms = performance.now() - t0;
    // 同一次交互里浏览器还要为改动过的 DOM 重排 —— 全表换一遍属性时这笔
    // 比 React 自己那几毫秒贵得多，不量它等于漏掉"卡"的主要来源
    const t1 = performance.now();
    void host.offsetHeight;
    return { ms, layoutMs: performance.now() - t1, cards };
  },
};

(window as unknown as { __bench: BenchApi }).__bench = bench;
