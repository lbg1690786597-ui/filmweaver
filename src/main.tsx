import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { IS_TAURI } from "./lib/isTauri";
import { setOutboxIO, hydrateOutbox } from "./lib/outboxStore";
import { tauriOutboxIO } from "./lib/persistIO";
import "./styles/tokens.css";
import "./styles.css";

// 6.8 离线补发队列的落盘实现在这里注入，**在 render 之前**。
//
// 位置是承重的：注入若放进 App 的 useEffect，就排在 `useProject` 那个
// "启动恢复现场"的 effect 之后（子 hook 的 effect 先跑），而断网启动时
// 那一下正是最早的失败请求。晚一步注入 = 那几笔只进内存队列，
// 用户关掉软件就没了 —— 恰恰是本条目要修的那件事。
//
// 浏览器 `/fw/app/` 下**不注入**：没有 `appDataDir()`。队列于是退化成纯内存，
// 界面据 `isDurable()` 如实改口，不假装能持久化（见 outboxStore 文件头）。
if (IS_TAURI) {
  setOutboxIO(tauriOutboxIO);
  // 上次没发出去的那些改动。读盘是异步的，不挡渲染 —— 队列空着的那几毫秒
  // 唯一的后果是横幅上的笔数晚一点出现，而补发本来就要等连上之后。
  void hydrateOutbox();
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>,
);
