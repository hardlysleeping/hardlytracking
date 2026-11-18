/**
 * A 5 000-title shelf, mounted for real.
 *
 * The window in `lib/window.ts` is arithmetic, and `tests/unit/window.test.mjs` checks the numbers.
 * What arithmetic cannot answer is whether the grid actually stops creating tiles, whether the
 * spacers keep the scroll honest, and whether a title is still cut with an ellipsis once the clamp is
 * shared instead of per tile. Those are questions about a laid-out page, so this fixture asks them in
 * a browser:
 *
 *   node tests/manual/shelf-window.mjs        (vite dev must be serving this directory)
 *
 * Nothing here touches a real library: the titles and covers are generated in the page.
 */
import "../../src/app.css";
import { viewport } from "../../src/lib/layout.svelte";
viewport.start();
import { mount } from "svelte";
import SeriesGrid from "../../src/components/SeriesGrid.svelte";

const COVER =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="300"><rect width="200" height="300" fill="#346579"/><circle cx="100" cy="120" r="65" fill="#98b6a3"/></svg>',
  );

const COUNT = 5000;

const items = Array.from({ length: COUNT }, (_, index) => ({
  id: `archive:${index}`,
  provider: "archive",
  title: `Fixture ${String(index).padStart(4, "0")} — Absolute Superman vs The Black Labyrinth of Krypton Rising`,
  author: "Author name",
  status: "ongoing",
  description: "A shelf of five thousand, to see what the grid actually builds.",
  cover: COVER,
}));

const target = document.querySelector("#grid");
mount(SeriesGrid, {
  target,
  props: {
    series: items,
    view: "grid",
    cover: 132,
    onpick: () => {},
  },
});

/** What the page should be asked: counts, spacers, and one title's truncation. */
window.shelfQa = {
  count: COUNT,
  read() {
    const set = document.querySelector(".set");
    const main = document.querySelector("#qa");
    const pads = [...document.querySelectorAll(".set .pad")];
    const first = document.querySelector(".set .tile .title");
    const range = document.createRange();
    let lines = 0;
    let text = "";
    if (first !== null) {
      range.selectNodeContents(first);
      lines = range.getClientRects().length;
      text = first.textContent ?? "";
    }
    return {
      tiles: document.querySelectorAll(".set .tile").length,
      total: COUNT,
      scrollHeight: main?.scrollHeight ?? 0,
      clientHeight: main?.clientHeight ?? 0,
      pads: pads.map((pad) => Math.round(pad.getBoundingClientRect().height)),
      firstTileIndex: Number(document.querySelector(".set .tile")?.dataset.seriesId?.split(":")[1] ?? -1),
      title: { text, lines, ellipsised: text.endsWith("…"), clipped: first === null ? null : first.scrollHeight > first.clientHeight + 1 },
    };
  },
  scrollTo(fraction) {
    const main = document.querySelector("#qa");
    if (main === null) return 0;
    main.scrollTop = Math.round((main.scrollHeight - main.clientHeight) * fraction);
    return main.scrollTop;
  },
};