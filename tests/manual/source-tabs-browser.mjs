// The listing chips on a source page.
//
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/source-tabs-browser.mjs
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const BASE = process.env.BASE ?? "http://127.0.0.1:5217";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const evidence = [];

const modeChips = () => page.locator(".modes button.chip[role='tab']");
const labels = async () => (await modeChips().allInnerTexts()).map((text) => text.trim());
const firstTitle = async () =>
  ((await page.locator(".set .tile .title").first().textContent()) ?? "").trim();
const firstArtTitle = async () =>
  ((await page.locator(".set .tile .art .over-title").first().textContent()) ?? "").trim();
// Whichever placement is on, the top-left tile carries this listing's tag in one of the two.
const listingTag = async () => (await firstTitle()) || (await firstArtTitle());

try {
  // A source that declares its own row: three listings, Trending first, and it is what loads.
  await page.goto(`${BASE}/tests/manual/source-tabs.html?source=tabs`);
  await page.waitForSelector(".set .tile");
  const declared = await labels();
  if (declared.join("|") !== "Trending|Popular|Latest") throw new Error(`declared row was "${declared.join("|")}"`);
  if ((await modeChips().first().getAttribute("aria-selected")) !== "true") throw new Error("Trending is not the listing that opens");
  const opened = await listingTag();
  if (!opened.startsWith("trending")) throw new Error(`the page opened on "${opened}", not the trending rows`);
  evidence.push({ check: "declared source opens on Trending, first chip", declared, opened });

  // Each chip loads its own listing rather than re-showing the first one.
  for (const [label, tag] of [["Popular", "popular"], ["Latest", "latest"], ["Trending", "trending"]]) {
    await page.getByRole("tab", { name: label, exact: true }).click();
    await page.waitForFunction(
      (t) => {
        const tile = document.querySelector(".set .tile");
        const text = `${tile?.querySelector(".meta .title")?.textContent ?? ""}${tile?.querySelector(".art .over-title")?.textContent ?? ""}`.trim();
        return text.startsWith(t);
      },
      tag,
      { timeout: 4000 },
    );
    const title = await listingTag();
    if (!title.startsWith(tag)) throw new Error(`${label} showed "${title}"`);
    if ((await page.getByRole("tab", { name: label, exact: true }).getAttribute("aria-selected")) !== "true") throw new Error(`${label} chip does not read selected`);
  }
  evidence.push({ check: "every chip loads its own listing and reads selected" });

  // A source that declares nothing keeps exactly the pair every source shipped with.
  await page.goto(`${BASE}/tests/manual/source-tabs.html?source=plain`);
  await page.waitForSelector(".set .tile");
  const plain = await labels();
  if (plain.join("|") !== "Popular|Latest") throw new Error(`undeclared row was "${plain.join("|")}"`);
  if ((await modeChips().first().getAttribute("aria-selected")) !== "true") throw new Error("Popular is not the default for an undeclared source");
  evidence.push({ check: "undeclared source keeps Popular/Latest", plain });

  if (errors.length > 0) throw new Error(`page errors: ${errors.join(" | ")}`);
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
} finally {
  await browser.close();
}
