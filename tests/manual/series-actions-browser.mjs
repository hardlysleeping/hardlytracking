// Synthetic memory fixture, no owner data. Proves the series action sheet at two phone widths:
// every action still reachable, the categories overlay in list and grid, the off state quieter than
// the on state, the covers not squished, and — the point — that filing a category persists.
//
// Start this worktree's Vite on a free port (npx vite --port 5311 --strictPort), then:
//   PLAYWRIGHT_MODULE=/home/bazzite/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs \
//     BASE=http://localhost:5311 node tests/manual/series-actions-browser.mjs
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const BASE = process.env.BASE ?? "http://localhost:5311";
const browser = await chromium.launch({ headless: true });
const out = new URL("../../data/series-actions-qa/", import.meta.url);
await mkdir(out, { recursive: true });
const evidence = [];
const errors = [];


async function run(width, height) {
  const page = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  page.on("pageerror", (error) => errors.push(`${width}x${height}: ${error.message}`));
  page.on("console", (message) => { if (message.type() === "error") errors.push(`${width}x${height}: ${message.text()}`); });
  await page.route("**/*", (route) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());

  await page.goto(`${BASE}/tests/manual/series-actions-fixture.html`);
  await page.waitForFunction(() => window.seriesActionsFixture !== undefined);
  await page.waitForSelector("[data-series-id]");
  await page.waitForTimeout(400);

  // ---- 1. The content width the covers live in ------------------------------------------------
  const measure = () => page.evaluate(() => {
    const view = document.querySelector(".view");
    const set = document.querySelector(".set");
    const art = document.querySelector(".tile .art .cover") ?? document.querySelector(".tile .art");
    const cols = getComputedStyle(set).gridTemplateColumns.split(" ").filter(Boolean);
    return {
      contentWidth: Math.round(view.getBoundingClientRect().width - 2 * parseFloat(getComputedStyle(view).paddingLeft)),
      viewWidth: Math.round(view.getBoundingClientRect().width),
      setWidth: Math.round(set.getBoundingClientRect().width),
      coverWidth: Math.round(art.getBoundingClientRect().width),
      columns: cols.length,
    };
  });
  const after = await measure();
  // The same DOM with the shell's old 16px gutter re-applied: what the covers got before this change.
  const oldGutter = await page.addStyleTag({
    // `:root body` only to out-specify the component's own scoped rule; this is the gutter the shell
    // applied before the change (--pad-x's 16px default), replayed on the same DOM.
    content: `:root body .view { padding-left: 16px !important; padding-right: 16px !important; }
              :root body .view > .pin { margin-left: -16px !important; margin-right: -16px !important; padding-left: 16px !important; padding-right: 16px !important; }`,
  });
  const before = await measure();
  await oldGutter.evaluate((element) => element.remove());
  assert.ok(before.contentWidth < after.contentWidth, `${width}: the gutter change did not widen the content (${before.contentWidth} -> ${after.contentWidth})`);
  evidence.push({ at: `${width}x${height}`, content: { before: before.contentWidth, after: after.contentWidth, columnsBefore: before.columns, columnsAfter: after.columns, coverBefore: before.coverWidth, coverAfter: after.coverWidth } });
  await page.screenshot({ path: new URL(`grid-${width}x${height}.png`, out).pathname });

  // ---- 2. Open the sheet the way the app opens it: a long press on a tile --------------------
  const longPress = async (id) => {
    await page.evaluate((seriesId) => {
      const tile = document.querySelector(`[data-series-id="${seriesId}"]`);
      const box = tile.getBoundingClientRect();
      tile.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2, pointerType: "touch", isPrimary: true }));
      return new Promise((resolve) => setTimeout(resolve, 540));
    }, id);
    await page.evaluate((seriesId) => {
      document.querySelector(`[data-series-id="${seriesId}"]`).dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
    }, id);
  };
  await longPress("local:new");
  const sheet = page.getByRole("dialog", { name: "Not In Library Yet" });
  await sheet.waitFor();

  // ---- 3. All four actions are reachable, in one row ----------------------------------------
  const read = sheet.getByRole("button", { name: /^Read/ });
  const add = sheet.getByRole("button", { name: /Add to library|In library/ });
  const download = sheet.getByRole("button", { name: /^Download — / });
  const cats = sheet.getByRole("button", { name: /^Categories — / });
  for (const [label, locator] of [["Read", read], ["Add to library", add], ["Download", download], ["Categories", cats]]) {
    assert.equal(await locator.count(), 1, `${width}: ${label} is not reachable in the sheet`);
  }
  const quick = await page.evaluate(() => {
    const row = document.querySelector('[role="dialog"] .quick');
    const add = row.querySelector(".act").getBoundingClientRect();
    const buttons = [...row.querySelectorAll(".iconbtn")].map((b) => Math.round(b.getBoundingClientRect().width));
    const cover = document.querySelector('[role="dialog"] .thumb .cover').getBoundingClientRect();
    const thumb = document.querySelector('[role="dialog"] .thumb').getBoundingClientRect();
    return {
      row: Math.round(row.getBoundingClientRect().width),
      add: Math.round(add.width),
      icons: buttons,
      gap: Math.round(buttons.length ? row.querySelectorAll(".iconbtn")[0].getBoundingClientRect().left - add.right : 0),
      cover: Math.round(cover.width),
      thumb: Math.round(thumb.width),
      coveredByCover: Math.round((cover.width / thumb.width) * 100),
    };
  });
  assert.ok(quick.add > quick.icons[0] * 2, `${width}: Add to library did not keep the width of the row`);
  assert.equal(quick.icons.length, 2, `${width}: Download and Categories are not side by side`);
  assert.ok(quick.coveredByCover >= 99, `${width}: the header cover does not fill its box (${quick.coveredByCover}%)`);
  // The same header with the old stacked layout's artwork: a 56px box holding a 42px row cover.
  const oldThumb = await page.addStyleTag({
    content: `:root body [role="dialog"] .thumb { width: 56px !important; flex-basis: 56px !important; }
              :root body [role="dialog"] .thumb .cover { width: 42px !important; }`,
  });
  const thumbBefore = await page.evaluate(() => Math.round(document.querySelector('[role="dialog"] .thumb .cover').getBoundingClientRect().width));
  await oldThumb.evaluate((element) => element.remove());
  assert.ok(quick.cover > thumbBefore, `${width}: the header artwork did not take the reclaimed width (${thumbBefore} -> ${quick.cover})`);
  evidence.push({ at: `${width}x${height}`, quickRow: { ...quick, headerCoverBefore: thumbBefore } });
  await sheet.screenshot({ path: new URL(`actions-${width}x${height}.png`, out).pathname });

  // ---- 4. The categories overlay: the same information in both modes -------------------------
  await cats.click();
  const picker = page.getByRole("dialog", { name: "Categories" });
  await picker.waitFor();
  const listInfo = await page.evaluate(() => {
    const picker = document.querySelector('[role="dialog"] .picker');
    const rows = [...picker.querySelectorAll(".row")];
    return {
      mode: picker.className,
      rows: rows.length,
      names: rows.map((r) => r.querySelector(".label").textContent.trim()),
      counts: rows.map((r) => r.querySelector(".count").textContent.trim()),
      tickOpacity: getComputedStyle(rows[0].querySelector(".check svg")).opacity,
    };
  });
  assert.equal(listInfo.names[0], "Uncategorized", `${width}: Uncategorized is not the first row`);
  assert.equal(listInfo.rows, 9, `${width}: the overlay lost a shelf (${listInfo.rows} rows)`);
  assert.ok(listInfo.counts.every((count) => /^\d+$/.test(count)), `${width}: a row lost its whole-library count`);

  // Contrast of an off row against an on row, from the computed colours the browser actually paints.
  const contrast = await page.evaluate(() => {
    // Both shapes the browser hands back: rgb()/rgba() and colour-mix's color(srgb r g b / a).
    const parse = (color) => {
      const rgb = color.match(/rgba?\(([^)]+)\)/);
      if (rgb) {
        const parts = rgb[1].split(/[,/ ]+/).filter(Boolean).map(Number);
        return { r: parts[0], g: parts[1], b: parts[2], a: parts.length > 3 ? parts[3] : 1 };
      }
      const srgb = color.match(/color\(srgb ([^)]+)\)/);
      if (srgb) {
        const parts = srgb[1].split(/[/ ]+/).filter(Boolean).map(Number);
        return { r: parts[0] * 255, g: parts[1] * 255, b: parts[2] * 255, a: parts.length > 3 ? parts[3] : 1 };
      }
      return null;
    };
    const over = (top, bottom) => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const backdrop = (element) => {
      let node = element;
      const layers = [];
      while (node) {
        const bg = parse(getComputedStyle(node).backgroundColor);
        if (bg && bg.a > 0) {
          layers.push(bg);
          if (bg.a === 1) break;
        }
        node = node.parentElement;
      }
      let color = { r: 0, g: 0, b: 0, a: 1 };
      for (const layer of layers.reverse()) color = over(layer, color);
      return color;
    };
    const lum = (color) => {
      const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
      return 0.2126 * f(color.r) + 0.7152 * f(color.g) + 0.0722 * f(color.b);
    };
    const ratio = (fg, bg) => {
      const a = lum(fg), b = lum(bg);
      return Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100;
    };
    const rows = [...document.querySelectorAll('[role="dialog"] .picker .row')];
    const readColor = (row) => {
      const label = row.querySelector(".label");
      const fg = parse(getComputedStyle(label).color);
      const bg = backdrop(label);
      return {
        text: getComputedStyle(label).color,
        background: `rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`,
        ratio: ratio(fg, bg),
        tick: getComputedStyle(row.querySelector(".check svg")).opacity,
        border: getComputedStyle(row).borderTopColor,
      };
    };
    return { off: readColor(rows.find((row) => !row.classList.contains("on"))), on: readColor(rows.find((row) => row.classList.contains("on"))) };
  });
  assert.ok(contrast.on.ratio > contrast.off.ratio + 1, `${width}: on and off read the same (${contrast.off.ratio} vs ${contrast.on.ratio})`);
  assert.ok(contrast.off.ratio >= 3, `${width}: the off row is too faint to read (${contrast.off.ratio})`);
  assert.equal(contrast.off.tick, "0", `${width}: an untoggled row draws a tick`);
  assert.equal(contrast.on.tick, "1", `${width}: a toggled row does not draw its tick`);
  evidence.push({ at: `${width}x${height}`, categoriesList: listInfo, contrast });
  await picker.screenshot({ path: new URL(`categories-list-${width}x${height}.png`, out).pathname });

  await picker.getByRole("button", { name: "Grid view" }).click();
  const gridInfo = await page.evaluate(() => {
    const picker = document.querySelector('[role="dialog"] .picker');
    const rows = [...picker.querySelectorAll(".row")];
    const cols = getComputedStyle(picker).gridTemplateColumns.split(" ").filter(Boolean);
    return {
      mode: picker.className,
      display: getComputedStyle(picker).display,
      columns: cols.length,
      rows: rows.length,
      names: rows.map((r) => r.querySelector(".label").textContent.trim()),
      counts: rows.map((r) => r.querySelector(".count").textContent.trim()),
    };
  });
  assert.match(gridInfo.mode, /grid/, `${width}: the grid toggle did not switch the picker`);
  assert.equal(gridInfo.display, "grid");
  assert.ok(gridInfo.columns >= 2, `${width}: the grid is one column (${gridInfo.columns})`);
  assert.deepEqual(gridInfo.names, listInfo.names, `${width}: list and grid do not show the same shelves`);
  assert.deepEqual(gridInfo.counts, listInfo.counts, `${width}: list and grid do not show the same counts`);
  evidence.push({ at: `${width}x${height}`, categoriesGrid: gridInfo });
  await picker.screenshot({ path: new URL(`categories-grid-${width}x${height}.png`, out).pathname });

  // ---- 5. Filing: the toggle must actually put the title in the shelf ------------------------
  const catId = await page.evaluate(() => window.seriesActionsFixture.categories.items.find((c) => c.name === "Shelf B").id);
  await picker.getByRole("button", { name: /Shelf B/ }).click();
  await page.waitForTimeout(400);
  const filed = await page.evaluate(async () => {
    const f = window.seriesActionsFixture;
    const row = await f.store.getSeries("local:new");
    const shelf = f.categories.items.find((c) => c.name === "Shelf B");
    return {
      stored: row?.categoryIds ?? null,
      inState: f.library.library.find((r) => r.id === "local:new")?.categoryIds ?? null,
      shelfList: (await f.store.seriesInCategory(shelf.id)).map((r) => r.id),
      saved: row !== undefined,
      notice: document.querySelector('[role="dialog"] .notice')?.textContent ?? "",
      pressed: [...document.querySelectorAll('[role="dialog"] .picker .row')].filter((r) => r.getAttribute("aria-pressed") === "true").map((r) => r.querySelector(".label").textContent.trim()),
    };
  });
  assert.deepEqual(filed.stored, [catId], `${width}: the shelf was not written to the store (${JSON.stringify(filed.stored)})`);
  assert.deepEqual(filed.inState, [catId], `${width}: the library state did not follow the store`);
  assert.deepEqual(filed.shelfList, ["local:new"], `${width}: the shelf does not list the title`);
  assert.equal(filed.saved, true, `${width}: filing a new title did not add it to the library`);
  assert.match(filed.notice, /Filed under Shelf B/, `${width}: no notice after filing (${filed.notice})`);
  assert.deepEqual(filed.pressed, ["Shelf B"], `${width}: the overlay does not show the shelf as on`);
  evidence.push({ at: `${width}x${height}`, filed });

  // …and the same write survives a fresh read of the same database (a relaunch).
  const relaunch = await page.evaluate(async () => {
    const f = window.seriesActionsFixture;
    const rows = await f.store.listSeries();
    return rows.find((r) => r.id === "local:new")?.categoryIds ?? null;
  });
  assert.deepEqual(relaunch, [catId], `${width}: the assignment did not survive a re-read`);

  // Toggling it off returns the title to Uncategorized while keeping it in the library.
  await picker.getByRole("button", { name: /Shelf B/ }).click();
  await page.waitForTimeout(400);
  const unfiled = await page.evaluate(async () => {
    const f = window.seriesActionsFixture;
    const row = await f.store.getSeries("local:new");
    const shelf = f.categories.items.find((c) => c.name === "Shelf B");
    return {
      stored: row?.categoryIds ?? null,
      inLibrary: f.library.library.some((r) => r.id === "local:new"),
      shelfList: (await f.store.seriesInCategory(shelf.id)).map((r) => r.id),
      uncategorized: document.querySelector('[role="dialog"] .picker .row .label')?.textContent.trim(),
      uncategorizedOn: document.querySelector('[role="dialog"] .picker .row')?.classList.contains("on"),
      notice: document.querySelector('[role="dialog"] .notice')?.textContent ?? "",
    };
  });
  assert.deepEqual(unfiled.stored, [], `${width}: unfiling left the id behind (${JSON.stringify(unfiled.stored)})`);
  assert.equal(unfiled.inLibrary, true, `${width}: unfiling removed the title from the library`);
  assert.deepEqual(unfiled.shelfList, [], `${width}: the shelf still lists the title`);
  assert.equal(unfiled.uncategorizedOn, true, `${width}: Uncategorized is not ticked after unfiling`);
  assert.match(unfiled.notice, /Uncategorized/, `${width}: no notice after unfiling (${unfiled.notice})`);
  evidence.push({ at: `${width}x${height}`, unfiled });

  // ---- 6. Filing an already-saved title must not move it in the library ----------------------
  await picker.getByRole("button", { name: "Done" }).click();
  // The library's order right now, with `local:new` legitimately at the front (it was just added).
  const orderBefore = await page.evaluate(() => window.seriesActionsFixture.library.library.map((r) => r.id));
  await longPress("local:3");
  const savedSheet = page.getByRole("dialog", { name: "Fixture Three" });
  await savedSheet.waitFor();
  await savedSheet.getByRole("button", { name: /^Categories — / }).click();
  const savedPicker = page.getByRole("dialog", { name: "Categories" });
  await savedPicker.getByRole("button", { name: /Shelf D/ }).click();
  await page.waitForTimeout(400);
  const orderAfter = await page.evaluate(() => window.seriesActionsFixture.library.library.map((r) => r.id));
  const savedFiling = await page.evaluate(async () => {
    const f = window.seriesActionsFixture;
    const shelf = f.categories.items.find((c) => c.name === "Shelf D");
    return {
      stored: (await f.store.getSeries("local:3"))?.categoryIds ?? null,
      shelfList: (await f.store.seriesInCategory(shelf.id)).map((r) => r.id),
      order: (await f.store.listSeries()).map((r) => r.id),
    };
  });
  assert.deepEqual(orderAfter, orderBefore, `${width}: filing reordered the library (${orderBefore} -> ${orderAfter})`);
  assert.equal(orderAfter.indexOf("local:3"), orderBefore.indexOf("local:3"), `${width}: the filed title moved in the library`);
  assert.deepEqual(savedFiling.shelfList, ["local:3"], `${width}: the existing title was not filed`);
  evidence.push({ at: `${width}x${height}`, savedFiling, orderBefore, orderAfter });

  await page.screenshot({ path: new URL(`filed-${width}x${height}.png`, out).pathname });

  await page.evaluate(() => {
    const close = [...document.querySelectorAll("[role=dialog] button")].find((b) => b.textContent.trim() === "Done" || b.getAttribute("aria-label") === "Close");
    close?.click();
  });
  await page.waitForTimeout(300);

  // ---- 7. Nothing was dropped: Add to library and Download still do their jobs ---------------
  await longPress("local:new2");
  const addSheet = page.getByRole("dialog", { name: "Also Not In Library" });
  await addSheet.waitFor();
  await addSheet.getByRole("button", { name: "Download — For offline reading" }).click();
  await page.waitForTimeout(300);
  const downloadNotice = await page.evaluate(() => document.querySelector('[role="dialog"] .notice')?.textContent ?? "");
  const queuedCalls = await page.evaluate(() => window.seriesActionsFixture.queuedCalls.slice());
  assert.match(downloadNotice, /Queued 4 chapters/, `${width}: the Download icon lost its count (${downloadNotice})`);
  assert.deepEqual(queuedCalls, [{ seriesId: "local:new2", count: 4 }], `${width}: Download did not queue this title's chapters`);

  await addSheet.locator(".quick .act").click();
  await page.waitForTimeout(400);
  const added = await page.evaluate(async () => {
    const f = window.seriesActionsFixture;
    const row = await f.store.getSeries("local:new2");
    return {
      saved: row !== undefined,
      categories: row?.categoryIds ?? null,
      notice: document.querySelector('[role="dialog"] .notice')?.textContent ?? "",
      button: document.querySelector('[role="dialog"] .quick .act strong')?.textContent ?? "",
      uncategorized: document.querySelector('[role="dialog"] [aria-label^="Categories"]')?.getAttribute("aria-label") ?? "",
    };
  });
  assert.equal(added.saved, true, `${width}: Add to library did not save the title`);
  assert.deepEqual(added.categories, [], `${width}: a new title was filed somewhere unasked`);
  assert.match(added.notice, /Added to your library · Uncategorized/, `${width}: no notice after adding (${added.notice})`);
  assert.equal(added.button, "In library", `${width}: the add button did not report the new state`);
  assert.match(added.uncategorized, /Categories — Uncategorized/, `${width}: the categories button does not name the filed state`);
  evidence.push({ at: `${width}x${height}`, addAndDownload: { downloadNotice, queuedCalls, ...added } });
  await page.evaluate(() => [...document.querySelectorAll("[role=dialog] button")].find((b) => b.getAttribute("aria-label") === "Close")?.click());
  await page.waitForTimeout(300);

  // ---- 8. The series panel inside the grid: issue rows are the width of the column ----------
  await page.evaluate(() => document.querySelector('[data-series-id="local:1"]').click());
  await page.waitForSelector(".issue-panel .row", { timeout: 5000 });
  const panel = await page.evaluate(() => {
    const box = document.querySelector(".issue-panel");
    const row = box.querySelector(".row");
    const list = box.querySelector(".list");
    const hero = box.querySelector(".hero .cover");
    const pair = box.querySelector(".pair");
    const bits = (element) => Math.round(element.getBoundingClientRect().width);
    return {
      panel: Math.round(box.getBoundingClientRect().width),
      row: bits(row),
      rowLeft: Math.round(row.getBoundingClientRect().left),
      panelLeft: Math.round(box.getBoundingClientRect().left),
      panelPadding: parseFloat(getComputedStyle(box).paddingLeft),
      viewPadding: parseFloat(getComputedStyle(box.querySelector(".view")).paddingLeft),
      rowIndent: Math.round(row.getBoundingClientRect().left - (box.getBoundingClientRect().left + parseFloat(getComputedStyle(box).paddingLeft) + parseFloat(getComputedStyle(box.querySelector(".view")).paddingLeft))),
      list: bits(list),
      hero: bits(hero),
      pairButtons: [...pair.querySelectorAll(".btn")].map(bits),
    };
  });
  assert.ok(panel.rowIndent <= 1, `${width}: the issue rows are still indented (${panel.rowIndent}px)`);
  assert.ok(panel.row >= panel.list - 1, `${width}: an issue row is narrower than its list (${panel.row} vs ${panel.list})`);
  assert.ok(panel.hero >= (width >= 440 ? 129 : 128), `${width}: the hero artwork did not take the column's width (${panel.hero}px)`);
  assert.ok(panel.pairButtons.every((width) => width < panel.list), `${width}: the action pair still stretches the column (${panel.pairButtons})`);
  evidence.push({ at: `${width}x${height}`, issuePanel: panel });
  await page.screenshot({ path: new URL(`panel-${width}x${height}.png`, out).pathname });

  await page.close();
}

await run(390, 844);
await run(440, 956);

assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
console.log(JSON.stringify({ ok: true, evidence }, null, 2));
await browser.close();