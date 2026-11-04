// The session clock: a stored duration is reading time, never the wall clock of a tab left open.
//
// The Reader used to close every session with `Date.now()`, so an absence or an idle stretch was
// billed as pages. `sessionEndAt` is the seam: the view says why it is closing and when it last saw
// the page, and the store records that instant. These fixtures pin the three reasons, then drive the
// real store with the cutoffs a hidden/gap session produces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from '../../src/lib/db/open.ts';
import { LibraryStore } from '../../src/lib/db/store.ts';
import { sessionEndAt, summarize } from '../../src/lib/history.ts';

const store = () => new LibraryStore(memoryDatabase());
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

test('a reader close keeps the wall clock: a session that never hid stores what it always did', () => {
  const started = 1_000;
  const now = started + 90_000;
  // No marks: plateau and hide are both unknown, so the cutoff is the moment of the close.
  assert.equal(sessionEndAt('reader', now), now);
  // Even with stale marks on hand, a deliberate close at the page is the wall clock.
  assert.equal(sessionEndAt('reader', now, { plateauAt: started + 10_000, hiddenAt: started }), now);
});

test('a close after a long absence stops at the moment the page left the screen', () => {
  const started = 1_000;
  const hiddenAt = started + 45_000;
  const returned = hiddenAt + 3 * HOUR;
  assert.equal(sessionEndAt('away', returned, { hiddenAt, plateauAt: started + 40_000 }), hiddenAt);
  // Teardown while still hidden: the same mark, however late the teardown runs.
  assert.equal(sessionEndAt('away', hiddenAt + 30_000, { hiddenAt }), hiddenAt);
  // A visible teardown (route change, Back) has no hide mark and ends now.
  assert.equal(sessionEndAt('away', returned, { hiddenAt: null }), returned);
});

test('an idle close stops at the last page turn, not at the throttled timer', () => {
  const started = 1_000;
  const plateauAt = started + 20_000;
  const firedLate = plateauAt + 12 * MINUTE; // a throttled webview can oversleep the 5-min timer
  assert.equal(sessionEndAt('idle', firedLate, { plateauAt }), plateauAt);
  // Never turns a zero into a crash: an unknown plateau falls back to the close.
  assert.equal(sessionEndAt('idle', firedLate, { plateauAt: null }), firedLate);
});

test('a cutoff never runs past the close or into nonsense', () => {
  assert.equal(sessionEndAt('away', 5_000, { hiddenAt: 9_000 }), 5_000);
  assert.equal(sessionEndAt('idle', 5_000, { plateauAt: 9_000 }), 5_000);
  assert.equal(sessionEndAt('away', 5_000, { hiddenAt: Number.NaN }), 5_000);
});

test('the store records the cutoff as the end and the span as the duration', async () => {
  const s = store();
  const started = 1_000;
  const id = await s.beginSession({ seriesId: 's', chapterId: 'ch:visible', startPage: 0 }, started);
  const at = sessionEndAt('away', started + 2 * HOUR, { hiddenAt: started + 60_000 });
  await s.endSession(id, { endPage: 4, completed: false, at });
  const [row] = await s.listSessions();
  assert.equal(row.endedAt, started + 60_000);
  assert.equal(row.durationSeconds, 60, 'an hour of absence is not twelve minutes of reading');
  assert.equal(row.endPage, 4, 'the page reached still travels');
  assert.equal(row.pagesRead, 5);
});

test('a session with no cutoff still ends now, exactly as before this change', async () => {
  const s = store();
  const started = Date.now() - 90_000;
  const id = await s.beginSession({ seriesId: 's', chapterId: 'ch:legacy', startPage: 0 }, started);
  await s.endSession(id, { endPage: 2 });
  const [row] = await s.listSessions();
  assert.ok(row.endedAt >= started + 89_000);
  assert.equal(row.durationSeconds, 90);
});

test('regression: inflated wall-clock spans stop growing with the gap', async () => {
  const s = store();
  const started = 1_000;
  const visible = 75_000;
  const gaps = [MINUTE, 10 * MINUTE, HOUR, 12 * HOUR, 3 * 24 * HOUR];
  const spans = [];
  for (const [i, gap] of gaps.entries()) {
    const hiddenAt = started + visible;
    const id = await s.beginSession({ seriesId: 's', chapterId: `ch:${i}`, startPage: 0 }, started);
    // The old behaviour is the bug: end at the return, and the span tracks the gap.
    const returned = hiddenAt + gap;
    const inflated = returned - started;
    // What the Reader now passes after the same absence.
    const at = sessionEndAt('away', returned, { hiddenAt });
    await s.endSession(id, { endPage: 3, at });
    const row = (await s.listSessions()).find((r) => r.chapterId === `ch:${i}`);
    assert.equal(row.durationSeconds, visible / 1000);
    assert.ok(inflated / 1000 > row.durationSeconds, 'the wall-clock span really is larger');
    spans.push(row.durationSeconds);
  }
  assert.deepEqual(spans, gaps.map(() => visible / 1000), 'the stored span is flat across every gap');
  const summary = summarize(await s.listSessions());
  assert.equal(summary.minutes, Math.round(visible / 1000 / 60) * gaps.length);
});

test('cutoffs leave pages, completion and history alone', async () => {
  const s = store();
  const started = 1_000;
  await s.recordHistory('s', 'ch:a', started);
  await s.setRead('ch:a', true);
  await s.setProgress('ch:a', 6, 12, started);
  const id = await s.beginSession({ seriesId: 's', chapterId: 'ch:a', startPage: 6 }, started);
  await s.endSession(id, { endPage: 11, completed: true, at: started + 40_000 });
  const [row] = await s.listSessions();
  assert.equal(row.completedChapter, true);
  assert.equal(row.pagesRead, 6);
  assert.equal(row.durationSeconds, 40);
  assert.equal((await s.listHistory()).length, 1);
  assert.equal(await s.isRead('ch:a'), true);
  assert.equal((await s.getProgress('ch:a')).page, 6, 'a session close never moves the bookmark');
});
