import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BADGE_OPTIONS,
  DEFAULT_BADGES,
  DENSITIES,
  badgesFor,
  categoryNavPlan,
  chipCapacity,
  clamp,
  columns,
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
  assert.equal(deviceClass(599), "phone");
  assert.equal(deviceClass(600), "tablet");
  assert.equal(deviceClass(1180), "tablet"); // iPad landscape is not a desktop
  assert.equal(deviceClass(1279), "tablet");
  assert.equal(deviceClass(1280), "desktop");
});

test("chrome: a tablet keeps a rail, a desktop a sidebar, a phone neither", () => {
  assert.equal(railWidth("phone"), 0);
  assert.equal(railWidth("tablet"), 76);
  assert.equal(railWidth("desktop"), 224);
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
  assert.equal(layout.optionalSplit, false);
  assert.equal(layout.categoryNav.mode, "tabs");
  assert.equal(layout.density, "comfortable");
  assert.equal(layout.resume, "always");
});

test("a tablet landscape splits by default, with a detail pane and a sidebar", () => {
  const layout = libraryLayout(1180, 820, { collectionCount: 6 });
  assert.equal(layout.mode, "split");
  assert.equal(layout.categoryNav.mode, "sidebar");
  assert.ok(layout.detailWidth >= 340 && layout.detailWidth <= 520);
  assert.ok(layout.gridWidth > 0);
  assert.equal(layout.selectionBar, "pinned");
});

test("a wide but short window does not split: a detail pane needs height too", () => {
  const layout = libraryLayout(1180, 520, { collectionCount: 6 });
  assert.equal(layout.mode, "single");
  assert.equal(layout.optionalSplit, false);
});

test("the middle band offers a split but does not force it", () => {
  // 800 wide tablet: usable 692, below the optional threshold
  assert.equal(libraryLayout(800, 900, { collectionCount: 3 }).optionalSplit, false);
  // 900 wide with tabs: usable 792, optional but still single until asked
  const optional = libraryLayout(900, 900, { collectionCount: 3, nav: "tabs" });
  assert.equal(optional.optionalSplit, true);
  assert.equal(optional.mode, "single");
  const forced = libraryLayout(900, 900, { collectionCount: 3, nav: "tabs", forceSplit: true });
  assert.equal(forced.mode, "split");
});

test("a desktop gets a split, a remembered ratio and hover affordances", () => {
  const layout = libraryLayout(1440, 900, { collectionCount: 6, splitRatio: 0.6 });
  assert.equal(layout.mode, "split");
  assert.equal(layout.splitRatio, 0.6);
  assert.equal(layout.resume, "hover");
  assert.equal(layout.density, "comfortable");
});

test("a dragged ratio is clamped so neither pane becomes unusable", () => {
  assert.equal(libraryLayout(1440, 900, { splitRatio: 0.1 }).splitRatio, 0.45);
  assert.equal(libraryLayout(1440, 900, { splitRatio: 0.95 }).splitRatio, 0.75);
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

test("sidebar width is clamped to a list, not a wall", () => {
  assert.equal(sidebarWidth(400), 200);
  assert.equal(sidebarWidth(5000), 280);
  assert.ok(sidebarWidth(1072) >= 200 && sidebarWidth(1072) <= 280);
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
