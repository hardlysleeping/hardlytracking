import { DEFAULT_THEME, LEGACY_THEME_KEY, THEME_KEY, parseTheme, readTheme, themeVariables, type Theme, type ThemeSettings } from "./theme-model";
export type { Theme } from "./theme-model";

class Appearance {
  current = $state<ThemeSettings>({ ...DEFAULT_THEME });
  storageError = $state<string | null>(null);
  get theme(): Theme { return this.current.mode; }
  private media: MediaQueryList | null = null;
  private refresh = () => this.paint();

  private paint(): void {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.theme = this.current.mode;
    root.dataset.background = this.current.bgImage || this.current.bg ? "custom" : "default";
    root.dataset.glass = String(this.current.bgGlass);
    for (const [key, value] of Object.entries(themeVariables(this.current, this.media?.matches ?? false))) root.style.setProperty(key, value);
  }
  private save(): void {
    this.paint();
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(this.current));
      localStorage.setItem(LEGACY_THEME_KEY, this.current.mode);
      this.storageError = null;
    } catch {
      this.storageError = "Applied for this session, but this device could not save the theme. Try a smaller background image or clear it.";
    }
  }
  /** Existing callers keep the four-mode API without losing custom colours. */
  apply(theme: Theme): void { this.set("mode", theme); }
  set<K extends keyof ThemeSettings>(key: K, value: ThemeSettings[K]): void {
    this.current = parseTheme({ ...this.current, [key]: value });
    this.save();
  }
  reset(): void {
    this.current = { ...DEFAULT_THEME };
    this.save();
  }
  /** Called synchronously by App before Library.open(); safe to call repeatedly. */
  start(): void {
    this.media?.removeEventListener("change", this.refresh);
    this.media = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: light)") : null;
    this.media?.addEventListener("change", this.refresh);
    try { this.current = readTheme(localStorage); } catch { this.current = { ...DEFAULT_THEME }; }
    this.save();
  }
}
export const appearance = new Appearance();
export const THEME_OPTIONS: Array<{ id: Theme; label: string }> = [
  { id: "system", label: "System" }, { id: "light", label: "Light" },
  { id: "dark", label: "Dark" }, { id: "oled", label: "OLED black" },
];
