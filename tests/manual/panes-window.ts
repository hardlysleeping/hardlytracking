/**
 * The library's three panes, laid out by a real engine.
 *
 * `tests/unit/panes-contract.test.mjs` checks the arithmetic and reads the stylesheet; neither can
 * answer "is the seam as tall as the shelf or as tall as the window", because that is a question
 * only a layout answers. This fixture mounts the actual `Library` on a two-hundred-title shelf so
 * the column is far taller than the screen, and `tests/manual/panes-window.mjs` measures it.
 *
 * Everything is generated in the page: no real library, no real source, no database on disk.
 */
import "../../src/app.css";
import { viewport } from "../../src/lib/layout.svelte";
viewport.start();
import { mount } from "svelte";
import Library from "../../src/views/Library.svelte";
import { library } from "../../src/state/library.svelte";
import { settings } from "../../src/state/settings.svelte";
import { categories } from "../../src/state/categories.svelte";
import { memoryDatabase } from "../../src/lib/db/open";
import { LibraryStore } from "../../src/lib/db/store";
import { libraryLayout } from "../../src/lib/layout-modes";
import { viewport as vp } from "../../src/lib/layout.svelte";

const store = new LibraryStore(memoryDatabase());
await settings.load(store);
await store.setPref("settings.libraryPane", "split");
await store.setPref("settings.libraryView", "grid");
await settings.load(store);

const COVER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#346579"/><circle cx="100" cy="120" r="65" fill="#98b6a3"/></svg>',
  );

const COUNT = 200;
const items = Array.from({ length: COUNT }, (_, index) => ({
  id: `archive:${index}`,
  provider: "archive",
  title: `Fixture ${String(index).padStart(3, "0")} — A long comic title`,
  author: "Author name",
  status: "ongoing",
  description: "A generated title, so the shelf is taller than the window.",
  cover: COVER,
}));
for (const item of items) await store.addSeries(item);

let detailCalls = 0;
const provider = {
  kind: "archive",
  ownsProgress: true,
  id: "archive",
  label: "Fixture",
  search: async () => ({ items, hasNext: false }),
  details: async (id) => {
    detailCalls += 1;
    return items.find((item) => item.id === id);
  },
  chapters: async () => [],
  sources: async () => [],
  pages: async () => [],
};

library.profile = { store, providers: [provider] };
library.sources = [{ id: "archive:source", provider: "archive", name: "Fixture", lang: "en" }];
library.library = items;
library.ready = true;
categories.items = [];

mount(Library, { target: document.querySelector("#qa") });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const scroller = () => document.querySelector("#qa");

window.panesQa = {
  count: COUNT,
  get detailCalls() {
    return detailCalls;
  },
  async settle(ms = 400) {
    await wait(ms);
  },
  measure() {
    const divider = document.querySelector(".panes .divider");
    const detail = document.querySelector(".detail");
    const body = document.querySelector(".body");
    const column = document.querySelector(".panes .column");
    const set = document.querySelector(".set");
    const rect = (node) => (node === null ? null : {
      width: Math.round(node.getBoundingClientRect().width),
      height: Math.round(node.getBoundingClientRect().height),
      top: Math.round(node.getBoundingClientRect().top),
      bottom: Math.round(node.getBoundingClientRect().bottom),
    });
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      splitRatio: settings.splitRatio,
      layout: libraryLayout(vp.width, vp.height, {
        nav: settings.categoryNav,
        splitRatio: settings.splitRatio,
        pane: settings.libraryPane,
      }),
      divider: divider === null ? null : { ...rect(divider), cursor: getComputedStyle(divider).cursor },
      body: rect(body),
      panes: rect(document.querySelector(".panes")),
      column: rect(column),
      collection: rect(document.querySelector(".collections")),
      set: rect(set),
      tiles: document.querySelectorAll(".set .tile").length,
      detail: detail === null ? null : {
        ...rect(detail),
        clientHeight: detail.clientHeight,
        scrollHeight: detail.scrollHeight,
        overflowY: getComputedStyle(detail).overflowY,
        maxHeight: Number.parseFloat(getComputedStyle(detail).maxHeight) || Number.POSITIVE_INFINITY,
      },
      doc: {
        scrollTop: Math.round(scroller().scrollTop),
        scrollHeight: Math.round(scroller().scrollHeight),
        clientHeight: Math.round(scroller().clientHeight),
      },
    };
  },
  async scrollShelf(to) {
    scroller().scrollTop = to;
    await wait(120);
    return Math.round(scroller().scrollTop);
  },
  async pick(index) {
    const buttons = [...document.querySelectorAll(".set .tile .open")];
    const button = buttons[index];
    if (button === undefined) return null;
    button.click();
    return buttons.length;
  },
  async setRatio(ratio) {
    settings.set("splitRatio", ratio);
    await wait(120);
  },
  resetSeam() {
    const divider = document.querySelector(".panes .divider");
    divider?.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  },
};