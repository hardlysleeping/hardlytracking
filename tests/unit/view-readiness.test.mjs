import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../src/views/Source.svelte', import.meta.url), 'utf8');
const series = readFileSync(new URL('../../src/views/Series.svelte', import.meta.url), 'utf8');

/**
 * Two screens that lied about being empty.
 *
 * Both were found by opening the app on a restored route and on a slow source: a route restored on
 * launch mounted before the library had opened its providers, and a source whose chapters take
 * seconds was drawn as a source with none. Neither is a rendering detail — one leaves a phone on
 * "This source returned nothing." until the reader taps Refresh, the other tells them the
 * extension is broken.
 */

test('the source listing re-runs when the library finishes opening', () => {
  // The effect used to depend on `sourceId` alone, with everything inside `untrack`: on a cold
  // start `run()` returned at the null profile and nothing asked it again. Measured before the
  // fix: 0 tiles after 20 s; after: 32 tiles in 3.0 s, no Refresh.
  const ready = source.indexOf('const ready = $derived(library.profile !== null);');
  const effect = source.indexOf('void sourceId;');
  const guard = source.indexOf('if (!ready) return;');
  const untrack = source.indexOf('untrack(() => {', guard);
  assert.ok(ready > -1, 'readiness is not derived from the library profile');
  assert.ok(effect > -1 && guard > -1 && untrack > -1, 'the listing effect lost its readiness guard');
  assert.ok(ready < effect && effect < guard && guard < untrack,
    'the readiness guard must sit outside `untrack`, or it is not a dependency');
});

test('a chapter list that is still loading is not drawn as an empty one', () => {
  // Weeb Central answers 1 198 chapters after ~2.6 s; the page said "This source returned no
  // chapters for this series." for the whole wait.
  assert.match(series, /busy \? "Loading chapters…" : "This source returned no chapters for this series\."/,
    'the empty chapter list must distinguish a load in progress from a source with no chapters');
});