import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ROW_STYLES, browseMode, columnsFor, maxColumns, knownSize, rowStyleOf } from '../../src/lib/browse-display.ts';

test('legacy display choices migrate to the same three modes', () => {
  for (const [input, result] of [['list','row'], ['row','row'], ['compact','grid'], ['grid','grid'], ['card','card'], [null,'grid'], ['garbage','grid']]) assert.equal(browseMode(input), result);
});
test('columns are integers: 1 minimum, 3 on a phone, 6 on a tablet or a desktop', () => {
  for (const [width, ceiling] of [[390, 3], [900, 6], [1440, 6]]) {
    assert.equal(columnsFor(-1, width), 1);
    assert.equal(columnsFor(0, width), 1);
    assert.equal(columnsFor(99, width), ceiling);
    assert.equal(columnsFor(2, width), 2);
    assert.equal(columnsFor(3.7, width), Math.min(4, ceiling));
    for (const bad of [undefined, null, NaN, Infinity, '6']) assert.equal(columnsFor(bad, width), Math.min(3, ceiling));
    assert.equal(maxColumns(width), ceiling);
  }
});
test('a phone in landscape keeps the phone ceiling', () => {
  assert.equal(maxColumns(1280, 390), 3);
  assert.equal(columnsFor(8, 1280, 390), 3);
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
    for (const key of ['libraryView','browseColumns','browseHorizontal']) assert.ok(source.includes(`settings.${key}`));
  }
  const settings = readFileSync(new URL('../../src/state/settings.svelte.ts',import.meta.url),'utf8');
  assert.match(settings,/browseHorizontal = \$state\(false\)/);
  for (const key of ['browseColumns','browseHorizontal']) assert.ok(settings.includes(`read("${key}"`));
});

test('the grid has one density, so no dead Compact/Larger pair comes back', () => {
  // Both options were the same grid with a different gap; a chip that changes nothing reads as a
  // broken control. The tighter spacing is the grid, and the pair is gone from every surface.
  const display = readFileSync(new URL('../../src/components/BrowseDisplay.svelte',import.meta.url),'utf8');
  assert.doesNotMatch(display, /browseDensity|"Larger"|\["compact", "Compact"\]/);
  const grid = readFileSync(new URL('../../src/components/SeriesGrid.svelte',import.meta.url),'utf8');
  assert.doesNotMatch(grid, /density\??:/, 'SeriesGrid takes no density prop');
  assert.doesNotMatch(grid, /density\s*=/, 'SeriesGrid reads no density default');
  const settings = readFileSync(new URL('../../src/state/settings.svelte.ts',import.meta.url),'utf8');
  assert.doesNotMatch(settings, /browseDensity/);
});

test('row shapes: three candidates, and an unknown stored value lands on the original', () => {
  assert.deepEqual(ROW_STYLES.map((style) => style.id), ['line', 'preview', 'table']);
  for (const [input, result] of [['line','line'], ['preview','preview'], ['table','table'], [null,'line'], ['garbage','line'], [2,'line']]) {
    assert.equal(rowStyleOf(input), result);
  }
});

test('the row shape and the tools fold are preferences, so a relaunch keeps both', () => {
  const settings = readFileSync(new URL('../../src/state/settings.svelte.ts', import.meta.url), 'utf8');
  const prefs = settings.slice(settings.indexOf('export interface Prefs'), settings.indexOf('class Settings'));
  assert.match(prefs, /rowStyle: RowStyle;/, 'the row shape is part of the stored preference shape');
  assert.match(prefs, /toolsCollapsed: boolean;/, 'and so is the folded tools row');
  assert.match(settings, /rowStyle = \$state<RowStyle>\("line"\)/);
  assert.match(settings, /toolsCollapsed = \$state\(false\)/);
  assert.match(settings, /read<unknown>\("rowStyle"/, 'load reads the row shape back');
  assert.match(settings, /read<boolean>\("toolsCollapsed"/, 'load reads the fold back');
  // `set()` writes `settings.<key>` for every declared `Prefs` key, so a declaration plus the read
  // in `load` is the whole persistence path; the normaliser above is what makes a stored row shape
  // this build understands.
  assert.match(settings, /key === "rowStyle"\s*\n\s*\? rowStyleOf\(value\)/, 'set normalises a stored row shape');
});
