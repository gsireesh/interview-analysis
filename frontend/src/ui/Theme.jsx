import { useCallback, useEffect, useState } from "react";
import { recall, remember } from "../lib/util.js";

// Byte-identical to the key the hand-written pages used, so a preference set
// before this rewrite survives it.
const THEME_KEY = "subtitle-search:theme";
const ORDER = ["auto", "light", "dark"];

/** The stored theme, applied to <html> so CSS can answer on first paint. */
export function useTheme() {
  const [theme, setTheme] = useState(() => recall(THEME_KEY, "auto"));

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    remember(THEME_KEY, theme);
  }, [theme]);

  const cycle = useCallback(() => {
    setTheme((current) => ORDER[(ORDER.indexOf(current) + 1) % ORDER.length]);
  }, []);

  return [theme, cycle];
}

export function ThemeToggle() {
  const [theme, cycle] = useTheme();
  return (
    <button
      className="btn btn--icon"
      type="button"
      onClick={cycle}
      title={`Theme: ${theme}. Click to switch.`}
      aria-label={`Switch theme (currently ${theme})`}
    >
      ◐
    </button>
  );
}
