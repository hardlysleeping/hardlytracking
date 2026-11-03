import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from '../../src/lib/db/open.ts';
import { LibraryStore } from '../../src/lib/db/store.ts';
import { aggregateReadingStats, loadReadingStats } from '../../src/lib/reading-stats.ts';

const AT = new Date(2026, 9, 29, 12).getTime();
const visibility = { categories: [], sources: [] };
const empty = () => ({ series: [], chapters: [], progress: [], prefs: [], history: [], sessions: [], mappings: [] });
const chapter = (id = 'c1', seriesId = 'local:s1', extra = {}) => ({ id, seriesId, name: id, number: 1, pageCount: 10, read: false, ...extra });
const session = (extra = {}) => ({ id: 'session1', seriesId: 'local:s1', sourceId: '', chapterId: 'c1', startedAt: AT, endedAt: AT + 60_000, startPage: 0, endPage: 2, pagesRead: 3, durationSeconds: 60, completedChapter: false, ...extra });
const aggregate = (data, marks = visibility) => aggregateReadingStats({ ...empty(), ...data }, marks);

test('empty snapshot has no invented activity', () => {
  const stats = aggregate({});
  assert.equal(stats.readIssues, 0); assert.equal(stats.recordedSeconds, 0);
  assert.equal(stats.hasActivity, false); assert.deepEqual(stats.days, []); assert.deepEqual(stats.recent, []);
});

test('manual read/unread overrides cached read and completed progress; survives reload without provider', async () => {
  const store = new LibraryStore(memoryDatabase());
  await store.putChapters('local:s1', [chapter()]);
  await store.setRead('c1', true);
  let stats = aggregateReadingStats(await loadReadingStats(store), visibility);
  assert.equal(stats.readIssues, 1); assert.equal(stats.caughtUpSeries, 1);
  assert.equal(stats.savedPages, 0); assert.equal(stats.days.length, 0);
  await store.setProgress('c1', 9, 10, AT);
  await store.setRead('c1', false);
  await store.putChapters('local:s1', [chapter('c1', 'local:s1', { read: true })]);
  stats = aggregateReadingStats(await loadReadingStats(store), visibility);
  assert.equal(stats.readIssues, 0, 'explicit false wins over stale provider and sticky completion');
  assert.equal(stats.caughtUpSeries, 0);
  assert.equal(stats.recordedSeconds, 0);
});

test('opening an issue is activity but not completion; advanced progress is not read', () => {
  const stats = aggregate({ chapters: [chapter()], history: [{ chapterId: 'c1', seriesId: 'local:s1', at: AT }], progress: [{ chapterId: 'c1', page: 3, total: 10, at: AT }] });
  assert.equal(stats.readIssues, 0); assert.equal(stats.inProgressIssues, 1);
  assert.equal(stats.savedPages, 4); assert.equal(stats.knownProgressPages, 10);
  assert.equal(stats.startedSeries, 1); assert.equal(stats.caughtUpSeries, 0);
});

test('rereads and duplicate rows cannot inflate unique current read or sessions', () => {
  const c = chapter('c1', 'local:s1', { read: true });
  const stats = aggregate({ chapters: [c, c], progress: [{ chapterId: 'c1', page: 1, total: 10, completed: true, at: AT }], sessions: [session(), session(), session({ id: 'reread' })] });
  assert.equal(stats.readIssues, 1); assert.equal(stats.closedSessions, 2);
  assert.equal(stats.recordedSeconds, 120); assert.equal(stats.sessionPageSpans, 6);
  assert.equal(stats.seriesWithReads, 1);
});

test('closed measured durations only: no live clock, legacy wall span or invalid imported inflation', () => {
  const stats = aggregate({ sessions: [session({ durationSeconds: 20 }), session({ id: 'open', endedAt: undefined, durationSeconds: 999999 }), session({ id: 'legacy', durationSeconds: undefined }), session({ id: 'bad', durationSeconds: -10 }), session({ id: 'oversized', durationSeconds: 99999 }), session({ id: 'reverse', endedAt: AT - 1 })] });
  assert.equal(stats.recordedSeconds, 80, '20 measured seconds + imported duration capped at 60-second closed span');
  assert.equal(stats.openSessions, 1); assert.equal(stats.closedSessions, 4);
  assert.equal(stats.unmeasuredSessions, 2);
  assert.equal(stats.days[0].seconds, 80);
});

test('hidden source/category records disappear from every total, day and recent title', () => {
  const hidden = 'mihon:1';
  const secret = 'local:secret';
  const shown = 'local:shown';
  const series = [
    { id: hidden, provider: 'mihon', title: 'Secret source' },
    { id: secret, provider: 'local', title: 'Secret shelf', categoryIds: ['hidden'] },
    { id: shown, provider: 'local', title: 'Visible', categoryIds: ['hidden', 'visible'] },
  ];
  const data = { series, chapters: series.map((s) => chapter(s.id + ':c', s.id, { read: true })),
    history: series.map((s) => ({ seriesId: s.id, chapterId: s.id + ':c', at: AT })),
    sessions: series.map((s) => session({ id: s.id, seriesId: s.id, chapterId: s.id + ':c' })),
    progress: series.map((s) => ({ chapterId: s.id + ':c', page: 5, total: 10, at: AT })),
    mappings: [{ seriesId: hidden, provider: 'dalvik', sourceId: '99', at: AT }],
  };
  const stats = aggregate(data, { categories: [{ id: 'hidden', hidden: true }, { id: 'visible', hidden: false }], sources: [{ id: 'dalvik:src:99', hidden: true, pinned: false }] });
  assert.equal(stats.readIssues, 1); assert.equal(stats.startedSeries, 1); assert.equal(stats.caughtUpSeries, 1);
  assert.equal(stats.recordedSeconds, 60); assert.equal(stats.savedPages, 6);
  assert.equal(stats.days[0].sessions, 1); assert.equal(stats.days[0].lastOpenedIssues, 1);
  assert.deepEqual(stats.recent.map((r) => r.title), ['Visible']);
  assert.ok(!JSON.stringify(stats).includes('Secret'));
});

test('orphan progress/read marks excluded; imported history supplies ownership without provider', () => {
  const stats = aggregate({ prefs: [{ key: 'read:orphan', value: true }, { key: 'read:imported', value: true }], progress: [{ chapterId: 'orphan', completed: true, page: 20, total: 21, at: AT }], history: [{ chapterId: 'imported', seriesId: 'missing:series', at: AT }] });
  assert.equal(stats.readIssues, 1); assert.equal(stats.savedPages, 0);
  assert.equal(stats.recent[0].title, 'Unknown title'); assert.equal(stats.caughtUpSeries, 0);
});

test('daily history is latest visit per issue, not fictitious completions', async () => {
  const store = new LibraryStore(memoryDatabase());
  await store.recordHistory('local:s1', 'c1', AT - 86_400_000);
  await store.recordHistory('local:s1', 'c1', AT);
  await store.putSession(session());
  const stats = aggregateReadingStats(await loadReadingStats(store), visibility);
  assert.equal(stats.recent.length, 1); assert.equal(stats.days.length, 1);
  assert.equal(stats.days[0].day, '2026-10-29'); assert.equal(stats.days[0].lastOpenedIssues, 1);
  assert.equal(stats.readIssues, 0);
});

test('loader reads beyond default 50 history / 200 session caps and never writes', async () => {
  const store = new LibraryStore(memoryDatabase());
  for (let i = 0; i < 205; i++) {
    await store.recordHistory('local:s1', `c${i}`, AT + i);
    await store.putSession(session({ id: `s${i}`, chapterId: `c${i}` }));
  }
  const before = await store.listPrefs();
  const data = await loadReadingStats(store);
  assert.equal(data.history.length, 205); assert.equal(data.sessions.length, 205);
  assert.equal(aggregateReadingStats(data, visibility).closedSessions, 205);
  assert.deepEqual(await store.listPrefs(), before);
});
