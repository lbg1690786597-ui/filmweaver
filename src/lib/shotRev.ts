/**
 * shotRev — transform_meta 的版本号注册表（批次 2 / 2.3 乐观锁的客户端一半）
 *
 * ## 服务端只做比对，"拿哪个版本去比"是客户端的决定
 *
 * `PATCH /v2/shots/{id}/timeline` 收到 `base_transform_rev` 就拿它和库里的
 * 当前版本比，不一致回 409（见 `routes_v2.transform_rev`）。所以**乐观锁灵不灵，
 * 全看客户端送上去的是哪个版本号**：
 *
 *   - 送"我这次改动所基于的那个版本" → 别人在我编辑期间改过，我就被拒绝。✅
 *   - 送"库里最新的版本" → 永远相等，409 永不触发，锁形同不存在。❌
 *
 * 这两者的差别只在一个地方体现出来：**详情刷新回来时要不要更新版本号**。
 * 规则是「有未落库的本地改动就不更新」：
 *
 *   - 没有未落库改动 → 屏幕上显示的就是服务端的值，用户接下来的编辑是
 *     基于对方那一版做的，采纳新版本号是**正确的**（否则会冒出假冲突，
 *     用户明明在改自己眼前看到的东西却被告知"已被别人改过"）。
 *   - 有未落库改动 → 屏幕上是**用户自己**的值（2.2 的乐观盖层），
 *     他的编辑基于的是更早那一版，必须保留旧版本号，冲突才能被检出。
 *
 * 拖动过程中恰好一直有未落库值，所以「A 拖完落库、B 正在拖」这个最常见的
 * 并发场景一定能被逮到 —— 这不是巧合，是上面那条规则的直接后果。
 *
 * ## 冲突之后为什么"忘掉"版本号
 *
 * 409 之后我们 `forget()`：下一次写就不带 base、服务端跳过校验，用户**再操作
 * 一次即可以自己的版本为准**。反过来（一直带着旧 rev）会把用户锁死在
 * "怎么改都 409"里，那是把并发保护变成了故障。提示已经给过一次，
 * 之后的覆盖是他知情下的选择。
 *
 * ## 为什么单独一个无依赖模块
 *
 * 与 `lib/stagedWrite.ts` 同理：`api.ts` 顶上是 `import.meta.env`，在 node 下
 * 取不到，验证脚本 import 不进来。上面那条「有未落库改动就不更新」的规则
 * 正是本条成立的关键，必须能被 `verify-shot-rev.ts` 真的跑一遍，
 * 而不是靠读代码相信它。
 */

/** 只要有 id 和版本号就行——刻意不依赖 `ShotInfo`（那会拖进 api.ts） */
export interface RevSource {
  id: string;
  transform_rev?: string | null;
}

export interface RevRegistry {
  /** 详情回来时收下服务端版本号。`hasPending(id)` 为真的镜头**跳过**（见文件头） */
  seed: (shots: readonly RevSource[], hasPending?: (id: string) => boolean) => void;
  /** 这次 PATCH 要带的 base 版本号；undefined = 不带（服务端跳过校验） */
  base: (shotId: string) => string | undefined;
  /** 自己写成功后记下服务端回的新版本号 */
  noteWritten: (shotId: string, rev?: string | null) => void;
  /** 冲突后忘掉，让用户下一次操作能以自己的版本为准 */
  forget: (shotId: string) => void;
  /** 切项目/退出项目 */
  clear: () => void;
  /** 供验证脚本断言 */
  size: () => number;
}

export function createRevRegistry(): RevRegistry {
  const revs = new Map<string, string>();
  return {
    seed(shots, hasPending) {
      for (const s of shots) {
        const rev = s.transform_rev;
        // 后端没下发（老版本）→ 保持无 base：宁可退回"没有锁"，
        // 也不要用一个编造的版本号把所有写请求都变成 409。
        if (!rev) continue;
        if (hasPending?.(s.id)) continue;
        revs.set(s.id, rev);
      }
    },
    base: (shotId) => revs.get(shotId),
    noteWritten(shotId, rev) {
      if (rev) revs.set(shotId, rev);
      // 没回版本号（老后端）→ 删掉手里这个已经过期的，别拿它去比
      else revs.delete(shotId);
    },
    forget(shotId) { revs.delete(shotId); },
    clear() { revs.clear(); },
    size: () => revs.size,
  };
}

/** 全局单例：镜头 id 全局唯一，且 `commitTransform` 定义在 `useStagedTransform`
 *  之前（它要作为参数传进去），拿不到 hook 里的实例，故用模块级单例。
 *  工厂函数同时导出，供验证脚本建互不干扰的多个"客户端"。 */
export const shotRev = createRevRegistry();
