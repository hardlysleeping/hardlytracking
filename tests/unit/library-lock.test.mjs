import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as policy from '../../src/lib/categories.ts';
import { contextOf, applyMarks, visibleRows } from '../../src/lib/marks.ts';
import { memoryDatabase } from '../../src/lib/db/open.ts';
import { LibraryStore } from '../../src/lib/db/store.ts';
import { makePinRecord, pinRecordOf } from '../../src/lib/pin.ts';
import * as pins from '../../src/lib/pin.ts';

// Synthetic PIN only: the curtain now refuses to come down without one, so every fixture that
// locks and unlocks starts from a real hash of a test code.
const PIN = '2468';
const PIN_RECORD = await makePinRecord(PIN);
const prefs = () => ({ privacyPin: PIN_RECORD });

// Exercise the actual state methods with identity runes; browser fixture covers Svelte reactivity.
function state(file, name, privacy, settings) {
  const source = readFileSync(new URL(`../../src/state/${file}.svelte.ts`, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText
    .replace(/^import[\s\S]*?;\s*/gm, '').replace(/export /g, '');
  // Trusted repository source and fixed test identifiers only, never user/network input.
  const scope = { ...policy, ...pins };
  const args = ['$state', ...(file === 'privacy' ? ['settings'] : ['privacy']), ...Object.keys(scope)];
  const values = [x => x, ...(file === 'privacy' ? [settings ?? prefs()] : [privacy]), ...Object.values(scope)];
  return new Function(...args, js + `;return ${name};`)(...values);
}

test('lock refuses without a PIN, counts wrong tries, and only a right PIN raises the curtain', async () => {
  const empty = state('privacy', 'privacy', undefined, { privacyPin: '' });
  assert.equal(empty.lock(), 'needs-pin');
  assert.equal(empty.locked, false, 'a lock with no key must not come down');
  assert.equal(empty.bandCollapsed, false);
  assert.equal(await empty.attemptUnlock(PIN), 'already');
  assert.equal(await empty.attemptUnlock(PIN), 'already', 'nothing to unlock while open');

  const privacy = state('privacy', 'privacy');
  privacy.bandCollapsed = true;
  assert.equal(privacy.lock(), 'locked');
  assert.equal(privacy.lock(), 'already');
  assert.equal(await privacy.attemptUnlock('0000'), 'wrong');
  assert.equal(privacy.locked, true, 'a wrong PIN keeps the curtain up');
  assert.equal(privacy.notice, 'That PIN is not right — 4 tries left.');
  assert.equal(await privacy.attemptUnlock('2469'), 'wrong');
  assert.equal(privacy.notice, 'That PIN is not right — 3 tries left.');
  assert.equal(await privacy.attemptUnlock('2468'), 'unlocked');
  assert.equal(privacy.locked, false);
  assert.equal(privacy.bandCollapsed, true, 'the fold chosen before locking comes back');
  assert.equal(privacy.triesLeft, 5);
});

test('five wrong tries pause the keypad instead of leaving it unbounded', async () => {
  const privacy = state('privacy', 'privacy');
  privacy.lock();
  for (let left = 4; left >= 1; left--) {
    assert.equal(await privacy.attemptUnlock('1111', 1_000), 'wrong');
    assert.equal(privacy.triesLeft, left);
  }
  assert.equal(await privacy.attemptUnlock('1111', 1_000), 'wrong');
  assert.equal(privacy.notice, 'That PIN is not right — no tries left. Wait a minute.');
  assert.equal(privacy.locked, true);
  // Even the right PIN is refused while the pause runs, and it lifts on its own clock.
  assert.equal(await privacy.attemptUnlock(PIN, 2_000), 'wait');
  assert.equal(privacy.locked, true);
  assert.equal(await privacy.attemptUnlock(PIN, 62_000), 'unlocked');
});

test('a foreign or corrupt stored record reads as no PIN, never a lock nobody can open', () => {
  assert.equal(pinRecordOf('garbage'), '');
  assert.equal(pinRecordOf('sha256::'), '');
  assert.equal(pinRecordOf(undefined), '');
  const record = pinRecordOf(PIN_RECORD);
  assert.match(record, /^sha256:[0-9a-f]{32}:[0-9a-f]{64}$/);
  const broken = state('privacy', 'privacy', undefined, { privacyPin: record.slice(0, -2) });
  assert.equal(broken.pinSet, false);
  assert.equal(broken.lock(), 'needs-pin');
});

test('lock folds the band at once, the tab still works while locked, and unlocking restores the chosen fold', async () => {
  for (const folded of [false, true]) {
    const privacy = state('privacy', 'privacy');
    privacy.bandCollapsed = folded;
    privacy.lock(); privacy.lock();
    // Locking is one press and it folds: the curtain is down, so the controls go with it.
    assert.equal(privacy.locked, true); assert.equal(privacy.bandCollapsed, true);
    // Unlocking gives back the fold the reader had before they locked, not a forced one.
    await privacy.attemptUnlock(PIN); assert.equal(privacy.bandCollapsed, folded);
  }
  // The tab is the way back to the band, so it opens while the curtain is down — and a fold the
  // reader chose there is theirs: unlocking must not shut the band they just opened.
  const privacy = state('privacy', 'privacy');
  privacy.bandCollapsed = true;
  privacy.lock();
  privacy.toggleBand();
  assert.equal(privacy.bandCollapsed, false);
  await privacy.attemptUnlock(PIN);
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
  await privacy.attemptUnlock(PIN);
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
  await privacy.attemptUnlock(PIN); assert.equal(categories.hiddenView,'revealed'); assert.equal(sources.hiddenView,'only');
});
