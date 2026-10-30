/**
 * The DOM half of the 5 000-row budget (T-L13): first paint, scroll frames, and how many nodes one
 * read mark touches. Node cannot measure this — it needs a layout engine — so it lives here, on the
 * dev server, as `/perf/bench.html?rows=5000`.
 *
 * The three numbers are printed into the page and into `document.title`, so a headless pass can read
 * them without a screenshot:
 *
 *   first-paint <ms>  |  scroll <fps> fps (p95 <ms>)  |  read-mark <n> mutations
 *
 * The targets this card promises: first paint < 300 ms, ≥ 55 fps while scrolling, and a read mark
 * touching ≤ 3 nodes.
 */
import { mount } from "svelte";
import "../src/app.css";
import SeriesGrid from "../src/components/SeriesGrid.svelte";

const rows = Number(new URLSearchParams(location.search).get("rows") ?? "5000");
const out = document.getElementById("out") as HTMLElement;
const host = document.getElementById("app") as HTMLElement;

const WORDS = ["Hollow", "Star", "Blue", "Iron", "Night", "Paper", "Salt", "Glass", "Ash", "Wild"];
const NOUNS = ["Garden", "Engine", "Lantern", "Orchard", "Signal", "Harbour", "Cipher", "Meadow"];

const series = Array.from({ length: rows }, (_, i) => ({
  id: `perf:${i}`,
  sourceId: `src:${i % 6}`,
  title: `${WORDS[i % WORDS.length]} ${NOUNS[(i * 7) % NOUNS.length]} ${i}`,
  author: `Author ${i % 97}`,
  description: "A synthetic row.",
  status: ["ongoing", "completed", "hiatus"][i % 3],
  categoryIds: i % 4 === 0 ? [] : [`cat:${i % 5}`],
  coverUrl: null,
  url: `/series/${i}`,
}));

// Every row draws a count, so clearing one is a visible change the observer can count.
const unread = new Map(series.map((row, i) => [row.id, (i % 3) + 1]));

// `?cv=off` measures the grid without the `content-visibility` lever, so the claim "this helped"
// is a pair of printed lines and not a belief.
if (new URLSearchParams(location.search).get("cv") === "off") {
  const style = document.createElement("style");
  style.textContent = ".set .tile { content-visibility: visible !important; contain-intrinsic-size: none !important; }";
  document.head.append(style);
}

// The props are `$state`, so a read mark can hand the mounted grid a new map — which is what the
// app does. Re-mounting would measure the worst case, not the one the reader produces.
const props = $state({ series, unread, cover: 132 });

const t0 = performance.now();
mount(SeriesGrid, { target: host, props });
// One frame after the mount is the first paint the reader would see.
requestAnimationFrame(() => {
  const firstPaint = performance.now() - t0;

  // A scripted 2 s scroll of the document, which is what the shell does.
  const frames: number[] = [];
  let last = performance.now();
  const start = last;
  const step = (now: number) => {
    frames.push(now - last);
    last = now;
    // A thumb, not a teleport: 40px a frame is ~2 400px/s, a fast real scroll. Jumping a
    // proportional slice of a million-pixel document measures layout thrash nobody can produce.
    window.scrollBy({ top: 40, behavior: "instant" as ScrollBehavior });
    if (now - start < 2000) requestAnimationFrame(step);
    else finish(frames, firstPaint);
  };
  requestAnimationFrame(step);
});

function finish(frames: number[], firstPaint: number): void {
  window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  const sorted = [...frames].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const mean = frames.reduce((sum, ms) => sum + ms, 0) / frames.length;
  const fps = 1000 / mean;

  // One read mark: the grid is handed a new unread Map, and the count is what the change costs.
  let mutations = 0;
  const observer = new MutationObserver((records) => {
    mutations += records.length;
  });
  observer.observe(host, { subtree: true, childList: true, attributes: true, characterData: true });
  const next = new Map(unread);
  next.set(series[0].id, 0);
  const after = performance.now();
  props.unread = next;
  requestAnimationFrame(() => {
    observer.disconnect();
    const line = [
      `rows ${rows}`,
      `first-paint ${firstPaint.toFixed(0)} ms`,
      `scroll ${fps.toFixed(0)} fps (p95 ${p95.toFixed(1)} ms, ${frames.length} frames)`,
      `read-mark ${mutations} mutations (${(performance.now() - after).toFixed(1)} ms)`,
    ].join("  |  ");
    out.textContent = line;
    document.title = line;
    console.log(line);
  });
}
