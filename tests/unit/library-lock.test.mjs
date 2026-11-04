import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as policy from '../../src/lib/categories.ts';
import { contextOf, applyMarks, visibleRows } from '../../src/lib/marks.ts';
import { memoryDatabase } from '../../src/lib/db/open.ts';
import { LibraryStore } from '../../src/lib/db/store.ts';

// Exercise the actual state methods with identity runes; browser fixture covers Svelte reactivity.
function state(file, name, privacy) {
  const source = readFileSync(new URL(`../../src/state/${file}.svelte.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^import[\s\S]*?;\s*/gm, '').replace(/export /g, '');
  // Trusted repository source and fixed test identifiers only, never user/network input.
  const args = file === 'privacy' ? [] : ['privacy'];
  const values = file === 'privacy' ? [] : [privacy];
  return new Function('$state', ...args, ...Object.keys(policy), js + `;return ${name};`)(x => x, ...values, ...Object.values(policy));
}

test('lock folds the band at once, the tab still works while locked, and unlocking restores the chosen fold', () => {
  for (const folded of [false, true]) {
    const privacy = state('privacy', 'privacy');
    privacy.bandCollapsed = folded;
    privacy.lock(); privacy.lock();
    // Locking is one press and it folds: the curtain is down, so the controls go with it.
    assert.equal(privacy.locked, true); assert.equal(privacy.bandCollapsed, true);
    // Unlocking gives back the fold the reader had before they locked, not a forced one.
    privacy.unlock(); assert.equal(privacy.bandCollapsed, folded);
  }
  // The tab is the way back to the band, so it opens while the curtain is down — and a fold the
  // reader chose there is theirs: unlocking must not shut the band they just opened.
  const privacy = state('privacy', 'privacy');
  privacy.bandCollapsed = true;
  privacy.lock();
  privacy.toggleBand();
  assert.equal(privacy.bandCollapsed, false);
  privacy.unlock();
  assert.equal(privacy.bandCollapsed, false);
});

test('a delayed preference load while locked remembers intent without revealing it', async () => {
  const privacy = state('privacy', 'privacy');
  const categories = state('categories', 'categories', privacy);
  const sources = state('source-marks', 'sourceMarks', privacy);
  const store = new LibraryStore(memoryDatabase());
  await store.setPref('categories.hiddenView', 'revealed');
  await store.setPref('sources.hiddenView', 'only');
  privacy.lock();
  await categories.load(store); await sources.load(store);
  assert.equal(categories.hiddenView, 'hidden'); assert.equal(sources.hiddenView, 'hidden');
  privacy.unlock();
  assert.equal(categories.hiddenView, 'revealed'); assert.equal(sources.hiddenView, 'only');
});

test('all eye/pin cycles survive; locked eye/setHidden/assign/source writes cannot bypass curtain', async () => {
  const privacy = state('privacy', 'privacy');
  const categories = state('categories', 'categories', privacy);
  const sources = state('source-marks', 'sourceMarks', privacy);
  const store = new LibraryStore(memoryDatabase());
  await store.putCategory({ id: 'private', name: 'Fixture private shelf', order: 0, hidden: true, pinned: true });
  await store.putSourceMark({ id: 'mihon:src:99', hidden: true, pinned: false });
  await categories.load(store); await sources.load(store);
  await store.addSeries({ id:'local:fixture', provider:'local', title:'Fixture', categoryIds:['private'] });
  for (const expected of ['revealed', 'only', 'hidden']) { await categories.cycleHiddenView(); assert.equal(categories.hiddenView, expected); }
  for (const expected of ['only', 'without', 'all']) { await categories.cyclePinView(); assert.equal(categories.pinView, expected); }
  for (const expected of ['revealed', 'only', 'hidden']) { await sources.cycleHiddenView(); assert.equal(sources.hiddenView, expected); }
  for (const expected of ['only', 'without', 'all']) { await sources.cyclePinView(); assert.equal(sources.pinView, expected); }
  categories.hiddenView = 'revealed'; sources.hiddenView = 'only';
  privacy.lock();
  await categories.cycleHiddenView(); await sources.cycleHiddenView();
  categories.hiddenView = 'revealed'; sources.hiddenView = 'revealed';
  await categories.setHidden('private', false); await categories.remove('private');
  await categories.assign('local:fixture', []);
  assert.deepEqual((await store.getSeries('local:fixture')).categoryIds, ['private']);
  await sources.setHidden('mihon:src:99', false);
  assert.equal(categories.hiddenView, 'hidden'); assert.equal(sources.hiddenView, 'hidden');
  assert.equal((await store.listCategories())[0].hidden, true);
  assert.equal((await store.listSourceMarks())[0].hidden, true);
  const rows = [{ id:'local:secret',categoryIds:['private'] }, { id:'mihon:1',categoryIds:[] }, { id:'local:mixed',categoryIds:['private','public'] }];
  const ctx = contextOf({ categories:[...categories.items,{id:'public',hidden:false}],sources:sources.marks,sourceOf:id=>id==='mihon:1'?'mihon:src:99':undefined });
  assert.deepEqual(applyMarks(rows,ctx,{hiddenView:categories.hiddenView,pinView:'all'}).map(r=>r.id),['local:mixed']);
  assert.deepEqual(visibleRows(rows.map(r=>({seriesId:r.id})),ctx,id=>rows.find(r=>r.id===id).categoryIds).map(r=>r.seriesId),['local:mixed']);
  privacy.unlock(); assert.equal(categories.hiddenView,'revealed'); assert.equal(sources.hiddenView,'only');
});
