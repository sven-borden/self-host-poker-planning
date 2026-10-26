import { create } from "zustand";
import { applyThemeMode, readThemeMode, type ThemeMode, writeThemeMode } from "./theme.ts";

interface ThemeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

/**
 * The theme mode the person picked, read from storage when the module loads. The page
 * already shows it: public/theme-init.js applied it before first paint.
 */
export const useThemeStore = create<ThemeState>()((set) => ({
  mode: typeof window === "undefined" ? "system" : readThemeMode(),
  setMode: (mode) => {
    writeThemeMode(mode);
    applyThemeMode(mode);
    set({ mode });
  },
}));

export function useThemeMode(): [ThemeMode, (mode: ThemeMode) => void] {
  const mode = useThemeStore((state) => state.mode);
  const setMode = useThemeStore((state) => state.setMode);
  return [mode, setMode];
}
