import assert from 'node:assert/strict';
import test from 'node:test';
import { memoryDatabase } from '../../src/lib/db/open.ts';
import { LibraryStore } from '../../src/lib/db/store.ts';
import { createProviders } from '../../src/api/registry.ts';
import { openLibraryProfile } from '../../src/api/profile.ts';
import { createSuwayomiProvider, suwayomiUrl } from '../../src/api/suwayomi.ts';
import { clearSuwayomi, setSuwayomiSettings, suwayomiSettings, suwayomiConfigured, suwayomiEnabled, setSuwayomiEnabled, probeSuwayomi } from '../../src/lib/suwayomi.ts';

const BASE = 'http://192.168.1.20:4567';
const settings = { baseUrl: BASE, username: 'reader', password: 'päss' };
function storage() {
  const values = new Map();
  globalThis.localStorage = { getItem: k => values.get(k) ?? null, setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) };
}
function fixture() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const { query, variables } = JSON.parse(init.body);
    calls.push({ url, init, query, variables });
    let data;
    if (query.includes('query Sources')) data = { sources: { nodes: [{ id: '1234567890123456789', name: 'Fixture', displayName: 'Fixture', lang: 'en' }] } };
    else if (query.includes('query Manga')) data = { manga: { id: 12, title: 'Fixture', thumbnailUrl: '/api/v1/manga/12/thumbnail' } };
    else if (query.includes('query Chapters')) data = { chapters: { nodes: [{ id: 42, name: 'Chapter', chapterNumber: 1, pageCount: 4, isRead: true, lastPageRead: 2 }] } };
    else if (query.includes('mutation Pages')) data = { fetchChapterPages: { pages: ['/api/v1/manga/12/chapter/1/page/0'] } };
    else if (query.includes('mutation SetRead')) data = { updateChapter: { chapter: { id: 42, isRead: variables.read } } };
    else throw Error(query);
    return Response.json({ data });
  };
  return { fetchImpl, calls };
}

test('settings allow anonymous servers, normalize /api, preserve password, and keep an explicit off switch', () => {
  storage();
  assert.equal(suwayomiSettings(), null);
  setSuwayomiSettings({ baseUrl: BASE + '/api///', username: '', password: '' });
  assert.equal(suwayomiConfigured(), true);
  assert.equal(suwayomiSettings().baseUrl, BASE);
  assert.equal(suwayomiEnabled(), true);
  setSuwayomiEnabled(false);
  setSuwayomiSettings(settings);
  assert.equal(suwayomiEnabled(), false);
  assert.equal(suwayomiSettings().password, 'päss');
  clearSuwayomi();
  assert.equal(suwayomiSettings(), null);
});

test('configured native mihonBase:null registers the EXISTING mihon provider without startup requests', async () => {
  storage(); setSuwayomiSettings(settings);
  const f = fixture();
  const set = await createProviders({ store: new LibraryStore(memoryDatabase()), mihonBase: null, dalvikBase: null, localFirst: true, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 0);
  const provider = set.providers.find(p => p.kind === 'mihon');
  assert.ok(provider);
  assert.equal(provider.ownsProgress, false);
  assert.equal((await provider.sources())[0].id, 'mihon:src:1234567890123456789');
  assert.equal(f.calls[0].url, BASE + '/api/graphql');
});

test('auth is carried on API, covers and pages; read-state and write use Mihon semantics', async () => {
  storage(); const f = fixture();
  const p = createSuwayomiProvider({ ...settings, fetchImpl: f.fetchImpl, proxied: false });
  const auth = 'Basic ' + Buffer.from('reader:päss').toString('base64');
  const series = await p.details('mihon:12');
  assert.equal(series.id, 'mihon:12');
  assert.equal(series.cover, BASE + '/api/v1/manga/12/thumbnail');
  assert.equal(series.coverHeaders.authorization, auth);
  const pages = await p.pages('mihon:ch:42');
  assert.equal(pages[0].url, BASE + '/api/v1/manga/12/chapter/1/page/0');
  assert.equal(pages[0].headers.authorization, auth);
  await p.chapters('mihon:12');
  assert.deepEqual(await p.readState('mihon:12'), [{ chapterId: 'mihon:ch:42', read: true, page: 2 }]);
  await p.setRead('mihon:ch:42', true, 3);
  assert.deepEqual(f.calls.at(-1).variables, { id: 42, read: true, page: 3 });
  for (const call of f.calls) assert.equal(call.init.headers.authorization, auth);
});

test('root and /api settings produce absolute same-origin browser proxy assets and reject foreign assets', () => {
  const origin = 'https://reader.local';
  const expected = origin + '/api/suwayomi/' + Buffer.from(BASE).toString('base64url') + '/api/v1/cover';
  for (const base of [BASE, BASE + '/api/']) {
    assert.equal(suwayomiUrl(base, '/api/v1/cover', true, origin), expected);
    assert.equal(suwayomiUrl(base, BASE + '/api/v1/cover', true, origin), expected);
  }
  assert.throws(() => suwayomiUrl(BASE, 'https://other.test/cover', false), /origin/i);
});

test('probe lists sources, uses POST GraphQL, permits no auth, reports denied login and malformed responses', async () => {
  storage(); const f = fixture();
  assert.deepEqual(await probeSuwayomi(settings, f.fetchImpl), { ok: true, sources: ['Fixture'] });
  assert.deepEqual(await probeSuwayomi({ ...settings, username: '', password: '' }, f.fetchImpl), { ok: true, sources: ['Fixture'] });
  assert.equal(f.calls.at(-1).init.headers.authorization, undefined);
  for (const status of [401,403]) assert.match((await probeSuwayomi(settings, async () => new Response('', { status }))).error, /refused.*login/i);
  assert.equal((await probeSuwayomi(settings, async () => Response.json({ data: {} }))).ok, false);
  assert.equal((await probeSuwayomi(settings, async () => Response.json({ errors: [{ message: 'Denied' }] }))).ok, false);
});

test('profile refresh swaps configured provider and builtin toggle removes it; row cannot be uninstalled', async () => {
  storage(); const f = fixture(); setSuwayomiSettings(settings);
  const p = await openLibraryProfile({ database: memoryDatabase(), localFirst: true, mihonBase: null, dalvikBase: null, fetchImpl: f.fetchImpl });
  assert.equal(f.calls.length, 0);
  assert.ok((await p.listExtensions()).find(r => r.extensionId === 'builtin:suwayomi' && r.builtin));
  const before = p.providers.find(p => p.kind === 'mihon');
  setSuwayomiSettings({ ...settings, baseUrl: BASE + '/api' });
  assert.equal(await p.refreshSuwayomi(), null);
  assert.notEqual(p.providers.find(p => p.kind === 'mihon'), before);
  await p.setExtensionEnabled('builtin:suwayomi', false);
  assert.equal(suwayomiEnabled(), false);
  assert.equal(p.providers.some(p => p.kind === 'mihon'), false);
  await p.setExtensionEnabled('builtin:suwayomi', true);
  assert.equal(p.providers.filter(p => p.kind === 'mihon').length, 1);
  await assert.rejects(p.uninstallExtension('builtin:suwayomi'), /built in/);
  clearSuwayomi(); await p.refreshSuwayomi();
  assert.equal(p.providers.some(p => p.kind === 'mihon'), false);
});

test('default browser Mihon fallback remains unless explicitly off or replaced', async () => {
  storage();
  const config = { store: new LibraryStore(memoryDatabase()), localFirst: true, dalvikBase: null };
  assert.equal((await createProviders(config)).providers.filter(p => p.kind === 'mihon').length, 1);
  setSuwayomiEnabled(false);
  assert.equal((await createProviders(config)).providers.filter(p => p.kind === 'mihon').length, 0);
});

test('probe deadline bounds both a hung fetch and a response with a hung JSON body', async () => {
  for (const fetchImpl of [async () => new Promise(() => {}), async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })]) {
    const result = await probeSuwayomi(settings, fetchImpl, 15);
    assert.equal(result.ok, false);
    assert.match(result.error, /did not answer/);
  }
});

test('anonymous provider has no cover or page authorization and prefix installs preserve the base path', async () => {
  const f = fixture();
  const p = createSuwayomiProvider({ baseUrl: BASE + '/suwayomi/api', username: '', password: '', fetchImpl: f.fetchImpl, proxied: false });
  assert.equal((await p.details('mihon:12')).cover, BASE + '/suwayomi/api/v1/manga/12/thumbnail');
  assert.equal((await p.details('mihon:12')).coverHeaders, undefined);
  assert.equal((await p.pages('mihon:ch:42'))[0].headers, undefined);
  assert.equal(f.calls[0].url, BASE + '/suwayomi/api/graphql');
});
