import test from 'node:test';
import assert from 'node:assert/strict';
import { DESTINATIONS, destinationOf, backHref } from '../../src/lib/destinations.ts';
import { parseRoute } from '../../src/lib/nav.ts';

test('Stats is one door under More, not a bottom-bar tab, and the bar has no duplicates', () => {
  // Stats was a destination with its own bottom-bar button for a page nobody opens daily. It is
  // now a row under More: reachable, named once, and no second entry point anywhere.
  assert.equal(DESTINATIONS.find(row => row.id === 'stats'), undefined);
  const route = parseRoute('#/stats');
  assert.equal(route.name, 'stats');
  assert.equal(destinationOf(route), 'more');
  assert.equal(backHref(route), '/more');
  // Every destination is unique, and the bar's set is exactly the daily ones.
  assert.equal(new Set(DESTINATIONS.map(row => row.id)).size, DESTINATIONS.length);
  assert.deepEqual(DESTINATIONS.map(row => row.id), ['library', 'browse', 'search', 'history', 'more']);
});
