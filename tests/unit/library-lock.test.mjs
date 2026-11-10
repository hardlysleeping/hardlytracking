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
// A pref store the way `Settings` behaves for the fields the curtain writes: the assignment lands
// first and the save is fire-and-forget. The band's fold is a preference now, so the fixture has to
// keep one instead of only holding the PIN.
const prefs = (stored = {}) => ({
  privacyPin: PIN_RECORD,
  privacyBandCollapsed: false,
  ...stored,
  set(key, value) { this[key] = value; },
});

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
  assert.equal(privacy.notice, 'That PIN is not right — try again.');
  assert.equal(await privacy.attemptUnlock('2469'), 'wrong');
  assert.equal(privacy.notice, 'That PIN is not right — try again.');
  assert.equal(await privacy.attemptUnlock('2468'), 'unlocked');
  assert.equal(privacy.locked, false);
  assert.equal(privacy.bandCollapsed, true, 'the fold chosen before locking comes back');
});

test('wrong tries are unlimited: no count, no pause, and the right PIN still opens it', async () => {
  const privacy = state('privacy', 'privacy');
  privacy.lock();
  // Twenty wrong tries in a row, on one clock tick: none of them is refused for being the last.
  for (let i = 0; i < 20; i++) {
    assert.equal(await privacy.attemptUnlock('1111', 1_000), 'wrong');
    assert.equal(privacy.locked, true);
  }
  assert.equal(privacy.notice, 'That PIN is not right — try again.');
  assert.equal(await privacy.attemptUnlock(PIN, 1_000), 'unlocked');
  assert.equal(privacy.locked, false);
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

test('the fold is a preference: it survives a relaunch, and the curtain never rewrites it', async () => {
  const settings = prefs();
  const privacy = state('privacy', 'privacy', undefined, settings);
  assert.equal(privacy.bandCollapsed, false);
  privacy.toggleBand();
  assert.equal(privacy.bandCollapsed, true);
  assert.equal(settings.privacyBandCollapsed, true, 'the fold is written, not only drawn');

  // A relaunch: a new state object over the same stored preferences reads the fold back.
  const reopened = state('privacy', 'privacy', undefined, settings);
  assert.equal(reopened.bandCollapsed, true, 'the band comes back folded, the way it was left');

  // Locking folds the band without touching the stored choice, so unlocking hands it back as-is.
  assert.equal(reopened.lock(), 'locked');
  assert.equal(reopened.bandCollapsed, true);
  assert.equal(settings.privacyBandCollapsed, true, 'a lock is not the reader changing their mind');
  await reopened.attemptUnlock(PIN);
  assert.equal(reopened.bandCollapsed, true);
  assert.equal(settings.privacyBandCollapsed, true);

  // An open band is remembered the same way.
  reopened.toggleBand();
  assert.equal(settings.privacyBandCollapsed, false);
  assert.equal(state('privacy', 'privacy', undefined, settings).bandCollapsed, false);
});

test('the fold is a declared preference, so `set` persists it and `load` reads it back', () => {
  // `Settings.set` writes `settings.<key>` for any declared `Prefs` key and nothing else, so the
  // declaration plus the read in `load` *is* the persistence path — a key that is only a `$state`
  // field would survive the session and be lost on the next launch.
  const source = readFileSync(new URL('../../src/state/settings.svelte.ts', import.meta.url), 'utf8');
  const prefs = source.slice(source.indexOf('export interface Prefs'), source.indexOf('class Settings'));
  assert.match(prefs, /privacyBandCollapsed: boolean;/, 'the fold is part of the stored preference shape');
  assert.match(source, /privacyBandCollapsed = \$state\(false\)/, 'and it has a default of open');
  assert.match(source, /read<boolean>\("privacyBandCollapsed", false\)/, 'load reads it, so a relaunch restores it');
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
