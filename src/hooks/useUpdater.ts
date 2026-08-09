import { useState } from "react";
import { check } from "@tauri-apps/plugin-updater";
import { APP_VERSION } from "../api";
import type { Say } from "./useToast";

export type UpdateState = "idle" | "checking" | "downloading" | "ready" | "none";

/** G4 状态分层 · UI 层：应用内静默更新（Tauri updater，浏览器通道 catch 降级）。 */
export function useUpdater(say: Say) {
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [updateProgress, setUpdateProgress] = useState(0);
  const [updateNotes, setUpdateNotes] = useState("");

  const checkUpdate = async () => {
    setUpdateState("checking");
    try {
      const update = await check();
      if (!update?.available) {
        setUpdateState("none");
        say(`已是最新版本 v${APP_VERSION}`, 3000);
        return;
      }
      setUpdateNotes(update.body ?? "");
      setUpdateState("downloading");
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          downloaded += event.data.chunkLength;
          setUpdateProgress(total > 0 ? Math.round((downloaded / total) * 100) : 0);
        }
        if (event.event === "Finished") setUpdateState("ready");
      });
    } catch (e) {
      setUpdateState("idle");
      say(`检查更新失败: ${e}`);
    }
  };

  return { updateState, setUpdateState, updateProgress, updateNotes, checkUpdate };
}
