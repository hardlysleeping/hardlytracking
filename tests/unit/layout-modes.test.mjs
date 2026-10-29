import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DENSITIES,
  clamp,
  columns,
  deviceClass,
  gridWidth,
  libraryLayout,
  readerProfile,
  selectionBar,
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

test("a phone is one pane with chips, and detail replaces the grid", () => {
  const layout = libraryLayout(390, 844);
  assert.equal(layout.mode, "single");
  assert.equal(layout.collections, "chips");
  assert.equal(layout.detail, "replace");
  assert.equal(layout.collectionWidth, 0);
  assert.equal(layout.detailWidth, 0);
  assert.equal(layout.resume, "menu");
});

test("a tablet portrait keeps the collection column but still replaces the grid for detail", () => {
  const layout = libraryLayout(768, 1024);
  assert.equal(layout.mode, "single");
  assert.equal(layout.collections, "column");
  assert.equal(layout.detail, "replace");
  assert.ok(layout.collectionWidth >= 176 && layout.collectionWidth <= 264);
  assert.equal(layout.detailWidth, 0);
});

test("a tablet landscape splits grid and detail, and keeps the collection column", () => {
  const layout = libraryLayout(1180, 820);
  assert.equal(layout.mode, "list-detail");
  assert.equal(layout.collections, "column");
  assert.equal(layout.detail, "pane");
  assert.ok(layout.detailWidth >= 340 && layout.detailWidth <= 460);
});

test("a wide but short window does not split: a detail pane needs height too", () => {
  const layout = libraryLayout(1100, 560);
  assert.equal(layout.mode, "single");
  assert.equal(layout.detail, "replace");
});

test("a desktop gets three panes and hover affordances", () => {
  const layout = libraryLayout(1440, 900);
  assert.equal(layout.mode, "three-pane");
  assert.equal(layout.collections, "column");
  assert.equal(layout.detail, "pane");
  assert.equal(layout.resume, "hover");
  assert.ok(layout.detailWidth >= 360 && layout.detailWidth <= 520);
});

test("tablets and desktops browse denser than phones", () => {
  assert.equal(libraryLayout(390, 844).gridMin, 132);
  assert.equal(libraryLayout(768, 1024).gridMin, 112);
  assert.equal(libraryLayout(1440, 900).gridMin, 112);
});

test("columns follow from the available width, and never go below two or above eight", () => {
  assert.equal(columns(390 - 32, 132), 2); // a phone: two covers
  assert.equal(columns(390 - 32, 112), 2); // three covers plus gaps do not fit at 358px
  assert.equal(columns(390 - 32, 104), 3); // the dense setting does fit three
  assert.equal(columns(700, 112), 5);
  assert.equal(columns(2000, 88), 8);
  assert.equal(columns(40, 132), 2);
  assert.equal(columns(0, 132), 2);
});

test("grid width subtracts the rail, the collection column and the detail pane", () => {
  const layout = libraryLayout(1440, 900);
  const width = gridWidth(1440, layout, 224);
  assert.ok(width > 0);
  assert.equal(width, 1440 - 224 - layout.collectionWidth - layout.detailWidth - 32);
  // A tablet portrait has no detail pane, so the grid keeps that room.
  const portrait = libraryLayout(768, 1024);
  assert.equal(gridWidth(768, portrait, 76), 768 - 76 - portrait.collectionWidth - 32);
});

test("tile metadata shrinks with the cover, and density presets are ordered", () => {
  assert.equal(tileMeta("comfortable"), "title+badges+source");
  assert.equal(tileMeta("compact"), "title+badges");
  assert.equal(tileMeta("dense"), "badges");
  assert.ok(DENSITIES.comfortable > DENSITIES.compact && DENSITIES.compact > DENSITIES.dense);
});

test("the selection bar floats on a phone and pins to the grid elsewhere", () => {
  assert.equal(selectionBar(libraryLayout(390, 844)), "floating");
  assert.equal(selectionBar(libraryLayout(768, 1024)), "pinned");
  assert.equal(selectionBar(libraryLayout(1440, 900)), "pinned");
});

test("reader preferences are keyed by device class, so a tablet spread never lands on a phone", () => {
  assert.equal(readerProfile(deviceClass(390)), "phone");
  assert.equal(readerProfile(deviceClass(1024)), "tablet");
  assert.equal(readerProfile(deviceClass(1440)), "desktop");
});

test("clamp keeps a width inside its bounds", () => {
  assert.equal(clamp(10, 20, 30), 20);
  assert.equal(clamp(40, 20, 30), 30);
  assert.equal(clamp(25, 20, 30), 25);
});
