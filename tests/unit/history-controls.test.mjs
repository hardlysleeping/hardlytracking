import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'vite';
import { memoryDatabase } from '../../src/lib/db/open.ts';
import { LibraryStore } from '../../src/lib/db/store.ts';
import { historySwipe, selectedHistoryIds } from '../../src/lib/history-controls.ts';
import { DESTINATIONS, destinationOf, backHref } from '../../src/lib/destinations.ts';
import { parseRoute } from '../../src/lib/nav.ts';

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
