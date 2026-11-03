import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryDatabase } from '../../src/lib/db/open.ts';
import { openLibraryProfile } from '../../src/api/profile.ts';

test('opening the saved library does not contact a configured Komga', async () => {
  const previous = globalThis.localStorage;
  const values = new Map([
    ['hardlytracking.komga', 'https://offline.invalid'],
    ['hardlytracking.komgaUser', 'fixture'],
    ['hardlytracking.komgaPassword', 'fixture-only'],
    ['hardlytracking.host', 'https://paired-offline.invalid'],
    ['hardlytracking.htServer', 'true'],
  ]);
  globalThis.localStorage = { getItem: key => values.get(key) ?? null };
  const database = memoryDatabase();
  await database.put('series', { id: 'local:offline-fixture', title: 'Offline fixture', provider: 'local', addedAt: 1 });
  let requests = 0;
  let timer;
  try {
    const profile = await Promise.race([
      openLibraryProfile({ database, localFirst: true, mihonBase: null, dalvikBase: null, fetchImpl: () => {
        requests++;
        return new Promise(() => {});
      } }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('saved library blocked by server connection')), 500); }),
    ]);
    assert.equal(requests, 0, 'opening local storage must not probe a remote server');
    assert.equal((await profile.store.listSeries())[0].id, 'local:offline-fixture');
    assert.ok(profile.providers.some(provider => provider.kind === 'komga'), 'configured provider must remain available');
  } finally {
    clearTimeout(timer);
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  }
});
