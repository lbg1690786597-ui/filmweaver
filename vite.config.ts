import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri 要求固定端口；1430 避开 drama downloader 的 1420
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1430,
    strictPort: true,
  },
});