import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { browseMode, columnsFor, maxColumns, knownSize } from '../../src/lib/browse-display.ts';

test('legacy display choices migrate to the same three modes', () => {
  for (const [input, result] of [['list','row'], ['row','row'], ['compact','grid'], ['grid','grid'], ['card','card'], [null,'grid'], ['garbage','grid']]) assert.equal(browseMode(input), result);
});
test('columns are integers: 2 minimum, 6 on phone/tablet, 8 desktop', () => {
  for (const width of [320,390,844,1024,1199,1200,1279,1280,1920]) {
    assert.equal(columnsFor(-1,width),2);
    assert.equal(columnsFor(99,width),width < 1280 ? 6 : 8);
    assert.equal(columnsFor(4,width),4);
    assert.equal(columnsFor(3.7,width),4);
    for (const bad of [undefined, null, NaN, Infinity, '6']) assert.equal(columnsFor(bad,width),3);
    assert.equal(maxColumns(width),width < 1280 ? 6 : 8);
  }
});
test('phone landscape never receives desktop column limits', () => {
  assert.equal(maxColumns(1280, 390), 6);
  assert.equal(columnsFor(8, 1280, 390), 6);
});
test('only actual finite known byte counts produce sizes', () => {
  for (const value of [undefined,null,NaN,Infinity,-1,'1024']) assert.equal(knownSize(value),null);
  assert.equal(knownSize(0),'0 B');
  assert.equal(knownSize(1024),'1.0 KiB');
  assert.equal(knownSize(1024**2),'1.0 MiB');
});
test('collection restore cannot override global display and both screens consume it', () => {
  const library = readFileSync(new URL('../../src/views/Library.svelte',import.meta.url),'utf8');
  const restore = library.slice(library.indexOf('async function restoreView('),library.indexOf('  $effect(() =>',library.indexOf('async function restoreView(')));
  assert.doesNotMatch(restore,/settings\.set\("(?:libraryView|coverSize|browseColumns|browseHorizontal)"/);
  for (const view of ['Library','Search']) {
    const source = readFileSync(new URL(`../../src/views/${view}.svelte`,import.meta.url),'utf8');
    assert.match(source,/<BrowseDisplay\s*\/>/);
    for (const key of ['libraryView','browseColumns','browseDensity','browseHorizontal']) assert.ok(source.includes(`settings.${key}`));
  }
  const settings = readFileSync(new URL('../../src/state/settings.svelte.ts',import.meta.url),'utf8');
  assert.match(settings,/browseHorizontal = \$state\(false\)/);
  for (const key of ['browseColumns','browseDensity','browseHorizontal']) assert.ok(settings.includes(`read("${key}"`));
});
