import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'vite';
import { memoryDatabase } from '../../src/lib/db/open.ts';
import { LibraryStore } from '../../src/lib/db/store.ts';
import { historySwipe, selectedHistoryIds, toggleHistoryPin, historyGroups, PINNED_GROUP } from '../../src/lib/history-controls.ts';
import { DESTINATIONS, destinationOf, backHref } from '../../src/lib/destinations.ts';
import { parseRoute } from '../../src/lib/nav.ts';

const historyView = readFileSync(new URL('../../src/views/History.svelte', import.meta.url), 'utf8');

// Every write in this suite targets a new memory database. No browser profile or real history.
test('selected removals delete only requested chapter logs and sessions, with sync tombstones', async () => {
  const db = memoryDatabase();
  const store = new LibraryStore(db);
  for (const id of ['a', 'b', 'keep']) {
    await store.recordHistory('s', id, 1000);
    await store.setProgress(id, 3, 10, 1000);
    await store.setRead(id, true);
    await store.beginSession({ seriesId: 's', chapterId: id, startPage: 3 }, 1000);
  }
  await store.beginSession({ seriesId: 's', chapterId: 'a', startPage: 4 }, 2000);
  await store.setPosition('s', 'a', 3);
  await db.put('downloads', { chapterId: 'a', state: 'complete' });
  const untouched = Object.fromEntries(await Promise.all(['progress', 'position', 'chapters', 'downloads'].map(async name => [name, await db.all(name)])));
  assert.deepEqual(await store.removeHistoryEntries(['a', 'b', 'a', 'missing']), { sessions: 3, history: 2 });
  assert.deepEqual((await store.listHistory()).map(r => r.chapterId), ['keep']);
  assert.deepEqual((await store.listSessions()).map(r => r.chapterId), ['keep']);
  const tombstones = await db.all('tombstones');
  assert.equal(tombstones.filter(r => r.kind === 'history').length, 2);
  assert.equal(tombstones.filter(r => r.kind === 'session').length, 3);
  for (const [name, rows] of Object.entries(untouched)) assert.deepEqual(await db.all(name), rows, `${name} survives`);
  assert.deepEqual(await store.removeHistoryEntries([]), { sessions: 0, history: 0 });
});

test('only horizontal deliberate swipes reveal Remove; vertical scrolling and small drags do nothing', () => {
  assert.equal(historySwipe(-70, 8), 'reveal');
  assert.equal(historySwipe(70, 8), 'close');
  assert.equal(historySwipe(-20, 0), null);
  assert.equal(historySwipe(-80, 100), null);
  assert.equal(historySwipe(-60, 50), null);
});

test('stale selection cannot delete hidden rows', () => {
  assert.deepEqual(selectedHistoryIds(new Set(['a', 'private', 'removed']), [{ chapterId: 'a' }, { chapterId: 'b' }]), ['a']);
});

test('history pins toggle one series, keep pin order, and never duplicate', () => {
  let pins = [];
  pins = toggleHistoryPin(pins, 's1');
  pins = toggleHistoryPin(pins, 's2');
  assert.deepEqual(pins, ['s1', 's2']);
  pins = toggleHistoryPin(pins, 's1');
  assert.deepEqual(pins, ['s2']);
  pins = toggleHistoryPin(pins, 's2');
  assert.deepEqual(pins, []);
  // The input is not mutated: settings.set receives a new array.
  const before = ['s1'];
  toggleHistoryPin(before, 's1');
  assert.deepEqual(before, ['s1']);
});

test('pinned rows group at the top, once each, newest first; day groups keep their order', () => {
  const now = new Date('2026-11-06T12:00:00').getTime();
  const rows = [
    { seriesId: 'old-pin', at: now - 30 * 86_400_000, chapterId: 'p1' },
    { seriesId: 'today', at: now - 60_000, chapterId: 't1' },
    { seriesId: 'yesterday', at: now - 86_400_000, chapterId: 'y1' },
    { seriesId: 'pin-today', at: now - 120_000, chapterId: 'p2' },
    { seriesId: 'today', at: now - 3_600_000, chapterId: 't2' },
  ];
  const groups = historyGroups(rows, ['old-pin', 'pin-today'], now);
  assert.deepEqual(groups.map(g => g.label), [PINNED_GROUP, 'Today', 'Yesterday']);
  assert.deepEqual(groups[0].rows.map(r => r.chapterId), ['p2', 'p1'], 'pinned, newest first');
  assert.deepEqual(groups[1].rows.map(r => r.chapterId), ['t1', 't2'], 'newest first inside the day');
  assert.deepEqual(groups[2].rows.map(r => r.chapterId), ['y1']);
  // A pinned row is placed, not duplicated.
  assert.equal(groups.flatMap(g => g.rows).filter(r => r.chapterId === 'p2').length, 1);
});

test('a pin whose rows were removed draws no empty group and the pin itself survives removal', () => {
  const now = Date.now();
  const pins = ['gone', 'kept'];
  const rows = [{ seriesId: 'kept', at: now, chapterId: 'k1' }];
  const groups = historyGroups(rows, pins, now);
  assert.deepEqual(groups.map(g => g.label), [PINNED_GROUP]);
  assert.deepEqual(groups[0].rows.map(r => r.chapterId), ['k1']);
  // Multi-remove deletes chapter logs, not preferences: the pin list is untouched.
  assert.deepEqual(pins, ['gone', 'kept']);
});

test('grouping leaves Today empty for a pinned-only title instead of inventing a bucket', () => {
  const now = new Date('2026-11-06T12:00:00').getTime();
  const groups = historyGroups([{ seriesId: 's', at: now, chapterId: 'c' }], ['s'], now);
  assert.deepEqual(groups.map(g => g.label), [PINNED_GROUP]);
});

test('Updates has one home inside Library; legacy deep links retain the Library destination', () => {
  assert.equal(DESTINATIONS.some(d => d.id === 'updates'), false);
  const route = parseRoute('#/updates');
  assert.equal(destinationOf(route), 'library');
  assert.equal(backHref(route), '/library');
});

test('real library write seam: temporary incognito suppresses log writes, retains progress and resumes without changing pause preference', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, configFile: new URL('../../vite.config.ts', import.meta.url).pathname });
  try {
    const { library } = await vite.ssrLoadModule('/src/state/library.svelte.ts');
    const { incognito } = await vite.ssrLoadModule('/src/state/incognito.svelte.ts');
    const { settings } = await vite.ssrLoadModule('/src/state/settings.svelte.ts');
    const store = new LibraryStore(memoryDatabase());
    library.profile = { store, providers: [] };
    settings.historyPaused = false;
    assert.equal(incognito.active, false);
    await library.remember('s', 'before', 1, 10);
    incognito.toggle();
    await library.remember('s', 'private', 4, 10);
    assert.equal(await library.beginSession('s', 'private', 4), null);
    assert.equal((await store.getProgress('private')).page, 4);
    assert.equal((await store.getPosition('s')).chapterId, 'private');
    assert.deepEqual((await store.listHistory()).map(r => r.chapterId), ['before']);
    assert.equal((await store.listSessions()).length, 0);
    assert.equal(settings.historyPaused, false);
    incognito.toggle();
    await library.remember('s', 'after', 2, 10);
    assert.ok(await library.beginSession('s', 'after', 2));
    assert.deepEqual(new Set((await store.listHistory()).map(r => r.chapterId)), new Set(['before', 'after']));
    settings.historyPaused = true;
    incognito.toggle(); incognito.toggle();
    await library.remember('s', 'paused', 1, 10);
    assert.equal(await library.beginSession('s', 'paused', 1), null);
    assert.equal(settings.historyPaused, true, 'temporary toggle must not unpause the durable preference');
    assert.equal((await store.listHistory()).some(r => r.chapterId === 'paused'), false);
  } finally { await vite.close(); }
});

test('a source marked incognito leaves no history or sessions, but progress and read marks still save', async () => {
  const vite = await createServer({ server: { middlewareMode: true }, configFile: new URL('../../vite.config.ts', import.meta.url).pathname });
  try {
    const { library } = await vite.ssrLoadModule('/src/state/library.svelte.ts');
    const { sourceMarks } = await vite.ssrLoadModule('/src/state/source-marks.svelte.ts');
    const { settings } = await vite.ssrLoadModule('/src/state/settings.svelte.ts');
    const { incognito } = await vite.ssrLoadModule('/src/state/incognito.svelte.ts');
    const store = new LibraryStore(memoryDatabase());
    library.profile = { store, providers: [] };
    settings.historyPaused = false;
    incognito.active && incognito.toggle();
    await sourceMarks.load(store);

    await sourceMarks.setIncognito('dalvik:src:1', true);
    // The mark is independent: incognito does not hide the source and does not unpin it.
    assert.deepEqual(
      { hidden: sourceMarks.markOf('dalvik:src:1').hidden, pinned: sourceMarks.markOf('dalvik:src:1').pinned },
      { hidden: false, pinned: false },
    );

    await library.remember('dalvik:1:x', 'incog', 4, 10);
    assert.equal(await library.beginSession('dalvik:1:x', 'incog', 4), null);
    await store.setRead('incog', true);

    assert.equal((await store.getProgress('incog')).page, 4, 'progress still saves');
    assert.equal((await store.getPosition('dalvik:1:x')).chapterId, 'incog', 'position still saves');
    assert.equal(await store.isRead('incog'), true, 'the read mark still saves');
    assert.deepEqual(await store.listHistory(), [], 'no history row');
    assert.deepEqual(await store.listSessions(), [], 'no reading session');

    // A different source keeps logging normally — the mark is per source, not global.
    await library.remember('dalvik:2:y', 'normal', 1, 10);
    assert.ok(await library.beginSession('dalvik:2:y', 'normal', 1));
    assert.deepEqual((await store.listHistory()).map(r => r.chapterId), ['normal']);

    // Hidden and incognito can coexist and are set independently.
    await sourceMarks.toggleHidden('dalvik:src:1');
    assert.equal(sourceMarks.markOf('dalvik:src:1').incognito, true);
    assert.equal(sourceMarks.markOf('dalvik:src:1').hidden, true);

    // Turning incognito off restores logging without touching the eye or the pin.
    await sourceMarks.togglePin('dalvik:src:1');
    await sourceMarks.setIncognito('dalvik:src:1', false);
    assert.deepEqual(
      { hidden: sourceMarks.markOf('dalvik:src:1').hidden, pinned: sourceMarks.markOf('dalvik:src:1').pinned, incognito: sourceMarks.markOf('dalvik:src:1').incognito },
      { hidden: true, pinned: true, incognito: false },
    );
    await library.remember('dalvik:1:x', 'after', 2, 10);
    assert.equal((await store.listHistory()).some(r => r.chapterId === 'after'), true);
  } finally { await vite.close(); }
});

test('the history header counts the log, not the page of it', async () => {
  const store = new LibraryStore(memoryDatabase());
  for (let index = 0; index < 3; index += 1) await store.recordHistory('s', `c${index}`, 1000 + index);
  assert.equal((await store.listHistory(2)).length, 2, 'the list is capped');
  assert.equal(await store.countHistory(), 3, 'the cap is not the total');
  assert.match(historyView, /store\.countHistory\(\)/, 'the page counts the rows it was given');
  assert.match(historyView, /total > rows\.length/, 'the list stops at 200 and does not say so');
});

test('a failed history read is not an empty log, and a clear refreshes the list behind it', () => {
  const load = historyView.slice(historyView.indexOf('async function load()'), historyView.indexOf('async function load()') + 2400);
  assert.match(load, /catch \(problem\)/, 'a rejected read drew "Nothing read yet"');
  assert.match(load, /error = problem instanceof Error/, 'the failure is not named');
  assert.match(historyView, /void library\.historyClearedAt/, 'clearing history left the list and its count stale');
  assert.match(historyView, /hidden by a privacy mark now/, 'a removal that deletes nothing closed the sheet as if it worked');
});
