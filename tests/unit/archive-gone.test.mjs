import test from 'node:test';
import assert from 'node:assert/strict';
import { createArchiveProvider } from '../../src/api/archive.ts';

/**
 * archive.org keeps answering for items it has taken down: the identifier still comes back from
 * `advancedsearch.php`, often near the top, and only `metadata/{id}` says it is gone. The provider
 * remembers that refusal so the next list cannot offer the dead row again.
 */

function doc(identifier, title) {
  return { identifier, title, mediatype: 'texts', downloads: 10 };
}

function stub(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const route = routes(path);
    return route;
  };
  return { fetchImpl, calls };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('an item archive.org has refused stops being offered by the Archive lists', async () => {
  let denied = false;
  const { fetchImpl } = stub((path) => {
    if (path.startsWith('/advancedsearch.php')) {
      return json({ response: { docs: [doc('dead-1', 'Gone Volume'), doc('live-1', 'Live Volume')], numFound: 2, start: 0 } });
    }
    if (path.startsWith('/metadata/dead-1')) return denied ? new Response('', { status: 404 }) : json({ metadata: { title: 'Gone Volume' } });
    if (path.startsWith('/metadata/live-1')) return json({ metadata: { title: 'Live Volume' } });
    return new Response('', { status: 404 });
  });
  denied = true;
  const provider = createArchiveProvider({ fetchImpl, base: 'https://archive.test' });

  const before = await provider.search('builtin:archive', 'volume', 1);
  assert.deepEqual(before.items.map((row) => row.title), ['Gone Volume', 'Live Volume']);

  await assert.rejects(
    () => provider.details('archive:dead-1'),
    /no longer available from archive\.org/,
    'a taken-down item must say so, not report a transport failure',
  );

  const after = await provider.search('builtin:archive', 'volume', 1);
  assert.deepEqual(after.items.map((row) => row.title), ['Live Volume'], 'the dead row is not offered again');
});

test('a live item that merely failed once is not hidden for good', async () => {
  const { fetchImpl } = stub((path) => {
    if (path.startsWith('/advancedsearch.php')) return json({ response: { docs: [doc('busy-1', 'Busy Volume')], numFound: 1, start: 0 } });
    return new Response('', { status: 500 });
  });
  const provider = createArchiveProvider({ fetchImpl, base: 'https://archive.test' });
  await assert.rejects(() => provider.details('archive:busy-1'), /failed \(HTTP 500\)/);
  const after = await provider.search('builtin:archive', 'busy', 1);
  assert.deepEqual(after.items.map((row) => row.title), ['Busy Volume'], 'a 500 is not a takedown');
});
