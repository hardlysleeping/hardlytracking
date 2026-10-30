/**
 * The 5 000-row budget, as a number rather than an intention (T-L13).
 *
 *   npm run perf
 *
 * What it measures, and why each one matters:
 *
 * 1. **derive** — `runQuery` over 5 000 series through the real pipeline (eye/pin → collection →
 *    filter → search → sort). This runs on every keystroke in the search box and on every read
 *    mark, so it is the number that decides whether typing feels like typing.
 * 2. **facts** — building the per-row fact maps (unread, downloaded, last read, status) the grid
 *    reads. One read mark replaces these maps today, which re-derives all 5 000.
 * 3. **tiles** — the cost of the *data* each card needs, i.e. the work that happens once per row
 *    regardless of DOM. The DOM half (first paint, frame times) cannot be measured in Node: run
 *    the app at 5 000 rows in a browser and read the same numbers off the performance panel.
 *
 * It prints a line per measurement. The claim this card makes is the printed line.
 */
import { performance } from "node:perf_hooks";

import { runQuery } from "../src/lib/library/query.ts";
import { EMPTY_FILTER } from "../src/lib/library/filter.ts";
import { EMPTY_SEARCH } from "../src/lib/library/search.ts";
import { DEFAULT_SORT } from "../src/lib/library/sort.ts";
import { cleanOrder } from "../src/lib/library/order.ts";
import { applyCollection, collectionState, hiddenBy, selectAll } from "../src/lib/library/selection.ts";

const N = Number(process.env.PERF_ROWS ?? 5000);

/** Deterministic, so two runs are comparable: same ids, same titles, same order. */
function seed(rows) {
  let state = 0x2f6e2b1;
  const rand = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 10000) / 10000;
  };
  const words = ["Hollow", "Star", "Blue", "Iron", "Night", "Paper", "Salt", "Glass", "Ash", "Wild"];
  const nouns = ["Garden", "Engine", "Lantern", "Orchard", "Signal", "Harbour", "Cipher", "Meadow"];
  const series = [];
  for (let i = 0; i < rows; i += 1) {
    series.push({
      id: `perf:${i}`,
      sourceId: `src:${i % 6}`,
      title: `${words[i % words.length]} ${nouns[(i * 7) % nouns.length]} ${i}`,
      author: `Author ${i % 97}`,
      description: "A synthetic row, so the measurement is about the pipeline and not the network.",
      status: ["ongoing", "completed", "hiatus"][i % 3],
      categoryIds: i % 4 === 0 ? [] : [`cat:${i % 5}`],
      coverUrl: null,
      url: `/series/${i}`,
    });
  }
  const categories = [0, 1, 2, 3, 4].map((n) => ({
    id: `cat:${n}`,
    name: `Collection ${n}`,
    order: n,
    hidden: false,
    pinned: n === 0,
  }));
  const facts = {
    unread: new Map(series.map((row, i) => [row.id, i % 3])),
    downloaded: new Map(series.map((row, i) => [row.id, i % 7])),
    lastRead: new Map(series.map((row, i) => [row.id, 1_700_000_000_000 - i * 1000])),
    newUpdates: new Set(series.filter((_, i) => i % 11 === 0).map((row) => row.id)),
    status: new Map(series.map((row) => [row.id, row.status])),
    total: new Map(series.map((row, i) => [row.id, (i % 120) + 1])),
  };
  return { series, categories, facts, rand };
}

function ms(fn, runs = 12) {
  // One warm-up, then the median: the first call pays for the JIT and reads as a regression.
  fn();
  const times = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { median: times[Math.floor(times.length / 2)], min: times[0], max: times[times.length - 1] };
}

const show = (label, value, unit = "ms") =>
  console.log(`${label.padEnd(34)} ${value.toFixed(2).padStart(8)} ${unit}`);

const { series, categories, facts } = seed(N);
const input = { series, categories, marks: { hiddenView: false, pinView: true } };
const base = {
  collection: null,
  filter: { ...EMPTY_FILTER, statuses: [], sources: [] },
  search: EMPTY_SEARCH,
  sort: DEFAULT_SORT,
};

console.log(`rows ${N}`);
show("derive: whole library", ms(() => runQuery(input, base, facts)).median);
show(
  "derive: one collection",
  ms(() => runQuery(input, { ...base, collection: "cat:1" }, facts)).median,
);
show(
  "derive: search, 2 words",
  ms(() => runQuery(input, { ...base, search: { text: "hollow 42", scope: "category" } }, facts))
    .median,
);
show(
  "derive: filter + search + sort",
  ms(
    () =>
      runQuery(
        input,
        {
          ...base,
          filter: { ...base.filter, unread: "unread", sources: ["src:2"] },
          search: { text: "star", scope: "all" },
          sort: { key: "title", direction: "asc" },
        },
        facts,
      ),
  ).median,
);
show(
  "derive: manual order",
  ms(
    () =>
      runQuery(
        input,
        { ...base, sort: { key: "manual", direction: "asc" }, manual: cleanOrder(series.map((r) => r.id)) },
        facts,
      ),
  ).median,
);

// The facts a read mark rebuilds today: one `new Map(...)` per fact over every row.
const rebuild = ms(() => ({
  unread: new Map(series.map((row, i) => [row.id, i % 3])),
  downloaded: new Map(series.map((row, i) => [row.id, i % 7])),
  lastRead: new Map(series.map((row, i) => [row.id, 1_700_000_000_000 - i * 1000])),
  newUpdates: new Set(series.filter((_, i) => i % 11 === 0).map((row) => row.id)),
  status: new Map(series.map((row) => [row.id, row.status])),
  total: new Map(series.map((row, i) => [row.id, (i % 120) + 1])),
}));
show("facts: rebuild all maps", rebuild.median);

const rows = series.map((row) => ({ id: row.id, categoryIds: row.categoryIds }));
show("selection: select all", ms(() => selectAll(rows)).median);
show("selection: collection tri-state", ms(() => collectionState(rows, "cat:1")).median);
show(
  "selection: apply to a collection",
  ms(() => applyCollection(rows.map((row) => row.id), "cat:1", true)).median,
);
show("selection: hidden by a change", ms(() => hiddenBy(selectAll(rows), rows)).median);

console.log(`
the DOM half (first paint, scroll frames, nodes a read mark touches) needs a layout engine:
  npx vite build --config perf/vite.bench.config.ts
  npx vite preview --config perf/vite.bench.config.ts --port 5186
  open http://localhost:5186/perf/bench.html?rows=5000   (add &cv=off to see it without the lever)`);
