import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_COVER,
  BADGE_OPTIONS,
  DEFAULT_BADGES,
  DENSITIES,
  DENSITY_OPTIONS,
  badgesFor,
  categoryNavPlan,
  chipCapacity,
  clamp,
  collectionBar,
  columns,
  coverWidth,
  defaultDensity,
  defaultSort,
  deviceClass,
  libraryLayout,
  railWidth,
  readerProfile,
  selectAllLabel,
  sidebarWidth,
  tileMeta,
} from "../../src/lib/layout-modes.ts";

test("device classes: phone, tablet, desktop at the plan's boundaries", () => {
  assert.equal(deviceClass(390), "phone");
  // A phone on its side is still a phone: 844×390 used to be handed the tablet rail, whose labels did
  // not fit the width it left, inside a viewport 390 px tall.
  assert.equal(deviceClass(844, 390), "phone");
  assert.equal(deviceClass(667, 375), "phone");
  // …and a short desktop window is still a desktop, which a shortest-side rule would have broken.
  assert.equal(deviceClass(1280, 900), "desktop");
  assert.equal(deviceClass(1600, 700), "desktop");
  assert.equal(deviceClass(1024, 768), "tablet");
  assert.equal(deviceClass(599), "phone");
  assert.equal(deviceClass(600), "tablet");
  assert.equal(deviceClass(1180), "tablet"); // iPad landscape is not a desktop
  assert.equal(deviceClass(1279), "tablet");
  assert.equal(deviceClass(1280), "desktop");
});

test("chrome: a tablet keeps a rail, a desktop a sidebar, a phone neither", () => {
  assert.equal(railWidth("phone"), 0);
  assert.equal(railWidth("tablet"), 76);
  assert.equal(railWidth("desktop"), 76, "the nav column does not widen with the window");
});

test("a phone is one pane, large covers, resume in the menu", () => {
  const layout = libraryLayout(390, 844, { collectionCount: 3 });
  assert.equal(layout.mode, "single");
  assert.equal(layout.detailWidth, 0);
  assert.equal(layout.density, "large");
  assert.equal(layout.resume, "menu");
  assert.equal(layout.categoryNav.mode, "tabs");
});

test("a tablet portrait is one pane with a category bar, and no split", () => {
  const layout = libraryLayout(768, 1024, { collectionCount: 4 });
  assert.equal(layout.mode, "single");
  assert.equal(layout.categoryNav.mode, "tabs");
  assert.equal(layout.density, "comfortable");
  assert.equal(layout.resume, "always");
});

test("a tablet landscape splits by default, with a detail pane and a sidebar", () => {
  const layout = libraryLayout(1180, 820, { collectionCount: 6 });
  assert.equal(layout.mode, "split");
  assert.equal(layout.categoryNav.mode, "sidebar");
  assert.ok(layout.detailWidth >= 340);
  assert.ok(layout.gridWidth > 0);
  assert.equal(layout.selectionBar, "pinned");
});

test("a short window splits in landscape but not in portrait", () => {
  // Sideways: short and wide — two panes side by side is the shape that fits.
  assert.equal(libraryLayout(1180, 520, { collectionCount: 6 }).mode, "split");
  // The same phone upright has no width to give a second pane, so it stays one.
  assert.equal(libraryLayout(520, 1180, { collectionCount: 6 }).mode, "single");
});

test("one pane resolver governs automatic and explicit Library choices", () => {
  assert.equal(libraryLayout(800, 900, { collectionCount: 3, pane: "auto" }).mode, "single");
  assert.equal(libraryLayout(900, 900, { collectionCount: 3, nav: "tabs", pane: "auto" }).mode, "split");
  assert.equal(libraryLayout(900, 900, { collectionCount: 3, nav: "tabs", pane: "split" }).mode, "split");
  assert.equal(libraryLayout(900, 900, { collectionCount: 3, nav: "tabs", pane: "single" }).mode, "single");
});

test("a desktop gets a split, a remembered ratio and hover affordances", () => {
  const layout = libraryLayout(1440, 900, { collectionCount: 6, splitRatio: 0.6 });
  assert.equal(layout.mode, "split");
  assert.equal(layout.splitRatio, 0.6);
  assert.equal(layout.resume, "hover");
  assert.equal(layout.density, "comfortable");
});

test("a dragged ratio is clamped so neither pane becomes unusable", () => {
  const narrowest = libraryLayout(1440, 900, { splitRatio: 0.1 });
  assert.ok(narrowest.gridWidth <= 420, "the shelf may be dragged down to its own floor");
  assert.equal(narrowest.detailWidth, 1440 - 76 - 32 - narrowest.gridWidth - (narrowest.sidebarWidth ?? 0));
  const widest = libraryLayout(1440, 900, { splitRatio: 0.95 });
  assert.ok(widest.detailWidth >= 340, "the detail keeps its floor");
});

test("both panes follow the window: the split keeps its share", () => {
  const wide = libraryLayout(1600, 900, { collectionCount: 6, splitRatio: 0.6 });
  const narrow = libraryLayout(1200, 900, { collectionCount: 6, splitRatio: 0.6 });
  assert.ok(narrow.gridWidth < wide.gridWidth, "the shelf shrinks with the window");
  assert.ok(narrow.detailWidth < wide.detailWidth, "and so does the detail");
});

test("three panes: shelf, series and a reading column that keeps its floor", () => {
  const wide = libraryLayout(1680, 900, { collectionCount: 6, pane: "three", minGridWidth: 200 });
  assert.equal(wide.mode, "split");
  assert.ok(wide.thirdWidth >= 420, "the reader keeps its floor");
  assert.ok(wide.detailWidth >= 340, "the series keeps its floor");
  assert.ok(wide.gridWidth >= 200, "the shelf keeps the minimum the reader set");
  // A window that cannot hold all three keeps two panes rather than drawing a sliver of pages.
  const narrow = libraryLayout(1200, 900, { collectionCount: 6, pane: "three", minGridWidth: 200 });
  assert.equal(narrow.thirdWidth, 0);
  assert.equal(narrow.mode, "split");
});

test("category navigation: tabs when everything fits", () => {
  const plan = categoryNavPlan(800, "tabs", 4);
  assert.deepEqual(plan, { mode: "tabs", visible: 4, overflow: 0, pinned: 0 });
});

test("category navigation: overflow past capacity, never a 30-item scroller", () => {
  const capacity = chipCapacity(800);
  const plan = categoryNavPlan(800, "tabs", 30);
  assert.equal(plan.mode, "overflow");
  assert.equal(plan.visible, capacity);
  assert.equal(plan.overflow, 30 - capacity);
});

test("category navigation: pinned collections stay visible when the rest overflow", () => {
  const capacity = chipCapacity(800);
  const plan = categoryNavPlan(800, "tabs", 30, 3);
  assert.equal(plan.mode, "overflow");
  assert.equal(plan.pinned, 3);
  assert.ok(plan.visible >= Math.min(3, capacity));
});

test("category navigation: automatic picks a sidebar only when the grid keeps its minimum", () => {
  assert.equal(categoryNavPlan(1072, "automatic", 6).mode, "sidebar");
  assert.equal(categoryNavPlan(692, "automatic", 6).mode, "tabs");
  // a forced sidebar on a narrow screen falls back rather than crushing the grid
  assert.notEqual(categoryNavPlan(600, "sidebar", 6).mode, "sidebar");
});

test("category navigation: a sidebar is never drawn at phone width", () => {
  const layout = libraryLayout(390, 844, { nav: "sidebar", collectionCount: 6 });
  assert.notEqual(layout.categoryNav.mode, "sidebar");
  assert.equal(layout.sidebarWidth, 0);
});

test("a sidebar keeps one width, whatever the window", () => {
  // Chrome does not grow because the window did: a list of categories is a list at every size.
  assert.equal(sidebarWidth(), 200);
});

test("columns follow from the available width, and never go below two or above eight", () => {
  assert.equal(columns(358, 148), 2); // phone, large covers
  assert.equal(columns(358, 88), 3); // phone, compact
  assert.equal(columns(700, 112), 5);
  assert.equal(columns(2000, 88), 8);
  assert.equal(columns(40, 112), 2);
  assert.equal(columns(0, 112), 2);
});

test("density presets are ordered and each says what a tile can show", () => {
  assert.ok(DENSITIES.large > DENSITIES.comfortable && DENSITIES.comfortable > DENSITIES.compact);
  assert.equal(tileMeta("compact"), "badges");
  assert.equal(tileMeta("comfortable"), "title+badges");
  assert.equal(tileMeta("large"), "title+badges+source");
});

test("badges default to the three that answer 'what now', and shrink with the cover", () => {
  assert.deepEqual(DEFAULT_BADGES, ["unread", "downloaded", "new"]);
  assert.deepEqual(badgesFor("comfortable"), ["unread", "downloaded", "new"]);
  assert.deepEqual(badgesFor("comfortable", [...DEFAULT_BADGES, "source", "language"]), [
    "unread",
    "downloaded",
    "new",
    "source",
    "language",
  ]);
  // a compact cover cannot carry source/language even when asked
  assert.deepEqual(badgesFor("compact", BADGE_OPTIONS), ["unread", "downloaded", "new"]);
});

test("select-all says what it will select when filters are on", () => {
  assert.equal(selectAllLabel(3000, 3000), "Select all 3000");
  assert.equal(selectAllLabel(42, 3000), "Select all 42 filtered");
});

test("each collection has its own default sort", () => {
  assert.equal(defaultSort("s:continue"), "lastRead");
  assert.equal(defaultSort("s:recent"), "lastUpdated");
  assert.equal(defaultSort("c:1"), "title");
});

test("reader preferences are keyed by device class", () => {
  assert.equal(readerProfile(deviceClass(390)), "phone");
  assert.equal(readerProfile(deviceClass(1024)), "tablet");
  assert.equal(readerProfile(deviceClass(1440)), "desktop");
});

test("clamp keeps a width inside its bounds", () => {
  assert.equal(clamp(10, 20, 30), 20);
  assert.equal(clamp(40, 20, 30), 30);
  assert.equal(clamp(25, 20, 30), 25);
});

test("density: auto is the device class's own default, and Custom is the slider", () => {
  assert.equal(defaultDensity("phone"), "large");
  assert.equal(defaultDensity("tablet"), "comfortable");
  assert.equal(defaultDensity("desktop"), "comfortable");

  // `auto` is the device class's own width, which is not the same as its named density: a tablet's
  // "comfortable" 112 would draw seven columns at 900px (see the widths test below).
  assert.equal(coverWidth("auto", "phone", 132), AUTO_COVER.phone);
  assert.equal(coverWidth("auto", "tablet", 132), AUTO_COVER.tablet);
  assert.equal(coverWidth("comfortable", "desktop", 132), DENSITIES.comfortable);
  assert.equal(coverWidth("compact", "tablet", 132), DENSITIES.compact);
  // Custom is the slider, verbatim — the value need not be a preset.
  assert.equal(coverWidth("manual", "tablet", 132), 132);
  assert.equal(coverWidth("manual", "phone", 173), 173);
});

test("every density choice has exactly one option, and Auto is first", () => {
  assert.deepEqual(
    DENSITY_OPTIONS.map((option) => option.id),
    ["auto", "compact", "comfortable", "large", "manual"],
  );
  for (const density of ["compact", "comfortable", "large"]) {
    assert.equal(DENSITY_OPTIONS.filter((option) => option.id === density).length, 1);
  }
});

test("the collection bar: pinned first, and pinned is never behind +N", () => {
  const items = Array.from({ length: 10 }, (_, index) => ({ id: `c${index}`, pinned: index === 5 }));
  const plan = categoryNavPlan(400, "tabs", items.length, 1); // capacity 2, past eight → overflow
  assert.equal(plan.mode, "overflow");
  const bar = collectionBar(items, plan);
  assert.equal(bar.shown[0].id, "c5");
  assert.equal(bar.shown.length, plan.visible);
  assert.equal(bar.overflow.length, items.length - plan.visible);
  assert.ok(!bar.overflow.some((item) => item.pinned));
  assert.equal(new Set([...bar.shown, ...bar.overflow].map((item) => item.id)).size, items.length);
});

test("the collection bar draws everything when it fits, and nothing beside a sidebar", () => {
  const items = [
    { id: "a", pinned: false },
    { id: "b", pinned: true },
  ];
  const tabs = collectionBar(items, categoryNavPlan(800, "tabs", 2, 1));
  assert.deepEqual(tabs.shown.map((item) => item.id), ["b", "a"]);
  assert.deepEqual(tabs.overflow, []);

  const sidebar = collectionBar(items, { mode: "sidebar", visible: 0, overflow: 0, pinned: 1 });
  assert.deepEqual(sidebar, { shown: [], overflow: [] });
});

test("the same grid draws 2 / 3 / 4 / 6 columns at 390 / 600 / 900 / 1400", () => {
  // The plan's widths, through the shipped functions rather than a second copy of the arithmetic:
  // a tablet at the phone's cover width fitted seven columns, which is a wall of thumbnails.
  const counts = [390, 600, 900, 1400].map((width) => {
    const cover = coverWidth("auto", deviceClass(width), 132);
    return columns(width - 24, cover);
  });
  assert.deepEqual(counts, [2, 3, 4, 6]);
});

test("a named density still wins over the device's auto width", () => {
  // Someone who picked Compact meant it, even on a desktop.
  assert.equal(coverWidth("compact", "desktop", 132), DENSITIES.compact);
  assert.equal(coverWidth("manual", "desktop", 111), 111);
  assert.equal(coverWidth("auto", "phone", 132), AUTO_COVER.phone);
});
