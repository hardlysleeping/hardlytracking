import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { highestReadChapter } from '../../src/lib/trackers/local.ts';

/**
 * The tracking card, and the two numbers it must not invent.
 *
 * A bind seeds the service with "how far this device is", and the library's Tracked filter asks
 * whether a title has a list entry at all. Both have a plausible wrong answer — the last row in the
 * chapter list instead of the furthest read mark, and a source mapping instead of a tracker row —
 * and both would look fine on screen.
 */

const chapter = (number, read) => ({ number, read });
const series = readFileSync(new URL('../../src/views/Series.svelte', import.meta.url), 'utf8');
const card = readFileSync(new URL('../../src/components/TrackerCard.svelte', import.meta.url), 'utf8');
const sheet = readFileSync(new URL('../../src/components/FilterSheet.svelte', import.meta.url), 'utf8');
const library = readFileSync(new URL('../../src/views/Library.svelte', import.meta.url), 'utf8');

test('the furthest read chapter is a read mark, not the last row in the list', () => {
  // Chapter 40 read, then 41-43 still unread: a bind must send 40, never 43.
  assert.equal(highestReadChapter([chapter(40, true), chapter(41, false), chapter(42, false), chapter(43, false)]), 40);
});

test('unsorted chapter lists do not lower the answer', () => {
  assert.equal(highestReadChapter([chapter(3, true), chapter(41, true), chapter(12, true)]), 41);
});

test('a title with nothing read has nothing to push', () => {
  assert.equal(highestReadChapter([chapter(1, false), chapter(2, false)]), 0);
  assert.equal(highestReadChapter([]), 0);
});

test('a chapter number the host did not supply is not progress', () => {
  // A source that names chapters without numbers must not look like chapter 0 was read, and must not
  // drag the answer down either.
  assert.equal(highestReadChapter([chapter(Number.NaN, true), chapter(7, true)]), 7);
});

test('the card is on the series page with the local read mark', () => {
  assert.match(series, /<TrackerCard/, 'the series page lost its tracking card');
  assert.match(series, /localChapter=\{highestRead\}/, 'the card is not seeded from the furthest read chapter');
  assert.match(series, /onchange=\{onlibrarychange\}/, 'a bind or unlink cannot reach the library facts');
});

test('bind and unlink both go through the seam, not through the store directly', () => {
  assert.match(card, /bindSeries|TrackerBindSheet/, 'the card has no bind path');
  assert.match(card, /await unbindSeries\(store, service, seriesId\)/, 'unlink must use host.unbindSeries');
  assert.match(card, /pullSeries\(\{ store, trackers \}, seriesId\)/, 'refresh must pull through the host');
});

test('the library Tracked filter reads tracker rows, not source mappings', () => {
  assert.match(library, /store\.listTrackers\(\)/, 'the library never reads tracker rows');
  assert.match(library, /tracked: new Set\(trackerRows\.map\(\(row\) => row\.seriesId\)\)/,
    'the tracked fact must come from tracker rows');
  assert.match(library, /tracked: counts\.tracked/, 'the tracked fact never reaches the query');
});

test('the filter sheet offers Tracked and Not tracked, in the same words as the chip', () => {
  assert.match(sheet, /aria-label="Tracking"/, 'the filter sheet has no tracking group');
  assert.match(sheet, /\{ id: "tracked", label: "Tracked" \}/);
  assert.match(sheet, /\{ id: "untracked", label: "Not tracked" \}/);
  // The sheet and the chip row answer the same question; two spellings read as two filters.
  const filter = readFileSync(new URL('../../src/lib/library/filter.ts', import.meta.url), 'utf8');
  assert.match(filter, /label: "Not tracked"/, 'the chip must use the sheet\'s wording');
  assert.doesNotMatch(filter, /label: "Untracked"/);
});