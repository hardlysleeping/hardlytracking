import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALL_LANGUAGES,
  filterEntries,
  keepLanguage,
  languagesOf,
  matchesBrowseFilter,
} from '../../src/lib/extensions/browse-filter.ts';

/** Only the fields the filter reads; an index entry carries much more. */
const entry = (name, pkg, langs) => ({ name, pkg, version: '1.0', versionCode: 1, sources: langs.map((lang) => ({ id: lang, name: `${lang} source`, lang })) });

const INDEX = [
  entry('All-rounder', 'a.one', ['en', 'es']),
  entry('Japanese only', 'a.two', ['ja']),
  entry('Spanish', 'a.three', ['es']),
  entry('English', 'a.four', ['en']),
  entry('No sources', 'a.five', []),
];

test('the chips are the languages the index really publishes, sorted and de-duplicated', () => {
  assert.deepEqual(languagesOf(INDEX), ['en', 'es', 'ja']);
  assert.deepEqual(languagesOf([]), []);
});

test('All is the only value that does not narrow, and a blank code never matches everything', () => {
  assert.equal(filterEntries(INDEX, '', ALL_LANGUAGES).length, 5);
  assert.equal(filterEntries(INDEX, '', '').length, 5, 'an empty saved value reads as All');
  assert.deepEqual(filterEntries(INDEX, '', 'es').map((row) => row.name), ['All-rounder', 'Spanish']);
});

test('the language and search filters compose instead of overriding each other', () => {
  assert.deepEqual(filterEntries(INDEX, 'span', 'es').map((row) => row.name), ['Spanish']);
  assert.deepEqual(filterEntries(INDEX, 'span', 'en').map((row) => row.name), []);
  assert.deepEqual(filterEntries(INDEX, 'a.one', 'ja').map((row) => row.name), []);
});

test('search still finds an entry by language code when no chip is set', () => {
  assert.deepEqual(filterEntries(INDEX, ' ja ', ALL_LANGUAGES).map((row) => row.name), ['Japanese only']);
});

test('an entry with no sources is never hidden by All and never claimed by a chip', () => {
  assert.equal(matchesBrowseFilter(INDEX[4], '', ALL_LANGUAGES), true);
  assert.equal(matchesBrowseFilter(INDEX[4], '', 'en'), false);
});

test('switching repository cannot leave a language the new index does not publish', () => {
  assert.equal(keepLanguage('ja', INDEX), 'ja');
  assert.equal(keepLanguage('ja', [INDEX[3]]), ALL_LANGUAGES);
  assert.equal(keepLanguage(ALL_LANGUAGES, []), ALL_LANGUAGES);
});

test('a repository name toggles its own list, and the entries stay in memory while folded', () => {
  const source = readFileSync(new URL('../../src/views/Extensions.svelte', import.meta.url), 'utf8');
  const open = source.slice(source.indexOf('async function openRepository('));
  const body = open.slice(0, open.indexOf('\n  }'));
  assert.match(body, /if \(activeRepo === url\) \{\s*collapsed = !collapsed;\s*return;/);
  assert.ok(body.indexOf('collapsed = !collapsed') < body.indexOf('library.repoEntries'), 'a second tap must not refetch the index');
  // The folded branch draws no summary or rows, so the screen is only its names.
  assert.match(source, /\{:else if collapsed\}/);
  // Both controls read the shared rule, and the chips come from the live index.
  assert.match(source, /filterEntries\(allowed, search, language\)/);
  assert.match(source, /languagesOf\(allowed\)/);
});
