/**
 * Reconciling a server's read state with ours.
 *
 * Suwayomi and Komga both keep read state themselves — that is why their providers say
 * `ownsProgress: false`. Ours is a mirror for offline display, and a mirror has to be refreshed
 * from the thing it mirrors, or a chapter read in the server's own web UI stays unread here
 * forever.
 *
 * The rules are the ones the codebase already states elsewhere, kept in one place so a second
 * caller cannot invent a third:
 *
 * 1. **A pull never lowers local progress.** The server saying "unread" is not a fact about this
 *    device; a local read mark is. If the two disagree, ours stands and the next push corrects the
 *    server. (Deliberately not symmetrical: a *push* is a deliberate act, a pull is housekeeping.)
 * 2. **A page only moves forward.** The server's `lastPageRead` is applied when it is further on
 *    than ours, never backwards — the same rule as the sync merge, for the same reason.
 * 3. **Nothing here writes.** It answers "what would change", so the caller decides when and how
 *    (quietly: a pull must not bounce back through the tracker queue).
 */
import type { RemoteRead } from "../api/source";

export interface ReadStatePlan {
  /** Chapters to mark read here, with the server's timestamp when it has one. */
  markRead: RemoteRead[];
  /** Bookmarks to move forward. `page` is 1-based, as the sources report it. */
  movePage: Array<{ chapterId: string; page: number }>;
}

/** Local state, as the caller can cheaply answer it for the chapters in question. */
export interface LocalReadState {
  read: ReadonlySet<string>;
  /** Page per chapter id; absent or 0 means nothing is bookmarked. */
  page: ReadonlyMap<string, number>;
}

/**
 * What a server's answer changes here, and nothing else.
 *
 * A chapter the server has never heard of is ignored rather than created: the chapter list is the
 * provider's to publish, and a read mark for an id we do not hold would be a row nobody can open.
 */
export function planReadState(remote: readonly RemoteRead[], local: LocalReadState, known: ReadonlySet<string>): ReadStatePlan {
  const markRead: RemoteRead[] = [];
  const movePage: Array<{ chapterId: string; page: number }> = [];

  for (const row of remote) {
    if (!known.has(row.chapterId)) continue;

    if (row.read && !local.read.has(row.chapterId)) markRead.push(row);

    const page = row.page ?? 0;
    if (page > 0 && page > (local.page.get(row.chapterId) ?? 0)) {
      movePage.push({ chapterId: row.chapterId, page });
    }
  }

  return { markRead, movePage };
}

/**
 * How many chapters a server says are read, out of a list — the number a "synced" line shows.
 *
 * Counted from the server's answer, not from what changed: "12 read on Suwayomi" is a fact even
 * when all twelve were already read here.
 */
export function remoteReadCount(remote: readonly RemoteRead[]): number {
  return remote.reduce((total, row) => (row.read ? total + 1 : total), 0);
}
