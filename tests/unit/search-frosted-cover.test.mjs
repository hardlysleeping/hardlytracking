/**
 * The opened search card, dressed in its own cover.
 *
 * The requirement is presentational and narrow: tapping a result expands that row and the pane
 * carries the same artwork, blurred, behind its text. Every assertion here is about the seam that
 * makes that safe — one resolution shared with the visible tile, a reset between titles, and a
 * decorative layer that can never swallow a tap or hide behind an opaque background.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const cover = readFileSync(new URL("../../src/components/Cover.svelte", import.meta.url), "utf8");
const search = readFileSync(new URL("../../src/views/Search.svelte", import.meta.url), "utf8");
/** Collapse formatting so an assertion is about code, not about where a line happens to wrap. */
const flat = (text) => text.replace(/\s+/g, " ");

test("the tile reports the URL it resolved, not the raw cover field", () => {
  // A login-protected or owned cover only exists as a cache blob URL; reporting `series.cover`
  // would give the pane a URL that cannot be drawn while the tile draws fine.
  assert.match(flat(cover), /onresolve\?: \(src: string \| undefined\) => void;/);
  // The synchronous report must not subscribe the loader to its own async `src` result.
  assert.match(flat(cover), /const initial = loadable\(url, needsLogin\); src = initial;/);
  assert.match(flat(cover), /untrack\(\(\) => onresolve\?\.\(initial\)\);/);
  assert.match(flat(cover), /src = resolved; onresolve\?\.\(resolved\);/);
  // No cover at all must also be reported, or a pane opened over a previous title keeps its glass.
  assert.match(flat(cover), /src = undefined; untrack\(\(\) => onresolve\?\.\(undefined\)\);/);
});

test("the expanded card reuses the hero tile's resolution instead of resolving again", () => {
  const card = flat(search.slice(search.indexOf("{#snippet detailCard()}")));
  assert.match(card, /class="dblur" aria-hidden="true"/);
  // The image reaches the layer through a custom property: the box itself must stay unpainted, or
  // an unblurred copy would sit under the frosted one.
  assert.match(card, /style:--glass=\{`url\("\$\{heroSrc\.replaceAll\('"', "%22"\)\}"\)`\}/);
  assert.match(card, /<Cover series=\{record\} size="hero" onresolve=\{\(src\) => \(heroSrc = src \?\? null\)\} \/>/);
  // The decorative layer must not sit inside the scrolling body as content.
  assert.ok(card.indexOf('class="dblur"') < card.indexOf('class="dscroll"'));
});

/** The body of a named function, matched by braces so an early `return }` cannot cut it short. */
function body(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name}() is missing`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced body for ${name}()`);
}

test("opening or closing a card drops the previous title's artwork", () => {
  for (const fn of ["show", "close"]) {
    assert.match(flat(body(search, fn)), /heroSrc = null;/, `${fn}() must reset the backdrop`);
  }
  // Reset on open happens before the cached-details early return, so a cache hit still clears.
  const open = body(search, "show");
  assert.ok(open.indexOf("heroSrc = null") < open.indexOf("const cached"));
});

test("the backdrop is behind the text, untappable, and clipped by the card", () => {
  const styles = search.slice(search.indexOf("  .dblur {"));
  assert.match(flat(styles), /position: absolute;/);
  assert.match(flat(styles), /\.dblur::before \{ content: ""; position: absolute; inset: -40px; background-image: var\(--glass\);/);
  assert.match(flat(styles), /filter: blur\(34px\) saturate\(1\.3\);/);
  // The clipping box is the card's own size; a negative inset on it would widen the card's scroll.
  assert.match(flat(styles), /\.dblur \{ position: absolute; inset: 0; z-index: 0; overflow: hidden;/);
  assert.match(flat(styles), /pointer-events: none;/);
  assert.match(flat(styles), /z-index: 0;/);
  // Text sits above it: an opaque layer here would hide the title.
  assert.match(flat(search), /\.dhead, \.dscroll \{ position: relative; z-index: 1; \}/);
  // The card is the clipping box; a second rounding would leave blurred corners poking out.
  const card = flat(search.slice(search.indexOf("  .detail {"), search.indexOf("  .dblur {")));
  assert.match(card, /overflow: hidden;/);
  assert.match(card, /isolation: isolate;/);
});

test("a veil keeps the pane readable and reduced transparency removes the effect", () => {
  assert.match(flat(search), /\.dblur::after \{ content: ""; position: absolute; inset: 0;/);
  assert.match(flat(search), /color-mix\(in srgb, var\(--surface\) 58%, transparent\)/);
  assert.match(flat(search), /@media \(prefers-reduced-transparency: reduce\) \{ \.dblur \{ display: none; \} \}/);
});

test("the effect stays local to the expanded search card", () => {
  // Theme is user state; a blurred cover must not leak a variable that other views inherit.
  assert.doesNotMatch(flat(search), /--selected-cover[^:]*:/);
  assert.doesNotMatch(flat(search), /:root\s*\{[^}]*dblur/);
  assert.equal((search.match(/class="dblur"/g) ?? []).length, 1);
});
