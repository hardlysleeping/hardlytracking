import test from 'node:test';
import assert from 'node:assert/strict';
import { DESTINATIONS, destinationOf, backHref } from '../../src/lib/destinations.ts';
import { parseRoute } from '../../src/lib/nav.ts';

test('Stats is a real destination in the shared phone/tablet/desktop navigation', () => {
  const entry = DESTINATIONS.find(row => row.id === 'stats');
  assert.equal(entry?.label, 'Stats');
  assert.equal(entry?.href, '/stats');
  const route = parseRoute(`#${entry.href}`);
  assert.equal(route.name, 'stats');
  assert.equal(destinationOf(route), 'stats');
  assert.equal(backHref(route), null);
  assert.equal(new Set(DESTINATIONS.map(row => row.id)).size, DESTINATIONS.length);
});
