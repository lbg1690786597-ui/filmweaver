import { useCallback, useEffect, useRef, useState } from "react";
import { api, ProjectDetail } from "../api";
import { prefetcher } from "../lib/mediaCache";
import { IS_TAURI } from "../lib/isTauri";
import { tauriSnapshotIO } from "../lib/persistIO";
import { isUsableSnapshot, makeSnapshot } from "../lib/snapshot";

/** G4 状态分层 · 项目层：当前项目 + detail 快照 + 刷新（含 800ms 合并刷新）。
 *
 * T-R0-07 状态云端化：projectId 记 localStorage，启动恢复现场；
 * detail 是全部视图的唯一数据源（镜头/分集/资产），刷新统一走这里。
 *
 * 6.8：detail 每次成功加载都**落盘一份快照**，断网启动时读回来。
 * 没有它，6.7「断线时手上有数据就留在编辑器」只在软件一直开着的情况下成立，
 * 而离线最常见的场景恰恰是关掉之后再打开。详见 `lib/snapshot.ts`。 */
export function useProject() {
  const [projectId, setProjectId] = useState<string | null>(
    () => localStorage.getItem("fw_project") || null,
  );
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  /** detail 来自本机快照而非服务端 —— 断线横幅要据此说明"你看到的不是最新的" */
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null);

  // 请求序号：并发的 refreshDetail（refreshSoon 合并刷新、SSE 触发、各 patch 后的
  // 刷新会同时在飞）返回顺序不保证，先发的可能后到并**覆盖新数据** ——
  // 表现为刚拖完的时长/顺序又跳回旧值。只接受最后一次发出的那个响应。
  const seq = useRef(0);

  /** detail 的镜像。**不能**把 detail 放进 refreshDetail 的依赖：那会让它
   *  每次数据变化都换一个新引用，而 refreshSoon 及若干 effect 都依赖它，
   *  连锁触发的是一串多余的全量刷新（正是 P2-5 合并刷新要压掉的东西）。
   *  这里只需要读一个"内存里到底有没有数据"的瞬时值，ref 正合适。 */
  const detailRef = useRef<ProjectDetail | null>(null);

  const refreshDetail = useCallback(async (pid?: string) => {
    const id = pid ?? projectId;
    if (!id) return;
    const my = ++seq.current;
    try {
      const d = await api.projectDetail(id);
      // 期间又发起了新请求 → 本次结果已过期，丢弃
      if (my !== seq.current) return;
      // 切项目时上一项目的 in-flight 请求也会走到这里，
      // clearDetail() 清不掉飞行中的 promise，所以再确认一次归属
      if (id !== (pid ?? projectId)) return;
      setDetail(d);
      detailRef.current = d;
      setSnapshotAt(null);        // 拿到真数据了，不再是快照
      // 6.8：落盘。放在**序号校验之后**是承重的——过期响应本来就不该
      // 进 setDetail，更不该覆盖盘上那份更新的快照（那会让下次断网启动
      // 读回一个比内存里更旧的世界，且完全看不出来）。
      if (IS_TAURI) {
        void tauriSnapshotIO.write(makeSnapshot(id, d, Date.now()))
          .catch((e) => console.warn("[useProject] 快照落盘失败:", e));
      }
      // 6.2 AI 产物即时落盘：这是前端**唯一**得知素材 URL 的地方，所以预取的
      // 触发点只能挂在这儿。语义是「基线 + 增量」——第一次见到这个项目只记账，
      // 之后新冒出来的 URL 才下载，而"新冒出来"恰好等价于"某个 AI 任务刚完成"。
      // 详见 lib/prefetch.ts 的文件头（含为什么不能"detail 里有的都下一遍"）。
      prefetcher.warmNew(d.id, "shots", d.shots.map((s) => s.video_url));
    } catch (e) {
      if (my !== seq.current) return;
      // ⚠️ 只有"项目确实不存在"才清场。
      // 原来是无差别 catch —— 一次 5xx 或断网就 setProjectId(null) +
      // 删 localStorage，把正在工作的用户直接弹回项目列表，未保存的
      // 选中态/预览全没了。网络抖动比项目被删常见得多。
      const status = (e as { status?: number })?.status;
      const notFound = status === 404 || status === 410;
      if (notFound) {
        setProjectId(null);
        localStorage.removeItem("fw_project");
        // 项目真没了，盘上那份快照也不该再留着骗下一次启动
        if (IS_TAURI) void tauriSnapshotIO.remove(id).catch(() => {});
        return;
      }
      // 其余错误保持现状，让用户可以重试；detail 仍是上一次的可用快照
      console.warn("[useProject] 刷新失败，保留当前项目:", e);
      // 6.8：内存里**还没有**任何 detail（= 断网启动）时，退回本机快照。
      // 已经有 detail 就不动——盘上那份只会比内存里的旧。
      if (IS_TAURI && detailRef.current === null) {
        try {
          const snap = await tauriSnapshotIO.read(id);
          if (my !== seq.current) return;
          if (isUsableSnapshot(snap, id)) {
            setDetail(snap.detail as ProjectDetail);
            detailRef.current = snap.detail as ProjectDetail;
            setSnapshotAt(snap.savedAt);
          }
        } catch (err) {
          console.warn("[useProject] 快照读取失败:", err);
        }
      }
    }
  }, [projectId]);

  // P2-5：事件可能连发（多镜并发流转），800ms 合并一次全量刷新，避免 detail 请求风暴
  const refreshTimer = useRef<number | null>(null);
  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = window.setTimeout(() => {
      refreshTimer.current = null;
      void refreshDetail();
    }, 800);
  }, [refreshDetail]);

  /** 切/关项目时清 detail 与待执行的合并刷新（防旧项目延迟刷新串到新项目） */
  const clearDetail = useCallback(() => {
    if (refreshTimer.current) { clearTimeout(refreshTimer.current); refreshTimer.current = null; }
    setDetail(null);
    detailRef.current = null;
    setSnapshotAt(null);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (projectId) refreshDetail(projectId); }, []); // 启动恢复现场

  return { projectId, setProjectId, detail, snapshotAt, refreshDetail, refreshSoon, clearDetail };
}
