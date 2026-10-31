/**
 * Reporting a source.
 *
 * 4.7.3 expects a way to flag software that turns out to be objectionable. It does not ask for a
 * moderation backend, and building one would be a promise this app cannot keep — there is no
 * server watching a queue. So the report is a **prefilled, complete description** of what the
 * person is looking at, which they can send wherever they like, and it is generated from the row
 * itself so nothing has to be remembered or typed twice.
 *
 * The address is deliberately a constant with no value. Inventing a mailbox would make the button
 * lie; the copy path works today and stays true until there is somewhere to send it.
 */

/** Where a report goes, once there is somewhere. `null` = copy only, and the screen says so. */
export const REPORT_ADDRESS: string | null = null;

/** The reasons offered, in the order they are shown. `other` always last. */
export const REPORT_REASONS = [
  { id: "adult", label: "Adult content not declared", hint: "The index rated this safe." },
  { id: "broken", label: "Broken or empty", hint: "It installs but returns nothing." },
  { id: "malicious", label: "Malicious or unwanted behaviour", hint: "Unexpected requests, redirects or downloads." },
  { id: "licensing", label: "Piracy or illegal content", hint: "Content the source has no right to serve." },
  { id: "other", label: "Something else", hint: "" },
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number]["id"];

/** What the report is about, as the row knows it. */
export interface ReportTarget {
  /** The extension's display name. */
  name: string;
  /** The package id, which is the only stable name for a source. */
  pkg: string;
  version: string;
  /** The repository it came from, when it came from one. */
  repo?: string | null;
  /** How many sources the package exposes — a hint at what is being reported. */
  sources?: number;
}

export interface SourceReport {
  subject: string;
  body: string;
  reason: ReportReason;
}

export function reportSubject(target: ReportTarget): string {
  return `Report source: ${target.name} (${target.pkg})`;
}

/**
 * The whole report, as text.
 *
 * Version, package id and repository are all in it because a source is identified by those and not
 * by its name — two indexes ship the same name for different code, and a report that says "Manga
 * Box is broken" cannot be acted on.
 */
export function sourceReport(target: ReportTarget, reason: ReportReason, note = "", at = Date.now()): SourceReport {
  const label = REPORT_REASONS.find((r) => r.id === reason)?.label ?? "Something else";
  const lines = [
    `Source: ${target.name}`,
    `Package: ${target.pkg}`,
    `Version: ${target.version}`,
    `Repository: ${target.repo ?? "not from a repository (installed from a file)"}`,
  ];
  if (target.sources !== undefined) lines.push(`Sources in it: ${target.sources}`);
  lines.push(`Reason: ${label}`);
  if (note.trim() !== "") lines.push("", "What happened:", note.trim());
  lines.push("", `Reported from HardlyTracking on ${new Date(at).toISOString()}`);
  return { subject: reportSubject(target), body: lines.join("\n"), reason };
}

/** `mailto:` for the report, or `null` when no address is configured. */
export function reportMailto(report: SourceReport): string | null {
  if (REPORT_ADDRESS === null) return null;
  const query = `subject=${encodeURIComponent(report.subject)}&body=${encodeURIComponent(report.body)}`;
  return `mailto:${REPORT_ADDRESS}?${query}`;
}

/** What the screen says the button will do, given whether there is anywhere to send it. */
export function reportActionLabel(report: SourceReport | null): string {
  if (report === null) return "Copy report";
  return reportMailto(report) === null ? "Copy report" : "Send report";
}
