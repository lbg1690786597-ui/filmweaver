/**
 * features/export/exportRun.ts — 一次导出（可能产出多个文件）的**规则层**
 *
 * 6.0 新增。起因是「按集导出五集只出了第一集」这个真机 bug：那段逻辑此前整个
 * 长在 `App.doLocalExport` 里，而 App 里的东西**一行都测不到**——
 * `verify-episode-export.ts` 的第 17 项只覆盖到 plan 层「挑若干集各自独立成片」，
 * 覆盖不到"循环真的把 5 个 job 都跑完了吗"。于是这个 bug 能一路走到用户机器上。
 *
 * 所以把两件与 I/O 无关的事搬出来做成纯函数：
 *   · `planEpisodeJobs` —— 选了哪几集 → 排出哪几个 job；
 *   · `summarizeExportRun` —— 各 job 的收场 → 该给用户看什么。
 *
 * 这里**没有** ffmpeg、没有 Tauri、没有 React，node 下直接可跑。
 */

/** 排 job 只需要镜头的集号；其余字段与本模块无关。 */
export interface EpisodeShotLike {
  episode?: number | null;
}

export interface EpisodeJobPlan<S> {
  episode: number;
  shots: S[];
}

/**
 * 按集导出：把镜头分到各集，产出**每集一个** job。
 *
 * · 集号顺序以 `episodes` 为准（对话框给的是升序）；
 * · 某集没有可导镜头 → **跳过**而不是产出一个空文件；
 * · 镜头的 `episode` 缺省算第 1 集（与 ExportDialog 的筛选口径一致）。
 *
 * ⚠️ 不去重 `episodes`：重复集号会排出重复 job，那是调用方的错，
 *    但静默吞掉更糟（用户以为导了 5 集，实际 4 集，且没人告诉他）。
 *    对话框的 `toggleEp` 结构上不会产生重复，这里只是不掩盖。
 */
export function planEpisodeJobs<S extends EpisodeShotLike>(
  shots: S[], episodes: number[],
): EpisodeJobPlan<S>[] {
  const out: EpisodeJobPlan<S>[] = [];
  for (const ep of episodes) {
    const picked = shots.filter((s) => (s.episode ?? 1) === ep);
    if (picked.length) out.push({ episode: ep, shots: picked });
  }
  return out;
}

/** 单个产出文件的收场。 */
export type JobOutcome =
  | { label: string; ok: true }
  | { label: string; ok: false; error: string };

export interface RunSummary {
  /** 成功落盘的文件数 */
  okCount: number;
  /** 失败的 job（顺序同 jobs） */
  failed: { label: string; error: string }[];
  /** 结果面板要显示的失败说明；无失败时为空数组 */
  notices: string[];
  /** toast 正文；null 表示不该弹（用户主动取消且一个都没出） */
  toast: string | null;
  /** 是否该切到"已完成"结果面板（只要有文件落盘就该切） */
  showResult: boolean;
}

/**
 * 汇总一次导出的收场。
 *
 * ## 为什么失败**不能**中断整批（Bug A 的第三道修法）
 *
 * 旧行为：任一集抛异常 → for 循环整个塌掉 → 剩下的集一集不导 →
 * 只有一条 4 秒就消失的 `导出失败：…` toast。用户看到的是"只导出了第一集"，
 * 根本不知道有报错，更不知道是哪一集、为什么。他能想到的办法只有
 * "取消一集、再导一次"，重复五遍——这正是用户实际做的事。
 *
 * 一集导失败与另外四集能不能导，**没有因果关系**（各自是独立的 ffmpeg 进程、
 * 独立的输出文件）。所以：单集失败只记账、继续跑下一集，最后一次性说清楚
 * "5 集里成了 4 集，第 2 集失败，原因是 X"。**只有用户取消才中断整批**——
 * 那是他自己的意思。
 *
 * @param outcomes 各 job 的收场，顺序同 jobs
 * @param aborted  是否因用户取消而提前收场
 * @param dirHint  多文件时 toast 里要提的目录（成片所在文件夹）
 */
export function summarizeExportRun(
  outcomes: JobOutcome[],
  aborted: boolean,
  dirHint: string,
  tail: string,
): RunSummary {
  const okCount = outcomes.filter((o) => o.ok).length;
  const failed = outcomes.flatMap((o) => (o.ok ? [] : [{ label: o.label, error: o.error }]));

  // 失败说明进结果面板而不是 toast：toast 一行、4 秒，装不下"哪一集为什么失败"，
  // 而这正是用户唯一需要知道的东西。面板会一直留在那儿等他读完。
  const notices = failed.map((f) => `❌ ${f.label || "本次导出"}失败：${f.error}`);

  if (aborted) {
    return {
      okCount, failed, notices, showResult: okCount > 0,
      // 已落盘的那几集是完整可用的，必须说；否则用户以为全白跑了会重导一遍。
      toast: okCount > 0 ? `已取消导出（前 ${okCount} 个文件已完成并保存）` : "已取消导出",
    };
  }

  if (!okCount) {
    return {
      okCount, failed, notices, showResult: false,
      toast: failed.length
        ? `导出失败：${failed[0].error}`
        : "没有可导出的内容",
    };
  }

  const total = outcomes.length;
  const head = failed.length
    // 部分成功是最容易被误读的一种收场（用户只会看到文件夹里少了几个文件），
    // 所以把"几个成了、几个没成"直接写在第一句，并把人引到面板看原因。
    ? `⚠️ 已导出 ${okCount}/${total} 个文件到 ${dirHint}，${failed.length} 个失败（见导出面板）`
    : total > 1
      ? `✅ 已导出 ${okCount} 个文件到 ${dirHint}`
      : `✅ 已导出到 ${dirHint}`;
  return { okCount, failed, notices, showResult: true, toast: head + tail };
}
