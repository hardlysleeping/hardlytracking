/**
 * Press states: every seat answers a finger.
 *
 * A hover is invisible on a phone, so a control whose only interaction state is `:hover` is a
 * control that looks dead on the device this app is built for. The sweep that produced this file
 * counted them off the live DOM: 61 `:hover`, 23 `:focus-visible`, 10 `:active` across 8 files.
 *
 * Two numbers, both already in the app before this pass — nothing new was invented:
 * `scale(0.985)` for a seat with words in it (`SeriesActions .act`), `scale(0.94)` for a glyph
 * (`AppShell .hbtn`, `CollapseFloat`). `transform` only, so a press can never reflow a row.
 *
 * Rows and rails are deliberately absent: scaling a 688 px door row is layout motion, not
 * feedback. A row that should answer gets a background instead (`SeriesActions .row:active`).
 *
 * These read the sources as text: `:active` cannot be forced in a headless browser (the pseudo
 * state reaches `el.matches()` but never style resolution), so the assertion is that the rule
 * exists with the number the app uses; the resting box was measured separately and did not move.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => readFileSync(join(root, rel), "utf8");

/** The selector's own declaration block, whitespace-collapsed, so a value can be asserted. */
function block(source, selector) {
  const at = source.indexOf(selector + " {");
  assert.notEqual(at, -1, `${selector} is missing`);
  const end = source.indexOf("}", at);
  return source.slice(at + selector.length, end).replace(/\s+/g, " ").trim();
}

test("every global button answers a press", () => {
  const css = read("src/app.css");
  assert.match(block(css, ".btn:active"), /transform: scale\(0\.985\)/);
  assert.match(block(css, ".btn.icon:active"), /transform: scale\(0\.94\)/);
});

test("the nav seat answers a press in all three renderers", () => {
  // One rule, because the bar, the rail and the sidebar draw the same `.item` seat.
  assert.match(block(read("src/app.css"), ":root .item:active"), /transform: scale\(0\.94\)/);
  for (const f of ["src/components/BottomBar.svelte", "src/components/AppShell.svelte"]) {
    assert.match(read(f), /class="item"/, `${f} no longer draws the shared seat`);
  }
});
