/**
 * Pinned sources — Komikku's "search pinned sources only", kept as one preference.
 *
 * A pin is the user's own mark, so it lives in `settings.pinnedSources` (an array, one preference)
 * rather than on the source row: a source is rebuilt from its extension on every launch, and a mark
 * stored there would vanish.
 */
import type { Source } from "../api/source";

/** Add or remove one id, keeping the user's pinning order. */
export function togglePin(pinned: readonly string[], id: string): string[] {
  return pinned.includes(id) ? pinned.filter((row) => row !== id) : [...pinned, id];
}

/**
 * The pinned sources that are actually installed, in pin order.
 *
 * An extension can be uninstalled or an extension repository removed; its pin stays in the
 * preference (so reinstalling brings it back) but it must not be searched when it is gone.
 */
export function pinnedSources(sources: readonly Source[], pinned: readonly string[]): Source[] {
  const byId = new Map(sources.map((source) => [source.id, source]));
  return pinned.map((id) => byId.get(id)).filter((source): source is Source => source !== undefined);
}

/**
 * The picker's order: pinned first, in the order the user pinned them, then everything else by name.
 *
 * The selector used to be one alphabetical soup, so the three sources someone actually searches were
 * lost among sixty, and the only way to find them was to remember which letter they started on.
 */
export function orderForPicker(sources: readonly Source[], pinned: readonly string[]): Source[] {
  const pinOrder = new Map(pinned.map((id, at) => [id, at]));
  return [...sources].sort((a, b) => {
    const aPin = pinOrder.get(a.id);
    const bPin = pinOrder.get(b.id);
    if (aPin !== undefined && bPin !== undefined) return aPin - bPin;
    if (aPin !== undefined) return -1;
    if (bPin !== undefined) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * What a first search should have ticked.
 *
 * Pinned sources when there are any and the preference is on, otherwise the first dozen — sixty
 * sources at once is a hammer, not a search. The same rule as before, in one place so the view can
 * re-seed when the source list changes instead of guessing once.
 */
export function seedSelection(
  sources: readonly Source[],
  pinned: readonly string[],
  pinnedOnly: boolean,
  limit = 12,
): string[] {
  const installed = pinnedSources(sources, pinned);
  if (pinnedOnly && installed.length > 0) return installed.map((source) => source.id);
  return sources.slice(0, limit).map((source) => source.id);
}

/**
 * Drop ids that are no longer searchable, keeping the rest.
 *
 * Content level, an uninstalled extension or a removed repository can take a source away between two
 * searches; a selection that keeps its id counts it in "3 selected" while it can never answer.
 */
export function pruneSelection(chosen: ReadonlySet<string>, sources: readonly Source[]): Set<string> {
  const known = new Set(sources.map((source) => source.id));
  const kept = [...chosen].filter((id) => known.has(id));
  return new Set(kept);
}
