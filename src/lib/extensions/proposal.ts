/**
 * A repository, before it is a repository.
 *
 * The screen used to add a repository the moment a link named one — from a `?repo=` deep link, from
 * an install link pasted into the field. That is a third-party code source being trusted by a URL
 * somebody else wrote, which is exactly what an App Store review asks about (4.7.2) and exactly
 * what a person would want to look at before agreeing to.
 *
 * So a URL produces a **proposal**: what it is, who publishes it, how many packages it carries, and
 * the line that says HardlyTracking does not maintain any of them. Nothing is written until the
 * user taps Add Repository. The decision lives here, as data, so a test can pin it.
 */
import type { Repository } from "./repository";
import { THIRD_PARTY_NOTICE } from "./disclosure";

export { THIRD_PARTY_NOTICE };

/** Which ecosystem's packages an index carries, as far as its filename can honestly say. */
export type Ecosystem = "mihon" | "paperback" | "portable" | "unknown";

/**
 * The ecosystem an index belongs to, from its own URL.
 *
 * Deliberately conservative: `index.min.json` is published by both Mihon and Aidoku, so the answer
 * is the one this build can actually read (Mihon's APK index), and anything else says `unknown`
 * rather than guessing at a format the app would then fail to parse.
 */
export function ecosystemOf(indexUrl: string): Ecosystem {
  const path = pathOf(indexUrl).toLowerCase();
  if (path.endsWith("versioning.json")) return "paperback";
  if (path.endsWith("index.pb") || path.endsWith("index.min.json") || path.endsWith("index.json")) return "mihon";
  return "unknown";
}

/**
 * The ecosystem a repository carries, when its own rows can say so.
 *
 * A filename cannot: this app's portable indexes are published as `index.json`, which every name
 * test calls Mihon. So the rows decide first — a listing whose packages carry a portable manifest is
 * a JavaScript repository whatever the file is called, and calling it "APK extensions" would
 * misdescribe what is about to be installed.
 */
export function repositoryEcosystem(repository: Pick<Repository, "indexUrl" | "extensions">): Ecosystem {
  if (repository.extensions.some((entry) => entry.portable !== undefined)) return "portable";
  return ecosystemOf(repository.indexUrl);
}

/** How the panel names it, in words rather than in a slug. */
export function ecosystemLabel(ecosystem: Ecosystem): string {
  if (ecosystem === "mihon") return "Mihon / Keiyoushi · APK extensions";
  if (ecosystem === "paperback") return "Paperback · JavaScript sources";
  if (ecosystem === "portable") return "Portable · JavaScript sources";
  return "Extension repository";
}

/** What a repository URL is offering, before anything is stored. */
export interface RepoProposal {
  /** The URL the user pasted, normalised; the key the repository would be stored under. */
  url: string;
  /** The index that answered. */
  indexUrl: string;
  name: string;
  /** The host, which is the thing a person can actually recognise. */
  host: string;
  ecosystem: Ecosystem;
  ecosystemLabel: string;
  /** How many installable packages the index carries. */
  packages: number;
  notice: string;
}

export function proposalOf(repository: Repository): RepoProposal {
  const ecosystem = repositoryEcosystem(repository);
  return {
    url: repository.url,
    indexUrl: repository.indexUrl,
    name: repository.name,
    host: hostOf(repository.indexUrl),
    ecosystem,
    ecosystemLabel: ecosystemLabel(ecosystem),
    packages: repository.extensions.length,
    notice: THIRD_PARTY_NOTICE,
  };
}

/** `3 packages` / `1 package` / `no packages`, so the panel never reads "1 packages". */
export function packagesLabel(packages: number): string {
  if (packages <= 0) return "no packages";
  return `${packages} package${packages === 1 ? "" : "s"}`;
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    // Not a URL: judge the string itself, so a bare `repo/versioning.json` still resolves.
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
