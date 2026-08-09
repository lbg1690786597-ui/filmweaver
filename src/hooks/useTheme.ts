import { useEffect, useState } from "react";

/** G4 状态分层 · UI 层：主题切换（localStorage 记忆 + data-theme 挂 html）。 */
export function useTheme() {
  const [theme, setTheme] = useState<"dark" | "light">(
    () => (localStorage.getItem("fw_theme") as "dark" | "light") || "dark",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("fw_theme", theme);
  }, [theme]);
  const toggleTheme = () => setTheme(theme === "dark" ? "light" : "dark");
  return { theme, toggleTheme };
}
