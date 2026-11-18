/**
 * A title with all its issues, in a phone-width window — the screen "I can horizontally scroll on
 * pages like for a listing on a title with all the issues" is about.
 *
 * Everything is generated in the page: no real library, no source, no database on disk, no network.
 * `tests/manual/horizontal-overflow.mjs` drives it and measures, because "nothing can be dragged
 * sideways" is a question only an engine answers.
 *
 * Mounted the way the app is: one scroller around the whole content (`overflow-y: auto`, which is
 * what `main` is in `AppShell.svelte`), and the real component inside it. A phone would not be in the
 * library's split layout at this width, so `pick()` navigates to the series page — the fixture does
 * what the router does and mounts `Series` in the same scroller.
 */
import "../../src/app.css";
import { viewport } from "../../src/lib/layout.svelte";
viewport.start();
import { mount, unmount } from "svelte";
import Library from "../../src/views/Library.svelte";
import SeriesPage from "../../src/views/Series.svelte";
import { library } from "../../src/state/library.svelte";
import { settings } from "../../src/state/settings.svelte";
import { categories } from "../../src/state/categories.svelte";
import { memoryDatabase } from "../../src/lib/db/open";
import { LibraryStore } from "../../src/lib/db/store";

const store = new LibraryStore(memoryDatabase());
await settings.load(store);
await store.setPref("settings.libraryView", "grid");
await settings.load(store);

const COVER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#346579"/></svg>',
  );

const COUNT = 24;
const ISSUES = 40;
const items = Array.from({ length: COUNT }, (_, index) => ({
  id: `archive:${index}`,
  provider: "archive",
  title: `Fixture ${String(index).padStart(3, "0")} — A deliberately long comic title for wrapping`,
  author: "An author with a long name, written out in full",
  status: "ongoing",
  description: "A generated title, so a listing has plenty of rows to lay out.",
  cover: COVER,
}));

const chaptersFor = (seriesId) =>
  Array.from({ length: ISSUES }, (_, index) => ({
    id: `${seriesId}:ch:${index + 1}`,
    seriesId,
    // The longest realistic issue name: a number, a title and a scanlation credit.
    name: `Issue ${index + 1} — A very long chapter name that keeps going, part 2 (of 3) [Team Scanlation]`,
    number: index + 1,
    pageCount: 22,
    read: index % 3 === 0,
  }));

for (const item of items) {
  await store.addSeries(item);
  await store.putChapters(item.id, chaptersFor(item.id));
}

const provider = {
  kind: "archive",
  ownsProgress: true,
  id: "archive",
  label: "Fixture",
  search: async () => ({ items, hasNext: false }),
  details: async (id) => items.find((item) => item.id === id),
  chapters: async (id) => chaptersFor(id),
  sources: async () => [],
  pages: async () => [],
};

library.profile = { store, providers: [provider] };
library.sources = [{ id: "archive:source", provider: "archive", name: "Fixture", lang: "en" }];
library.library = items;
library.ready = true;
categories.items = [];

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const target = () => document.querySelector("#qa");

let mounted = null;

/** The two screens this file is about, mounted the way the router would mount them. */
async function show(which = "shelf", seriesId = "archive:0") {
  const host = target();
  if (mounted !== null) {
    unmount(mounted);
    mounted = null;
    host.replaceChildren();
  }
  mounted =
    which === "series"
      ? mount(SeriesPage, { target: host, props: { seriesId } })
      : mount(Library, { target: host });
  await wait(500);
  return which;
}

/**
 * Content that sticks out of the screen.
 *
 * An element whose box reaches past the window is content the reader cannot see — clipped by
 * whatever ancestor hides it, and the reason a page looks "cut off" at the right edge. An element
 * whose *content* is wider than its box is not a bug when its `overflow-x` is visible (a button's
 * 40 px tap target around 36 px of ink is by design, and the app says so in its stylesheet); it only
 * matters when something is allowed to scroll it, which is the separate `horizontalScrollers` question.
 */
function outside(root) {
  const found = [];
  const viewport = window.innerWidth;
  for (const node of root.querySelectorAll("*")) {
    const box = node.getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if (box.right <= viewport + 1 && box.left >= -1) continue;
    found.push({
      tag: node.tagName.toLowerCase(),
      cls: String(node.className).slice(0, 70),
      text: (node.textContent ?? "").trim().slice(0, 40),
      left: Math.round(box.left),
      right: Math.round(box.right),
      width: Math.round(box.width),
      overflowX: getComputedStyle(node).overflowX,
    });
  }
  return found;
}

/** Every element a finger could actually move sideways, with how far it can go. */
function horizontalScrollers(root) {
  const found = [];
  for (const node of [root, ...root.querySelectorAll("*")]) {
    const room = node.scrollWidth - node.clientWidth;
    if (room <= 1) continue;
    const style = getComputedStyle(node);
    if (style.overflowX !== "auto" && style.overflowX !== "scroll") continue;
    const before = node.scrollLeft;
    node.scrollLeft = 9999;
    const moved = node.scrollLeft;
    node.scrollLeft = before;
    found.push({
      tag: node.tagName.toLowerCase(),
      cls: String(node.className).slice(0, 70),
      room,
      moved,
      overflowX: style.overflowX,
    });
  }
  return found;
}

window.overflowQa = {
  count: COUNT,
  issues: ISSUES,
  show,
  async settle(ms = 500) {
    await wait(ms);
  },
  /** Scroll the page, then say where the sticky heading ended up. */
  async scroll(to = 600) {
    const scroller = target();
    scroller.scrollTop = to;
    await wait(250);
    const bar = document.querySelector(".view > header");
    return {
      scrollTop: Math.round(scroller.scrollTop),
      barTop: bar === null ? null : Math.round(bar.getBoundingClientRect().top),
      barWidth: bar === null ? null : Math.round(bar.getBoundingClientRect().width),
    };
  },
  measure() {
    const scroller = target();
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      doc: {
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      },
      scroller: {
        scrollWidth: scroller.scrollWidth,
        clientWidth: scroller.clientWidth,
        scrollHeight: scroller.scrollHeight,
        clientHeight: scroller.clientHeight,
        overflowX: getComputedStyle(scroller).overflowX,
        overflowY: getComputedStyle(scroller).overflowY,
      },
      tiles: document.querySelectorAll(".set .tile").length,
      chapters: document.querySelectorAll(".chapters .list > li").length,
      outside: outside(scroller),
      scrollers: horizontalScrollers(scroller),
    };
  },
};

// The shelf first, so a run that only reads the measurement still has a page on screen.
await show("shelf");