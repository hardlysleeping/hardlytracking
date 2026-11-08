/**
 * Page scale — how much of the reading surface one image takes.
 *
 * `1` is the fit the reader already draws: the image fills the width, the height, or the whole
 * page. Below `1` the same image keeps its proportions but is drawn smaller and centred, so the
 * reader gets margins without changing the fit. The choice belongs to a title, not to a chapter,
 * so it lives in a per-series map in prefs and every chapter of that series is drawn at it.
 *
 * A stored value is clamped on read, not trusted: an export edited by hand, or a value from a
 * build with a wider range, must not shrink a page to a stamp or blow it past the screen.
 */
export const SCALE_MIN = 0.5;
export const SCALE_MAX = 1;
export const SCALE_DEFAULT = 1;

/** Percent steps for the slider: 50 % … 100 %. */
export const SCALE_MIN_PERCENT = SCALE_MIN * 100;
export const SCALE_MAX_PERCENT = SCALE_MAX * 100;

/** A stored or dragged value becomes a scale this reader can draw. */
export function scaleOf(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return SCALE_DEFAULT;
  const clamped = Math.min(SCALE_MAX, Math.max(SCALE_MIN, value));
  return Math.round(clamped * 100) / 100;
}

/** The scale a title is drawn at; a title with no entry is the fit itself. */
export function scaleFor(map: Record<string, number> | null | undefined, seriesId: string): number {
  if (map === null || map === undefined || seriesId === "") return SCALE_DEFAULT;
  return scaleOf(map[seriesId]);
}

/**
 * One title's scale written into the map.
 *
 * The default is the absence of an entry: a series taken back to the fit leaves nothing behind, so
 * the map only ever names titles the reader actually shrank and an export stays honest.
 */
export function withScale(map: Record<string, number> | null | undefined, seriesId: string, value: number): Record<string, number> {
  const next: Record<string, number> = { ...(map ?? {}) };
  const scale = scaleOf(value);
  if (seriesId === "" || scale === SCALE_DEFAULT) delete next[seriesId];
  else next[seriesId] = scale;
  return next;
}

/** Every stored entry clamped, with the ones that mean "no change" dropped. */
export function scaleMapOf(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, number> = {};
  for (const [seriesId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (seriesId === "") continue;
    const scale = scaleOf(raw);
    if (scale !== SCALE_DEFAULT) out[seriesId] = scale;
  }
  return out;
}

/** What the slider reads and the label says. */
export function scalePercent(scale: number): number {
  return Math.round(scaleOf(scale) * 100);
}
