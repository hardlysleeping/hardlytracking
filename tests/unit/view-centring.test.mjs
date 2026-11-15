/**
 * A capped view centres in the space it is given.
 *
 * Every screen caps its own width (1100 source/search, 1200 library/browse/history, 720 settings)
 * and, before this rule, the cap sat at x=0: at 1440 the library had 240 px of empty surface on the
 * right and none on the left, a source had 340, settings 720, and at 1600 a source had 500. Nothing
 * was centred, so a wide window read as a phone column glued to one edge.
 *
 * `margin-inline: auto` and nothing else. Below the cap the auto margin resolves to zero, so the
 * phone layout is unchanged — measured at 390 px compact: view x=8, width 374, before and after.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "src/app.css"), "utf8");

/** The selector's own declaration block, whitespace-collapsed. */
function block(selector) {
  const at = css.indexOf(selector + " {");
  assert.notEqual(at, -1, `${selector} is missing`);
  return css.slice(at + selector.length, css.indexOf("}", at)).replace(/\s+/g, " ").trim();
}

test("the view block centres its capped column", () => {
  assert.match(block(".view"), /margin-inline: auto/);
});
