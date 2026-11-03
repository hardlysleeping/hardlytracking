/** Device-only hosted source settings. Secrets never enter the library DB, backups or sync. */
import { normalizeSuwayomiBase, suwayomiTransport } from "../api/suwayomi";

const BASE = "hardlytracking.suwayomi";
const USER = "hardlytracking.suwayomiUser";
const PASSWORD = "hardlytracking.suwayomiPassword";
const ENABLED = "hardlytracking.suwayomiEnabled";

export interface SuwayomiSettings { baseUrl: string; username: string; password: string }
export interface SuwayomiProbe { ok: boolean; error?: string; sources?: string[] }

function read(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}
function write(key: string, value: string): void {
  try {
    if (value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* Storage-disabled browsers still open the device library. */ }
}
export function suwayomiBaseUrl(): string { return read(BASE); }
export function suwayomiSettings(): SuwayomiSettings | null {
  const baseUrl = suwayomiBaseUrl();
  return baseUrl === "" ? null : { baseUrl, username: read(USER), password: read(PASSWORD) };
}
export function suwayomiConfigured(): boolean { return suwayomiSettings() !== null; }
/** Default-on also preserves the existing browser /api/mihon fallback before a URL is entered. */
export function suwayomiEnabled(): boolean { return read(ENABLED) !== "off"; }
export function setSuwayomiEnabled(enabled: boolean): void { write(ENABLED, enabled ? "on" : "off"); }
export function setSuwayomiSettings(next: Partial<SuwayomiSettings>): void {
  if (next.baseUrl !== undefined) write(BASE, next.baseUrl.trim() === "" ? "" : normalizeSuwayomiBase(next.baseUrl));
  if (next.username !== undefined) write(USER, next.username.trim());
  if (next.password !== undefined) write(PASSWORD, next.password);
}
export function clearSuwayomi(): void {
  for (const key of [BASE, USER, PASSWORD, ENABLED]) write(key, "");
}

/** Read-only source-list probe, bounded across both response headers and JSON body. Never saves. */
export async function probeSuwayomi(
  settings: SuwayomiSettings, fetchImpl?: typeof fetch, deadlineMs = 8_000,
): Promise<SuwayomiProbe> {
  try {
    const transport = suwayomiTransport({ ...settings, ...(fetchImpl ? { fetchImpl } : {}), deadlineMs });
    const data = await transport.gql<{ sources: { nodes: Array<{ displayName?: string; name?: string }> } }>(
      "query Sources { sources { nodes { displayName name } } }",
    );
    if (!Array.isArray(data.sources?.nodes)) throw new Error("Suwayomi returned no source list");
    return { ok: true, sources: data.sources.nodes.map(source => source.displayName || source.name || "Unnamed source") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
