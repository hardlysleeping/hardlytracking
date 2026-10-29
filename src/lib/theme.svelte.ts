/**
 * Appearance: one attribute on `<html>`, and the tokens do the rest.
 *
 * localStorage rather than the library database on purpose — the theme has to apply before the
 * database is open, or every launch flashes the wrong colour for a frame.
 */
export type Theme = "system" | "light" | "dark" | "oled";

const KEY = "hardlytracking.theme";
const OPTIONS: Theme[] = ["system", "light", "dark", "oled"];

class Appearance {
  theme = $state<Theme>("system");

  apply(theme: Theme): void {
    this.theme = theme;
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      // A private-mode browser refusing storage must not stop the theme from applying.
    }
  }

  start(): void {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(KEY);
    } catch {
      stored = null;
    }
    this.apply(OPTIONS.includes(stored as Theme) ? (stored as Theme) : "system");
  }
}

export const appearance = new Appearance();
export const THEME_OPTIONS: Array<{ id: Theme; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
  { id: "oled", label: "OLED black" },
];
