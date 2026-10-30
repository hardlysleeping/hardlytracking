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
