/**
 * Keeping a library offline: when a title is worth fetching without being asked.
 *
 * Three separate opt-ins, never a default, and each of them only ever *adds* work to the existing
 * download queue: adding a title, keeping everything already saved, and keeping the categories the
 * reader named. Turning one off stops future work and deletes nothing — a file already on this
 * device is the reader's, not a cache entry.
 */
import type { Chapter } from "../../api/source";

export interface KeepPolicy {
  /** Fetch a title's issues when it is added to the library. */
  keepOnAdd: boolean;
  /** Fetch a title's missing issues when it already belongs to one of these categories. */
  keepCategories: readonly string[];
  /** What is already complete on this device — the reconcile answer, never re-fetched. */
  complete?: ReadonlySet<string>;
  /** What is already queued or running. */
  pending?: ReadonlySet<string>;
}

export interface KeepTarget {
  id: string;
  categoryIds?: readonly string[];
}

/** Settings defaults: everything off, and no category named. */
export const KEEP_POLICY_DEFAULT: { keepOnAdd: boolean; keepCategories: string[] } = {
  keepOnAdd: false,
  keepCategories: [],
};

/** Category ids that name real categories, de-duplicated and stable. */
export function keepCategoriesOf(value: unknown, known: readonly string[] = []): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(known);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry === "" || seen.has(entry)) continue;
    // An id for a category that no longer exists is dropped, not kept as a rule that can never fire.
    if (allowed.size > 0 && !allowed.has(entry)) continue;
    seen.add(entry);
    out.push(entry);
  }
  return out;
}

/**
 * Whether a title should be kept, given the policy.
 *
 * A category rule matches when the *title* is in that category; "added" is a separate trigger, not a
 * wider category, so the two cannot silently overlap.
 */
export function shouldKeepTitle(
  policy: Pick<KeepPolicy, "keepOnAdd" | "keepCategories">,
  title: KeepTarget,
  trigger: "add" | "reconcile",
): boolean {
  const categories = title.categoryIds ?? [];
  const inWatchedCategory = categories.some((id) => policy.keepCategories.includes(id));
  if (trigger === "add") return policy.keepOnAdd || inWatchedCategory;
  return inWatchedCategory;
}

/**
 * Which issues still need fetching.
 *
 * Complete chapters are never asked for again, and neither is anything already queued — that is the
 * whole difference between a policy and a storm of duplicate requests.
 */
export function missingIssues(chapters: readonly Chapter[], policy: KeepPolicy = { keepOnAdd: false, keepCategories: [] }): Chapter[] {
  const complete = policy.complete ?? new Set<string>();
  const pending = policy.pending ?? new Set<string>();
  const out: Chapter[] = [];
  for (const chapter of chapters) {
    if (chapter.id === undefined || chapter.id === "") continue;
    if (complete.has(chapter.id) || pending.has(chapter.id)) continue;
    out.push(chapter);
  }
  return out;
}

/** A sentence for the Settings row: what the switches will and will not do. */
export function describeKeepPolicy(policy: { keepOnAdd: boolean; keepCategories: readonly string[] }): string {
  const parts: string[] = [];
  if (policy.keepOnAdd) parts.push("new titles are kept when you add them");
  if (policy.keepCategories.length > 0) {
    parts.push(`${policy.keepCategories.length} categor${policy.keepCategories.length === 1 ? "y is" : "ies are"} kept`);
  }
  if (parts.length === 0) return "Nothing is downloaded unless you ask";
  return `${parts.join(" · ")} — turning this off deletes nothing`;
}
