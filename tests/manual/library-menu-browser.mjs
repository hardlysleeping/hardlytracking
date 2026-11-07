// Synthetic memory fixture, no owner data. Start this worktree's Vite, then:
//   PLAYWRIGHT_MODULE=/home/bazzite/.npm/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs \
//     node tests/manual/library-menu-browser.mjs
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");

const BASE = process.env.BASE ?? "http://localhost:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await page.route("**/*", (route) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
const evidence = [];
const out = new URL("../../data/library-menu-qa/", import.meta.url);
await mkdir(out, { recursive: true });

const tools = page.locator(".tools");
const dialog = (name) => page.getByRole("dialog", { name, exact: true });

await page.goto(`${BASE}/tests/manual/library-menu-fixture.html`);
await page.waitForFunction(() => window.libraryMenuFixture !== undefined);
await page.waitForSelector(".tools");
await page.waitForFunction(() => document.querySelectorAll(".continue .cont").length === 3);

// 1. The tools row is exactly the three shelf controls; no local-file door survives there.
const toolLabels = await tools.locator("button").allInnerTexts();
assert.deepEqual(toolLabels.map((text) => text.replace(/\s+/g, " ").trim()), ["Filter", "Sort · Title", "Display"]);
for (const gone of ["Add files", "Add folder", "From Drive"]) assert.ok(!toolLabels.join(" ").includes(gone), `${gone} still in the tools row`);
evidence.push({ check: "tools row holds only Filter, Sort, Display", toolLabels });

// 2. The ⋯ sheet carries them as one labelled group at the top.
await page.getByRole("button", { name: "More library actions" }).click();
const sheet = dialog("Library");
await sheet.waitFor();
assert.equal(await sheet.getByRole("heading", { name: "Your files" }).count(), 1);
const fileGroup = await sheet.locator(".group .menu-item").allInnerTexts();
assert.deepEqual(fileGroup.map((text) => text.trim()), ["Add files…", "Add folder…", "From drive…"]);
assert.equal(await sheet.locator(".group").first().locator("xpath=preceding-sibling::*").count(), 0, "the file group is the first block");
evidence.push({ check: "⋯ sheet top group", fileGroup });

// 3. Add files… closes the sheet, then opens the picker (same gesture).
const chooser = page.waitForEvent("filechooser");
await sheet.getByRole("button", { name: "Add files…" }).click();
const filesChooser = await chooser;
assert.equal(await sheet.count(), 0, "the sheet closed before the picker");
await filesChooser.setFiles([]);
evidence.push({ check: "Add files… closes sheet then opens file picker" });

// 4. Add folder… opens the directory input the component already had.
const emptyDir = await mkdtemp(join(tmpdir(), "ht-folder-"));
await page.getByRole("button", { name: "More library actions" }).click();
const folderPick = page.waitForEvent("filechooser");
await dialog("Library").getByRole("button", { name: "Add folder…" }).click();
const folderChooser = await folderPick;
assert.equal(await dialog("Library").count(), 0);
assert.equal(await folderChooser.element().getAttribute("webkitdirectory"), "", "the folder picker is the webkitdirectory input");
await folderChooser.setFiles(emptyDir);
await page.waitForTimeout(100);
evidence.push({ check: "Add folder… closes sheet then opens the folder picker" });

// 5. From drive… still reaches the same DriveImport sheet.
await page.getByRole("button", { name: "More library actions" }).click();
await dialog("Library").getByRole("button", { name: "From drive…" }).click();
await dialog("From Google Drive").waitFor();
assert.equal(await dialog("Library").count(), 0);
await dialog("From Google Drive").getByRole("button", { name: "Close" }).click();
evidence.push({ check: "From drive… opens DriveImport and closes the menu" });

// 6. The Continue header folds the covers, keeps the count, and writes the pref.
const fold = page.getByRole("button", { name: /Collapse Continue reading, 3 series/ });
assert.equal(await fold.getAttribute("aria-expanded"), "true");
assert.equal(await page.locator(".continue .strip .cont").count(), 3);
assert.equal(await page.locator(".continue .head .n").innerText(), "3");
await fold.click();
const expand = page.getByRole("button", { name: /Expand Continue reading, 3 series/ });
assert.equal(await expand.getAttribute("aria-expanded"), "false");
assert.equal(await page.locator(".continue .strip").count(), 0);
assert.equal(await page.evaluate(async () => (await window.libraryMenuFixture.store.getPref("settings.continueCollapsed"))), true);
await page.screenshot({ path: new URL("continue-collapsed-above.png", out).pathname });

// 7. "Relaunch" re-reads every pref from the store: the fold is still there.
await page.evaluate(() => window.libraryMenuFixture.reload());
await page.waitForTimeout(100);
assert.equal(await page.getByRole("button", { name: /Expand Continue reading, 3 series/ }).getAttribute("aria-expanded"), "false");
evidence.push({ check: "collapse persisted through settings.load(store)" });

// 8. Collapsed leaves no strip-sized gap in either position: section is header height only.
const gap = async (position) => {
  await page.evaluate((position) => {
    window.libraryMenuFixture.settings.set("continuePosition", position);
    window.libraryMenuFixture.settings.set("continueCollapsed", true);
  }, position);
  await page.waitForTimeout(120);
  const box = await page.evaluate(() => {
    const section = document.querySelector(".continue");
    const head = section.querySelector(".head");
    const style = getComputedStyle(section);
    const rect = section.getBoundingClientRect();
    return {
      sectionHeight: Math.round(rect.height),
      headHeight: Math.round(head.getBoundingClientRect().height),
      marginBottom: style.marginBottom,
      strip: section.querySelectorAll(".strip").length,
    };
  });
  assert.equal(box.strip, 0);
  assert.ok(Math.abs(box.sectionHeight - box.headHeight) <= 1, `collapsed ${position} section is header-height (${box.sectionHeight} vs ${box.headHeight})`);
  assert.notEqual(box.marginBottom, "24px", "the old s5 block margin is not reserved");
  return box;
};
const above = await gap("above");
const below = await gap("below");
evidence.push({ check: "collapsed strip leaves no gap above or below", above, below });

// 9. Wide layout: same single home — the ⋯ sheet, never a second row.
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(250);
assert.deepEqual((await tools.locator("button").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()), ["Filter", "Sort · Title", "Display"]);
assert.equal(await page.getByRole("button", { name: "Add files", exact: true }).count(), 0);
assert.equal(await page.getByRole("button", { name: "From Drive", exact: true }).count(), 0);
await page.getByRole("button", { name: "More library actions" }).click();
await dialog("Library").waitFor();
assert.equal(await dialog("Library").getByRole("button", { name: "Add files…" }).count(), 1);
await dialog("Library").getByRole("button", { name: "Close" }).click();
evidence.push({ check: "wide layout has no second copy of the file actions" });

// 10. Reopen the fold and put the strip back for the owner's next use.
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.libraryMenuFixture.settings.set("continueCollapsed", false));
await page.waitForTimeout(100);
assert.equal(await page.getByRole("button", { name: /Collapse Continue reading, 3 series/ }).getAttribute("aria-expanded"), "true");
await page.screenshot({ path: new URL("continue-expanded.png", out).pathname });

assert.deepEqual(errors, [], `page errors: ${errors.join(" | ")}`);
console.log(JSON.stringify({ pass: true, evidence }, null, 2));
await rm(emptyDir, { recursive: true, force: true });
await browser.close();
