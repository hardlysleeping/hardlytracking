/**
 * Content levels: Restricted, Mature, Adult.
 *
 * A source index says how a package describes itself — Mihon's `contentWarning`, Aidoku's
 * `contentRating`, a legacy `nsfw` flag — and this app has been carrying those words around since
 * the repository parsers were written without ever asking the person holding the phone what they
 * want to see. App Store 4.7.3 asks for exactly that: software must not exceed the app's own age
 * rating, and adult content needs a declared age.
 *
 * So three levels, one stored setting, one declaration. The mapping lives here rather than in a
 * screen, because three screens filter (the extension store, the source list, and search) and they
 * must all answer the same way.
 */
import type { ContentWarning } from "../repos/index";

/** What the setting can be. The stored value; the labels are `CONTENT_LEVELS`. */
export type ContentLevel = "restricted" | "mature" | "adult";

/** The three levels, in the order they widen, with the sentence each one shows. */
export const CONTENT_LEVELS: { id: ContentLevel; label: string; hint: string }[] = [
  {
    id: "restricted",
    label: "Restricted",
    hint: "Safe sources only. Nothing mixed or adult.",
  },
  {
    id: "mature",
    label: "Mature",
    hint: "Safe and mixed. Adult sources stay hidden.",
  },
  {
    id: "adult",
    label: "Adult",
    hint: "Everything, including adult sources. Needs a declared age.",
  },
];

/** The level a stored setting is trusted to be, whatever an older build wrote. */
export function levelOr(value: unknown, fallback: ContentLevel = "mature"): ContentLevel {
  return value === "restricted" || value === "mature" || value === "adult" ? value : fallback;
}

/**
 * Which level a package's own description puts it at.
 *
 * `UNKNOWN` counts as mature, not adult: an index that never labelled a package should not be
 * hidden from someone who chose Mature, and should never be shown to someone who chose Restricted.
 */
export function levelOfWarning(warning: ContentWarning | string | undefined | null): ContentLevel {
  if (warning === "SAFE") return "restricted";
  if (warning === "NSFW") return "adult";
  return "mature";
}

/** A source row only knows whether it declared itself NSFW; everything else is unlabelled. */
export function levelOfSource(nsfw: boolean | undefined | null): ContentLevel {
  return nsfw === true ? "adult" : "mature";
}

/**
 * May this item be shown?
 *
 * `adultDeclared` is checked separately from the setting so a setting of Adult left behind by an
 * older build — or a restored backup — cannot show adult content to someone who never said they
 * were an adult.
 */
export function allows(
  setting: ContentLevel,
  item: ContentLevel,
  adultDeclared: boolean,
): boolean {
  if (item === "restricted") return true;
  if (item === "mature") return setting !== "restricted";
  return setting === "adult" && adultDeclared;
}

/** The setting after the age gate: Adult without a declaration behaves as Mature. */
export function effectiveLevel(setting: ContentLevel, adultDeclared: boolean): ContentLevel {
  return setting === "adult" && !adultDeclared ? "mature" : setting;
}

/** Keep only what the level allows, in order, without re-walking the list twice. */
export function filterByLevel<T>(
  items: readonly T[],
  levelOf: (item: T) => ContentLevel,
  setting: ContentLevel,
  adultDeclared: boolean,
): T[] {
  const level = effectiveLevel(setting, adultDeclared);
  return items.filter((item) => allows(level, levelOf(item), adultDeclared));
}

/**
 * What a filtered list says about what it left out.
 *
 * Silence would read as "there is nothing here"; the count is the honest version, and it is the
 * only pointer to the setting that would show it.
 */
export function hiddenNotice(hidden: number, setting: ContentLevel): string | null {
  if (hidden <= 0) return null;
  const noun = hidden === 1 ? "package" : "packages";
  if (setting === "restricted") return `${hidden} ${noun} hidden — they are mixed or adult.`;
  return `${hidden} adult ${noun} hidden — raise Content to Adult in Settings.`;
}
