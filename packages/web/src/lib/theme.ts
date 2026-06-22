import { useCallback, useState } from "react";

const KEY = "paddock:theme";

/** Whether the app is currently dark — driven by the `dark` class on <html>,
 *  which an inline script in index.html applies before first paint (no flash). */
function isDarkNow(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

/**
 * Light/dark theme toggle (issue #23). The initial theme is set by an inline
 * script in index.html (reads localStorage `paddock:theme`, defaults to dark),
 * so there's no flash-of-wrong-theme; this hook flips the `dark` class on <html>
 * and persists the choice. Tailwind is configured `darkMode: "class"`.
 */
export function useTheme(): { dark: boolean; toggle: () => void } {
  const [dark, setDark] = useState(isDarkNow);
  const toggle = useCallback(() => {
    setDark((prev) => {
      const next = !prev;
      document.documentElement.classList.toggle("dark", next);
      try {
        localStorage.setItem(KEY, next ? "dark" : "light");
      } catch {
        /* localStorage unavailable — theme still applies for this session */
      }
      return next;
    });
  }, []);
  return { dark, toggle };
}
