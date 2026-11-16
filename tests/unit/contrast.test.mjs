/**
 * The quiet tier has to be noise, not a whisper you have to squint at.
 *
 * Measured on the built app, dark theme: `--text-3` was `#6f6f7e` — 3.90:1 on the page, 3.68:1 on a
 * surface, 3.46:1 on surface-2. Every quiet label in the app uses it (65 of them on one screen: the
 * row subtitles, the counts, the chevrons, the disclosure line), so a third of the interface was
 * under AA and the two screens a person reads most were the worst.
 *
 * `#85858f` measures 5.27 / 4.98 / 4.68:1 and is still an obvious tier below `--text-2`. This test
 * reads the values out of the stylesheet rather than repeating them, so lowering the tier again
 * fails here instead of quietly shipping.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const css = readFileSync(join(root, "src/app.css"), "utf8");

/** One selector's declarations, from `selector {` to its closing brace. */
function declarations(selector) {
  const at = css.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `${selector} is missing from app.css`);
  const end = css.indexOf("}", at);
  return css.slice(at, end);
}

function token(block, name) {
  const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
  assert.notEqual(m, null, `${name} is not a hex value`);
  return m[1];
}

const rgb = (hex) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const [r, g, b] = rgb(hex).map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** The surfaces the quiet tier is actually drawn on, per theme. */
const THEMES = [
  { name: "dark", block: ":root", palette: "dark" },
  { name: "oled", block: ':root[data-theme="oled"]', palette: "dark" },
  { name: "light", block: ':root[data-theme="light"]', palette: "light" },
];

test("the quiet tier clears AA on every surface it is drawn on", () => {
  const dark = declarations(":root");
  for (const theme of THEMES) {
    const own = theme.block === ":root" ? dark : declarations(theme.block);
    // A theme block may only restate the surfaces; the text tier comes from the palette it extends.
    const text = theme.palette === "dark" ? token(dark, "--text-3") : token(own, "--text-3");
    for (const surface of ["--bg", "--surface", "--surface-2"]) {
      const value = token(own, surface);
      const ratio = contrast(text, value);
      assert.ok(
        ratio >= 4.5,
        `${theme.name}: ${text} on ${surface} ${value} is ${ratio.toFixed(2)}:1, under AA (4.5)`,
      );
    }
  }
});

test("the tier stays quieter than the one above it", () => {
  // A contrast fix that promotes the quiet tier into the second tier is not a fix, it is a flattening.
  const dark = declarations(":root");
  assert.ok(luminance(token(dark, "--text-2")) > luminance(token(dark, "--text-3")), "text-2 must stay brighter");
  assert.ok(luminance(token(dark, "--text-3")) > luminance(token(dark, "--surface-2")), "text-3 must stay above the surface");
});
