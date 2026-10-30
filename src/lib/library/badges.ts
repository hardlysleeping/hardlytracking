/**
 * What a library card is allowed to say, and how loudly.
 *
 * Six kinds exist; three are on by default (§36) because they answer "what is left to read", "what
 * is on this device" and "what is new". The other three are facts about the title, not about the
 * reader, and drawing them by default would turn a shelf into a database dump.
 *
 * A badge is only drawn when it has something to say: zero unread is not "0", it is nothing. The
 * count is what makes a badge useful — a dot that means "some" is a mystery.
 */

export type BadgeKind = "unread" | "downloaded" | "new" | "source" | "language" | "tracker";

export const BADGE_KINDS: BadgeKind[] = ["unread", "downloaded", "new", "source", "language", "tracker"];

/** The three that mean something about the reader's own copy. */
export const DEFAULT_BADGES: Record<BadgeKind, boolean> = {
  unread: true,
  downloaded: true,
  new: true,
  source: false,
  language: false,
  tracker: false,
};

/** What the view knows about one title. Absent facts are absent badges. */
export interface BadgeFacts {
  unread?: number;
  downloaded?: number;
  /** An update arrived since the Updates screen was last opened. */
  isNew?: boolean;
  source?: string;
  language?: string;
  tracked?: boolean;
}

export interface Badge {
  kind: BadgeKind;
  /** What the pill says: a count, `New`, or a short name. */
  label: string;
  /** Set for counted badges, so a view can style a number differently from a word. */
  count?: number;
}

/**
 * The badges for one card, in a fixed order so a shelf reads consistently.
 *
 * `settings` is the user's on/off map. A kind that is not a `BadgeKind` is dropped rather than
 * drawn: a stored setting from a future build must not put an unknown pill on a card.
 */
export function badgeList(facts: BadgeFacts, settings: Record<string, boolean> | undefined): Badge[] {
  const on = (kind: BadgeKind): boolean => settings?.[kind] ?? DEFAULT_BADGES[kind];
  const out: Badge[] = [];

  if (on("unread") && (facts.unread ?? 0) > 0) out.push({ kind: "unread", label: String(facts.unread), count: facts.unread });
  if (on("downloaded") && (facts.downloaded ?? 0) > 0) {
    out.push({ kind: "downloaded", label: String(facts.downloaded), count: facts.downloaded });
  }
  if (on("new") && facts.isNew === true) out.push({ kind: "new", label: "New" });
  if (on("source") && facts.source !== undefined && facts.source !== "") out.push({ kind: "source", label: facts.source });
  if (on("language") && facts.language !== undefined && facts.language !== "") {
    out.push({ kind: "language", label: facts.language.toUpperCase() });
  }
  if (on("tracker") && facts.tracked === true) out.push({ kind: "tracker", label: "Tracked" });
  return out;
}

/**
 * The badge set a density preset writes.
 *
 * Presets are named promises, not just cover sizes: Compact is "less chrome", so the two counted
 * badges stay (they are the reason to look at a card at all) and the wordy ones go.
 */
export const PRESET_BADGES: Record<"comfortable" | "compact" | "large", Record<BadgeKind, boolean>> = {
  comfortable: { ...DEFAULT_BADGES },
  compact: { unread: true, downloaded: true, new: false, source: false, language: false, tracker: false },
  large: { ...DEFAULT_BADGES },
};
