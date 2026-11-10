// The listing chips on a source page: a source that declares its own row (three listings) and a
// source that declares nothing (the pair every other source has). Synthetic rows, fake provider, no
// network — the only thing under test is which chips appear, in what order, and what each one loads.
//
//   ?source=tabs   → the source declares Trending, Popular, Latest
//   ?source=plain  → the source declares nothing
import { mount } from 'svelte';
import Fixture from './SourceDisplayFixture.svelte';
import '../../src/app.css';
import { DEFAULT_THEME, themeVariables } from '../../src/lib/theme-model';
for (const [key, value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key, value);
import { memoryDatabase } from '../../src/lib/db/open';
import { LibraryStore } from '../../src/lib/db/store';
import { downloads } from '../../src/state/downloads.svelte';
import { library } from '../../src/state/library.svelte';
import { categories } from '../../src/state/categories.svelte';
import { sourceMarks } from '../../src/state/source-marks.svelte';
import { visibility } from '../../src/state/visibility.svelte';
import { settings } from '../../src/state/settings.svelte';
import { viewport } from '../../src/lib/layout.svelte';
import type { Series, Source, SourceProvider } from '../../src/api/source';

const mode = new URLSearchParams(location.search).get('source') ?? 'tabs';
const declaring = mode === 'tabs';

const store = new LibraryStore(memoryDatabase());
// ?long=1 makes every title far too long for two lines, which is the case the overlay title has to
// truncate with an ellipsis.
const long = new URLSearchParams(location.search).get('long') === '1';
const rowsFor = (tag: string): Series[] =>
  Array.from({ length: 6 }, (_, index) => ({
    id: `local:${tag}-${index}`,
    provider: 'local',
    title: long
      ? `${tag} ${index + 1} — Absolute Superman vs The Black Lantern Corps Annual Deluxe Edition`
      : `${tag} ${index + 1}`,
    author: 'Fixture Author',
    status: 'ongoing',
    description: 'A synthetic row that exists only to prove which listing filled the grid.',
  })) as Series[];

const sourceId = declaring ? 'local:src:texts' : 'local:src:plain';
const source: Source = {
  id: sourceId,
  provider: 'local',
  name: declaring ? 'Fixture Archive' : 'Fixture Plain Source',
  lang: 'en',
  supportsLatest: true,
  ...(declaring ? { browseTabs: ['trending', 'popular', 'latest'] as const } : {}),
};

const provider: SourceProvider = {
  kind: 'local',
  ownsProgress: true,
  sources: async () => [source],
  popular: async () => ({ items: rowsFor('popular'), hasNext: false }),
  latest: async () => ({ items: rowsFor('latest'), hasNext: false }),
  ...(declaring ? { trending: async () => ({ items: rowsFor('trending'), hasNext: false }) } : {}),
  search: async () => ({ items: rowsFor('search'), hasNext: false }),
  details: async (id: string) => [...rowsFor('popular'), ...rowsFor('latest'), ...rowsFor('trending')].find((row) => row.id === id)!,
  chapters: async () => [],
};

await store.putCategory({ id: 'reading', name: 'Reading', order: 0, hidden: false, pinned: false, tabPinned: true });
library.profile = { store, providers: [provider], warnings: [] } as never;
library.library = [];
library.sources = [source];
library.ready = true;
downloads.load = async () => {};
downloads.knownTotals = async () => ({});
downloads.rows = [];
library.chapters = async () => [];
library.ownsProgress = () => true;
await categories.load(store);
await sourceMarks.load(store);
await visibility.load(store);
await settings.load(store);
viewport.start();
(window as never as { tabsFixture: unknown }).tabsFixture = { library, settings, source };
mount(Fixture, { target: document.body, props: { sourceId } });
