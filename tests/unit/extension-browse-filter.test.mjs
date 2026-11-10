import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  filterEntries,
  keepLanguages,
  languageCounts,
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

test('the sheet lists the languages the index really publishes, sorted and de-duplicated', () => {
  assert.deepEqual(languagesOf(INDEX), ['en', 'es', 'ja']);
  assert.deepEqual(languagesOf([]), []);
});

test('each language knows how many entries it would show', () => {
  assert.deepEqual([...languageCounts(INDEX)].sort(), [['en', 2], ['es', 2], ['ja', 1]]);
});

test('no languages picked is the whole index — never an empty list', () => {
  assert.equal(filterEntries(INDEX, '').length, 5);
  assert.equal(filterEntries(INDEX, '', []).length, 5);
  assert.equal(matchesBrowseFilter(INDEX[0], '', []), true);
  assert.deepEqual(filterEntries(INDEX, '', ['es']).map((row) => row.name), ['All-rounder', 'Spanish']);
});

test('the list is alphabetical by name, whatever order the index arrived in', () => {
  assert.deepEqual(filterEntries(INDEX, '').map((row) => row.name), [
    'All-rounder',
    'English',
    'Japanese only',
    'No sources',
    'Spanish',
  ]);
  // Search results are alphabetical too: a filtered list in index order reads as random. 'a' matches
  // every row, and INDEX order is deliberately not alphabetical, so this only passes if it sorts.
  assert.deepEqual(filterEntries(INDEX, 'a').map((row) => row.name), [
    'All-rounder',
    'English',
    'Japanese only',
    'No sources',
    'Spanish',
  ]);
});

test('several languages are a union, and none of them replaces another', () => {
  assert.deepEqual(filterEntries(INDEX, '', ['es']).map((row) => row.name), ['All-rounder', 'Spanish']);
  assert.deepEqual(filterEntries(INDEX, '', ['es', 'ja']).map((row) => row.name), ['All-rounder', 'Japanese only', 'Spanish']);
  // Case and padding in a stored code never make it match nothing.
  assert.deepEqual(filterEntries(INDEX, '', [' ES ']).map((row) => row.name), ['All-rounder', 'Spanish']);
});

test('the language and search filters compose instead of overriding each other', () => {
  assert.deepEqual(filterEntries(INDEX, 'span', ['es']).map((row) => row.name), ['Spanish']);
  assert.deepEqual(filterEntries(INDEX, 'span', ['en']).map((row) => row.name), []);
  assert.deepEqual(filterEntries(INDEX, 'a.one', ['ja']).map((row) => row.name), []);
});

test('search still finds an entry by language code when no language is picked', () => {
  assert.deepEqual(filterEntries(INDEX, ' ja ', []).map((row) => row.name), ['Japanese only']);
});

test('an entry with no sources is in the index but in no language', () => {
  assert.equal(matchesBrowseFilter(INDEX[4], '', []), true);
  assert.equal(matchesBrowseFilter(INDEX[4], '', ['en']), false);
});

test('switching repository cannot leave a language the new index does not publish', () => {
  assert.deepEqual(keepLanguages(['ja', 'es'], INDEX), ['ja', 'es']);
  assert.deepEqual(keepLanguages(['ja', 'es'], [INDEX[3]]), []);
  assert.deepEqual(keepLanguages([], []), []);
});

test('a repository name toggles its own list, and the entries stay in memory while folded', () => {
  const source = readFileSync(new URL('../../src/views/Extensions.svelte', import.meta.url), 'utf8');
  const open = source.slice(source.indexOf('async function openRepository('));
  const body = open.slice(0, open.indexOf('\n  }'));
  assert.match(body, /if \(activeRepo === url\) \{\s*collapsed = !collapsed;\s*return;/);
  assert.ok(body.indexOf('collapsed = !collapsed') < body.indexOf('library.repoEntries'), 'a second tap must not refetch the index');
  // The folded branch draws no summary or rows, so the screen is only its names.
  assert.match(source, /\{:else if collapsed\}/);
  // Both controls read the shared rule; the sheet's languages come from the live index.
  assert.match(source, /filterEntries\(allowed, search, languageFilter\)/);
  assert.match(source, /languagesOf\(allowed\)/);
});

test('languages are not chips in the header any more, and the list does not wait for a tap', () => {
  const source = readFileSync(new URL('../../src/views/Extensions.svelte', import.meta.url), 'utf8');
  // The wrapping chip row is gone: with twenty-odd languages it pushed the catalogue off screen.
  assert.doesNotMatch(source, /class="langs"/);
  assert.match(source, /ExtensionLanguageSheet/);
  // The section reads its first repository by itself.
  assert.match(source, /void openRepository\(first\.url\)/);
});
