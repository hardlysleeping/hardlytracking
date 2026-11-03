/** Pure, field-validated device appearance. No database or network is involved. */
export type Theme = "system" | "light" | "dark" | "oled";
export const THEME_KEY = "hardlytracking.theme.v1";
export const LEGACY_THEME_KEY = "hardlytracking.theme";
export const MODES: Theme[] = ["system", "light", "dark", "oled"];
export const COLOUR_KEYS = ["accent", "hidden", "pinned", "lockOpen", "lockClosed", "unlock", "sync", "trim", "link", "star"] as const;
export type ColourKey = typeof COLOUR_KEYS[number];
export interface ThemeSettings extends Record<ColourKey, string> {
  mode: Theme;
  accentEdges: boolean;
  monotoneActions: boolean;
  bg: string | null;
  bgImage: string | null;
  bgBlur: number;
  bgDim: number;
  bgGlass: boolean;
}
export const DEFAULT_THEME: Readonly<ThemeSettings> = Object.freeze({
  mode: "system", accent: "#613583", hidden: "#e5484d", pinned: "#0078e0",
  lockOpen: "#e6b93f", lockClosed: "#f08c2e", unlock: "#3fbf6f", sync: "#28a06b",
  trim: "#7c8492", link: "#0078e0", star: "#e8b93c", accentEdges: true,
  monotoneActions: false, bg: null, bgImage: null, bgBlur: 0, bgDim: 0, bgGlass: false,
});
export const MAX_BG_BLUR = 24;
export const MAX_BG_DIM = 60;
export const MAX_IMAGE_LENGTH = 2_000_000;
export function normaliseColour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim().toLowerCase();
  if (/^#[a-f0-9]{6}$/.test(s)) return s;
  return /^#[a-f0-9]{3}$/.test(s) ? "#" + [...s.slice(1)].map(c => c + c).join("") : null;
}
/** Raster-only base64: no SVG, remote tracking URL, CSS escapes, or executable schemes. */
export function validBackgroundImage(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_IMAGE_LENGTH &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
}
function bounded(value: unknown, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(Math.max(0, Math.min(max, value))) : 0;
}
export function parseTheme(raw: unknown, legacyMode?: unknown): ThemeSettings {
  const s = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const result = { ...DEFAULT_THEME };
  result.mode = MODES.includes(s.mode as Theme) ? s.mode as Theme : MODES.includes(legacyMode as Theme) ? legacyMode as Theme : "system";
  for (const key of COLOUR_KEYS) result[key] = normaliseColour(s[key]) ?? DEFAULT_THEME[key];
  for (const key of ["accentEdges", "monotoneActions", "bgGlass"] as const) {
    if (typeof s[key] === "boolean") result[key] = s[key];
  }
  result.bg = normaliseColour(s.bg);
  result.bgImage = validBackgroundImage(s.bgImage) ? s.bgImage : null;
  result.bgBlur = bounded(s.bgBlur, MAX_BG_BLUR);
  result.bgDim = bounded(s.bgDim, MAX_BG_DIM);
  return result;
}
export function readTheme(storage: Pick<Storage, "getItem">): ThemeSettings {
  let legacy: string | null = null;
  try { legacy = storage.getItem(LEGACY_THEME_KEY); } catch { /* denied */ }
  try { return parseTheme(JSON.parse(storage.getItem(THEME_KEY) ?? "null"), legacy); }
  catch { return parseTheme(null, legacy); }
}
export function luminance(hex: string): number {
  const c = normaliseColour(hex) ?? "#000000";
  const rgb = [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16) / 255).map(n => n <= .04045 ? n / 12.92 : ((n + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
export function contrast(a: string, b: string): number {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}
/** Keep the chosen hue, lifting/darkening only text tokens to at least 4.5:1. */
export function readableColour(hex: string, background: string): string {
  if (contrast(hex, background) >= 4.5) return hex;
  const target = luminance(background) < .3 ? 255 : 0;
  for (let step = 1; step <= 100; step++) {
    const c = "#" + [1, 3, 5].map(i => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - step / 100) + target * step / 100).toString(16).padStart(2, "0")).join("");
    if (contrast(c, background) >= 4.5) return c;
  }
  return target ? "#ffffff" : "#000000";
}
export function themeVariables(theme: ThemeSettings, systemLight = false): Record<string, string> {
  const light = theme.mode === "light" || theme.mode === "system" && systemLight;
  const safeBg = light ? "#f6f6f8" : theme.mode === "oled" ? "#000000" : "#0e0e12";
  const surface = light ? "#ffffff" : theme.mode === "oled" ? "#0a0a0c" : "#15151b";
  const vars: Record<string, string> = {
    "--accent": theme.accent, "--accent-text": readableColour(theme.accent, surface),
    "--accent-ink": contrast(theme.accent, "#ffffff") > contrast(theme.accent, "#000000") ? "#ffffff" : "#000000",
    "--page-bg": theme.bg ?? safeBg,
    "--bg-image": theme.bgImage ? `url("${theme.bgImage}")` : "none",
    "--bg-blur": `${theme.bgBlur}px`, "--bg-dim": String(theme.bgDim / 100),
    "--glass": theme.bgGlass ? "94%" : "100%",
    "--edge": theme.accentEdges ? "color-mix(in srgb, var(--accent) 24%, var(--base-line))" : "var(--base-line)",
    "--edge-strong": theme.accentEdges ? "color-mix(in srgb, var(--accent) 36%, var(--base-line-strong))" : "var(--base-line-strong)",
  };
  for (const key of COLOUR_KEYS.filter(k => k !== "accent")) {
    const name = key.replace(/[A-Z]/g, c => "-" + c.toLowerCase());
    vars[`--tone-${name}`] = theme[key];
    vars[`--tone-${name}-text`] = readableColour(theme[key], surface);
  }
  for (const [action, key] of [["star", "star"], ["read", "trim"], ["link", "link"]] as const) {
    vars[`--act-${action}`] = theme.monotoneActions ? "var(--text-2)" : `var(--tone-${key}-text)`;
  }
  return vars;
}
