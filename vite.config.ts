import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 要求固定端口；1430 避开 drama downloader 的 1420
export default defineConfig({
  // 相对路径产物：Tauri(tauri://localhost 根路径) 与 Web 子路径挂载(/fw/app/) 都成立。
  // 若用默认的 "/"，产物会写死 /assets/...，在 /fw/app/ 下会被 nginx 转到别的服务导致 404。
  base: "./",
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
});