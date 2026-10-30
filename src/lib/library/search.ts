/**
 * Searching the library: one parser, one matcher.
 *
 * The box the user types into is not a second query language bolted onto the screen — it parses
 * into the same terms and the same `LibraryFilter` the sheet writes, so `source:mangadex` in the
 * box and a tick in the sheet produce the same chip and the same grid.
 *
 * Search never reaches the network. A global source search lives under Browse; this one is a
 * question about rows we already hold.
 */
import type { Series } from "../../api/source";
import { scoreRow } from "../search/index";
import type { LibraryFilter } from "./filter";

/** Where the search box looks. `category` is the default: narrow what you are looking at. */
export type SearchScope = "category" | "all";

export interface SearchState {
  text: string;
  /** `category` narrows the collection you are in; `all` looks through the whole library. */
  scope: SearchScope;
}

export const EMPTY_SEARCH: SearchState = { text: "", scope: "category" };

export interface ParsedSearch {
  /** Free words; every one of them must match (AND, not OR). */
  terms: string[];
  /** Operators folded into the filter model. */
  filter: Partial<LibraryFilter>;
  /** `scope:all` in the box overrides the toggle for one query. */
  scope?: "all";
}

/**
 * Split a query into words, keeping a quoted phrase together.
 *
 * A quote that is never closed is treated as a plain character: a half-typed `"one piece` must
 * keep narrowing as the user types, not empty the grid until they finish the quote.
 */
export function words(text: string): string[] {
  const out: string[] = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const word = (match[1] ?? match[2] ?? "").trim();
    if (word !== "") out.push(word);
  }
  return out;
}

/**
 * Read a query into terms and filter fields.
 *
 * Unknown operators are literal words, never dropped: a search that silently ignores half of
 * what was typed returns too much and reads as broken.
 */
export function parseSearch(text: string): ParsedSearch {
  const terms: string[] = [];
  const filter: Partial<LibraryFilter> = {};
  let scope: "all" | undefined;

  for (const word of words(text)) {
    const at = word.indexOf(":");
    if (at <= 0) {
      terms.push(word);
      continue;
    }
    const key = word.slice(0, at).toLowerCase();
    const value = word.slice(at + 1).trim();
    if (value === "") {
      terms.push(word);
      continue;
    }
    switch (key) {
      case "source":
        filter.sources = [...(filter.sources ?? []), value.toLowerCase()];
        break;
      case "status":
        filter.statuses = [...(filter.statuses ?? []), value];
        break;
      case "unread":
        if (value === "true" || value === "yes") filter.unread = "unread";
        else if (value === "false" || value === "no") filter.unread = "read";
        else terms.push(word);
        break;
      case "downloaded":
        if (value === "true" || value === "yes") filter.downloaded = true;
        else if (value === "false" || value === "no") filter.notDownloaded = true;
        else terms.push(word);
        break;
      case "tracked":
        if (value === "true") filter.tracked = "tracked";
        else if (value === "false") filter.tracked = "untracked";
        else terms.push(word);
        break;
      case "scope":
        if (value.toLowerCase() === "all") scope = "all";
        else terms.push(word);
        break;
      default:
        // `title:` is not an operator we support yet — it stays a word, which still finds the row.
        terms.push(word);
    }
  }

  return { terms, filter, ...(scope === undefined ? {} : { scope }) };
}

/** Does a series match every term? An empty query matches everything. */
export function matchesSearch(parsed: ParsedSearch, series: Series): boolean {
  for (const term of parsed.terms) {
    if (scoreRow(series, term) === 0) return false;
  }
  return true;
}

/** The relevance of a row, for ranking matches above the sort's own order. */
export function searchScore(parsed: ParsedSearch, series: Series): number {
  let score = 0;
  for (const term of parsed.terms) score += scoreRow(series, term);
  return score;
}
