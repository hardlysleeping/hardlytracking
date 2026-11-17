import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { destinationOf, backHref } from '../../src/lib/destinations.ts';
import { parseRoute } from '../../src/lib/nav.ts';

test('paid Sync belongs to More and returns there, not to trackers', () => {
  const route = parseRoute('#/sync');
  assert.equal(destinationOf(route), 'more');
  assert.equal(backHref(route), '/settings');
});

test('Settings opens the shared sync account controls with an honest unconfigured state', () => {
  const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('../../src/views/Settings.svelte'), /go\("\/sync"\)/);
  assert.match(read('../../src/App.svelte'), /route\.name === "sync"/);
  assert.match(read('../../src/views/Sync.svelte'), /<SyncAccount standalone/);
  const account = read('../../src/components/SyncAccount.svelte');
  assert.match(account, /account === null && standalone/);
  assert.match(account, /Cloud sync is not configured in this build/);
  assert.match(account, /standalone \|\| canBuy/);
});
