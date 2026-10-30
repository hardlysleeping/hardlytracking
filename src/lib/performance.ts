/**
 * How hard the app is allowed to work.
 *
 * The failure this prevents is real and was measured: a download queue that fetches every page of
 * every chapter at once turns a quiet machine into a frozen one, and the app that did it looks
 * broken rather than busy. A "level" is a promise about work in flight — pages fetched at once,
 * covers warmed at once, and a pause between page requests — not a cosmetic setting.
 *
 * It is deliberately not a cgroup or a `nice`: those need privileges this app does not have on a
 * phone or in a browser. What it can always do is ask for less work at a time.
 */
export type CpuLevel = "unrestricted" | "balanced" | "quiet" | "background";

export interface WorkBudget {
  /** Pages fetched at the same time while downloading a chapter. */
  downloadConcurrency: number;
  /** Covers warmed at the same time when a screen of the grid appears. */
  imageWarmBatch: number;
  /** Pause between page requests while downloading, ms. */
  pagePacingMs: number;
  /** Longest a single page fetch may take before it is abandoned, ms. */
  pageTimeoutMs: number;
}

export const CPU_LEVELS: Array<{ id: CpuLevel; label: string; hint: string }> = [
  { id: "unrestricted", label: "Unrestricted", hint: "As fast as the network allows" },
  { id: "balanced", label: "Balanced", hint: "Fast, and leaves the machine usable" },
  { id: "quiet", label: "Quiet", hint: "One page at a time, small pauses" },
  { id: "background", label: "Background", hint: "Slowest; never competes with other apps" },
];

/** The default: fast enough to feel instant, bounded enough not to freeze a laptop. */
export const DEFAULT_CPU_LEVEL: CpuLevel = "balanced";

/**
 * The numbers behind a level.
 *
 * Concurrency is the thing that actually decides CPU (image decode, TLS, JSON parsing all happen
 * per page), so the levels step it down 4 → 3 → 2 → 1 and add pacing only at the bottom two. The
 * timeout tightens as the level drops: a slow request left hanging is work the machine keeps paying
 * for.
 */
export function workBudget(level: CpuLevel): WorkBudget {
  switch (level) {
    case "unrestricted":
      return { downloadConcurrency: 4, imageWarmBatch: 24, pagePacingMs: 0, pageTimeoutMs: 30_000 };
    case "quiet":
      return { downloadConcurrency: 2, imageWarmBatch: 8, pagePacingMs: 80, pageTimeoutMs: 20_000 };
    case "background":
      return { downloadConcurrency: 1, imageWarmBatch: 4, pagePacingMs: 200, pageTimeoutMs: 20_000 };
    case "balanced":
    default:
      return { downloadConcurrency: 3, imageWarmBatch: 12, pagePacingMs: 0, pageTimeoutMs: 25_000 };
  }
}

/** One line for Settings: what this level means in work, not in adjectives. */
export function describeLevel(level: CpuLevel): string {
  const budget = workBudget(level);
  const pages = `${budget.downloadConcurrency} page${budget.downloadConcurrency === 1 ? "" : "s"} at a time`;
  const pace = budget.pagePacingMs > 0 ? `, ${budget.pagePacingMs} ms between pages` : "";
  return `${pages}${pace}`;
}

/** Is this a level the app knows? An unknown value from an old export falls back, never throws. */
export function isCpuLevel(value: unknown): value is CpuLevel {
  return typeof value === "string" && CPU_LEVELS.some((level) => level.id === value);
}

/** Wait between two page fetches, honouring the level. Resolves immediately at 0 ms. */
export function pace(level: CpuLevel): Promise<void> {
  const ms = workBudget(level).pagePacingMs;
  return ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms));
}
