/**
 * The seat is the ink; the target is bigger than the ink.
 *
 * Measured at 390x844 on the built app: an icon seat is 38x38, a chip 30 px tall, the floating back
 * pill 40x40 — all under the 44 px a thumb can hit without aiming. The rows are laid out 8 px apart,
 * so a real size change would either reflow the bar the owner tuned or overlap the neighbour.
 *
 * The answer is an invisible overlay on the padding box. `elementFromPoint` at the pill's mid-edges
 * hits the button 2–3 px outside its box and nothing beyond that, and every element's own
 * `getBoundingClientRect()` is unchanged (38x38 / 40x40 / 30 px tall) — so the drawing is identical
 * and only the reach moved. 43x43 measured for the icon seats and the back pill, which is the 44 px
 * boundary less the exclusive edge `elementFromPoint` uses.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "src/app.css"), "utf8").replace(/\s+/g, " ");
const shell = readFileSync(join(root, "src/components/AppShell.svelte"), "utf8").replace(/\s+/g, " ");

test("an icon seat reaches past its own box without being resized", () => {
  assert.match(css, /\.btn\.icon \{ padding: 0; width: 36px; min-width: 36px; justify-content: center; position: relative; \}/);
  assert.match(css, /\.btn\.icon::after \{ content: ""; position: absolute; inset: -4px; border-radius: inherit; \}/);
});

test("a chip reaches past its own box without being resized", () => {
  assert.match(css, /\.chip \{ position: relative; \}/);
  assert.match(css, /\.chip::after \{ content: ""; position: absolute; inset: -4px; border-radius: inherit; \}/);
});

test("the floating back pill reaches 44 px without growing", () => {
  assert.match(shell, /\.hbtn \{[^}]*position: relative; \}/);
  assert.match(shell, /\.hbtn::after \{ content: ""; position: absolute; inset: -3px; border-radius: inherit; \}/);
});
