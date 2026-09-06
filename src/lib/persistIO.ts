/**
 * lib/persistIO.ts — `outbox` 与 `snapshot` 的桌面端落盘实现（6.8）
 *
 * 单独一个文件，因为它 `import` 了 `@tauri-apps/*` —— 这些在浏览器与 node 下
 * 都加载不了。规则层（`outbox.ts` / `snapshot.ts` / `outboxStore.ts`）刻意
 * 不碰它们，那边才验得了。本文件只做三件事：拼路径、读写 JSON、吞掉
 * "文件不存在"这一类正常缺失。
 *
 * 落点沿用素材缓存的目录（`lib/cacheName.ts` 的 `CACHE_ROOT`）：
 *   · 队列：`appDataDir()/cache/outbox.json`（**跨项目共用一份**，
 *     因为断线时用户可能已经切过项目，按项目分文件会把队列切碎）
 *   · 快照：`appDataDir()/cache/<projectId>/detail.json`
 *     （放进项目目录，用户在设置里清缓存时跟着一起清掉 —— 快照是缓存，
 *     清掉的后果只是下次要联网加载，没有数据损失）
 *
 * ⚠️ 队列文件**不进项目目录**，所以清素材缓存不会误删它：那里面是用户
 * 还没送出去的改动，属于数据不属于缓存，清缓存把它清掉是不能接受的。
 */

import { appDataDir, join } from "@tauri-apps/api/path";
import { exists, mkdir, readTextFile, writeTextFile, remove } from "@tauri-apps/plugin-fs";
import { CACHE_ROOT } from "./cacheName";
import type { OutboxIO, QueuedWrite } from "./outbox";
import { SNAPSHOT_NAME, type ProjectSnapshot, type SnapshotIO } from "./snapshot";

const OUTBOX_NAME = "outbox.json";

async function cacheDir(): Promise<string> {
  const dir = await join(await appDataDir(), CACHE_ROOT);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

async function projectDir(projectId: string): Promise<string> {
  const dir = await join(await cacheDir(), projectId);
  if (!(await exists(dir))) await mkdir(dir, { recursive: true });
  return dir;
}

/** 读 JSON；文件不存在或解析失败一律当**没有**。
 *
 *  解析失败也吞掉是刻意的：一个写坏的队列文件若让启动抛异常，用户会
 *  **整个软件打不开**，而代价只是丢掉那一份本就读不出来的队列。 */
async function readJson<T>(path: string): Promise<T | null> {
  try {
    if (!(await exists(path))) return null;
    return JSON.parse(await readTextFile(path)) as T;
  } catch (e) {
    console.warn("[persistIO] 读取失败，按不存在处理:", path, e);
    return null;
  }
}

export const tauriOutboxIO: OutboxIO = {
  async load() {
    const path = await join(await cacheDir(), OUTBOX_NAME);
    const q = await readJson<QueuedWrite[]>(path);
    return Array.isArray(q) ? q : [];
  },
  async save(queue) {
    const path = await join(await cacheDir(), OUTBOX_NAME);
    if (queue.length === 0) {
      // 空队列就把文件删掉，而不是写一个 `[]`：下次启动少一次读盘，
      // 也免得用户在缓存目录里看到一个"还有东西没发"的文件而虚惊。
      if (await exists(path)) await remove(path);
      return;
    }
    await writeTextFile(path, JSON.stringify(queue));
  },
};

export const tauriSnapshotIO: SnapshotIO = {
  async read(projectId) {
    const path = await join(await projectDir(projectId), SNAPSHOT_NAME);
    return await readJson<ProjectSnapshot>(path);
  },
  async write(snap) {
    const path = await join(await projectDir(snap.projectId), SNAPSHOT_NAME);
    await writeTextFile(path, JSON.stringify(snap));
  },
  async remove(projectId) {
    const path = await join(await projectDir(projectId), SNAPSHOT_NAME);
    if (await exists(path)) await remove(path);
  },
};
