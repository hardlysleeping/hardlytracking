// Synthetic rows in memoryDatabase only. A fake provider stands in for the source: no network, no
// real library, no real account.
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
import type { Series, Chapter, Source } from '../../src/api/source';
const store = new LibraryStore(memoryDatabase());
const make = (page: number) => Array.from({ length: 12 }, (_, index) => ({
  id: `local:item-${page}-${index}`,
  provider: 'local',
  title: `Fixture title ${page}-${index + 1}`,
  author: 'Fixture Author',
  status: 'ongoing',
  description: 'A synthetic description long enough to reach the third line in a card layout, which is exactly the space a card spends when it is not compact.',
})) as Series[];
const rows = make(1);
const latestRows = make(2);
const sources: Source[] = [{ id: 'local:src:library', provider: 'local', name: 'Fixture Discover Source' }];
await store.putCategory({ id: 'reading', name: 'Reading', order: 0, hidden: false, pinned: false, tabPinned: true });
const chapters: Chapter[] = rows.map((row) => ({ id: `${row.id}:ch`, seriesId: row.id, name: `${row.title} issue`, number: 1, pageCount: 10, read: false }));
for (const row of rows) {
  await store.addSeries(row);
  await store.putChapters(row.id, chapters.filter((c) => c.seriesId === row.id));
}
const provider = {
  kind: 'local' as const,
  name: 'Fixture provider',
  ownsProgress: true,
  popular: async () => ({ items: rows, hasNext: false }),
  latest: async () => ({ items: latestRows, hasNext: false }),
  search: async () => ({ items: rows, hasNext: false }),
  details: async (id: string) => [...rows, ...latestRows].find((row) => row.id === id)!,
  chapters: async (id: string) => chapters.filter((c) => c.seriesId === id),
};
library.profile = { store, providers: [provider], warnings: [] } as any;
library.library = rows;
library.sources = sources;
library.ready = true;
downloads.load = async () => {};
downloads.knownTotals = async () => ({});
downloads.rows = [];
library.chapters = async (id) => chapters.filter((c) => c.seriesId === id);
library.ownsProgress = () => true;
await categories.load(store);
await sourceMarks.load(store);
await visibility.load(store);
await settings.load(store);
viewport.start();
(window as any).sourceFixture = { settings, store, library, rows, latestRows };
mount(Fixture, { target: document.body });
