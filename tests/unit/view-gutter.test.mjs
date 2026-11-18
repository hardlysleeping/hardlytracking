/**
 * One gutter per view, or the page drags sideways on a phone.
 *
 * The sticky header rule in `app.css` reaches the edge of the screen by cancelling the view's inline
 * padding and giving the same amount back as its own. It can only do that if it knows the number, and
 * the number is not `--pad-x` on every screen: `Source` and `Series` cap their gutter at 8 px so the
 * covers and issue rows get the width. When the header cancelled 16 px against an 8 px gutter, the
 * bar was 456 px wide in a 440 px window and the whole page could be dragged 8 px sideways — the
 * report "I can horizontally scroll on … a title with all the issues".
 *
 * So the gutter is declared once, as `--view-pad-x`, and three things are pinned here: the sticky
 * rule reads that variable rather than the shell's, the shell's scroller cannot scroll sideways at
 * all, and no view sets its own inline padding to anything but the variable it declared. Measured in
 * an engine by `tests/manual/horizontal-overflow.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const app = readFileSync(new URL("../../src/app.css", import.meta.url), "utf8");
const shell = readFileSync(new URL("../../src/components/AppShell.svelte", import.meta.url), "utf8");
const viewsDirectory = new URL("../../src/views/", import.meta.url);

/**
 * The declarations inside the first rule whose line begins with `selector`.
 *
 * Line-anchored on purpose: `.view` also appears in comments and in descendant selectors, and a
 * plain `indexOf` finds whichever came first — a test that reads the wrong block passes for the
 * wrong reason.
 */
function block(css, selector) {
  let at = 0;
  let found = -1;
  for (const line of css.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith(selector) && (trimmed.endsWith("{") || trimmed.endsWith(","))) {
      found = at;
      break;
    }
    at += line.length + 1;
  }
  if (found < 0) return "";
  const open = css.indexOf("{", found);
  if (open < 0) return "";
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    else if (css[index] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, index);
    }
  }
  return "";
}

test("the sticky header cancels the view's own gutter, not the shell's", () => {
  const sticky = block(app, ":root .view > header,");
  assert.ok(sticky !== "", "the sticky header rule is gone — did a selector change?");
  for (const edge of ["margin-left", "margin-right", "padding-left", "padding-right"]) {
    const line = sticky.split("\n").find((row) => row.trim().startsWith(`${edge}:`));
    assert.ok(line !== undefined, `the sticky header no longer sets ${edge}`);
    assert.match(line, /var\(--view-pad-x\)/, `${edge} reads a gutter the view did not declare`);
  }
  assert.doesNotMatch(sticky, /var\(--pad-x\)/, "the shell's gutter is not the view's gutter");
});

test("a view declares the gutter it pads by, and pads by the gutter it declared", () => {
  const view = block(app, ".view");
  assert.match(view, /--view-pad-x:\s*var\(--pad-x\)/, "the default gutter is not declared");
  assert.match(view, /padding-left:\s*var\(--view-pad-x\)/, "the view pads by something else");
  assert.match(view, /padding-right:\s*var\(--view-pad-x\)/, "the view pads by something else");
});

test("the shell's scroller cannot be moved sideways", () => {
  const main = block(shell, "main");
  assert.match(main, /overflow-y:\s*auto/, "main is no longer the scroller");
  // `visible` beside `auto` is promoted to `auto` by the browser, which is how the page became a
  // horizontal scroller in the first place. Only `clip` or `hidden` answer the question.
  assert.match(main, /overflow-x:\s*(clip|hidden)/, "main has no sideways answer, so it will scroll");
});

test("no view pads itself by something its sticky header cannot cancel", () => {
  const offenders = [];
  for (const name of readdirSync(viewsDirectory).filter((file) => file.endsWith(".svelte"))) {
    const source = readFileSync(new URL(name, viewsDirectory), "utf8");
    const view = block(source, ".view");
    if (view === "") continue;
    for (const edge of ["padding-left", "padding-right"]) {
      const line = view.split("\n").find((row) => row.trim().startsWith(`${edge}:`));
      if (line === undefined) continue;
      if (!/var\(--view-pad-x\)/.test(line)) {
        offenders.push(`${name}: ${line.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "a view pads by its own number, so its sticky header hangs past the edge — declare --view-pad-x instead",
  );
});