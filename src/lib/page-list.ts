import type { Page } from "../api/source";

/**
 * A page's number is where it sits in the chapter.
 *
 * Sources disagree about this. Most hand back a list in reading order, some number from 1, and a
 * Dalvik extension is free to pass through whatever its own `page.index` said — including a sparse
 * or duplicated set. Everything downstream assumes position: `notes[page.index]` keys a failure to a
 * slot, `data-page` addresses the node, progress is "how far down this chapter", and the resume index
 * is compared against `pages.length`. A 1-based list therefore loses page one and points progress
 * one page past where the reader is.
 *
 * So the number is rewritten at the boundary every provider passes through, once, rather than
 * trusting each provider to have got it right. The URL, headers and `open` are the page; the index
 * is ours to assign.
 */
export function normalizePages(pages: Page[]): Page[] {
  return pages.map((page, index) => (page.index === index ? page : { ...page, index }));
}

/**
 * The pages a stored row can still answer for.
 *
 * A stored list is a fallback, not a cache to be trusted blind: a row written for a different
 * chapter, or one whose every URL has been emptied by an import, is not a page list. An empty answer
 * from the store is the same as no answer.
 */
export function usableStoredPages(pages: Page[]): Page[] {
  return pages.length === 0 ? [] : normalizePages(pages.filter((page) => typeof page.url === "string" && page.url !== ""));
}