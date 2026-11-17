/**
 * The Library and History option groups live in one component each, and both pages draw them.
 *
 * The bug this prevents is the one the owner named: options buried in Settings with no door from
 * the page they belong to, and — worse — a second, hand-copied set on the page that drifts from
 * the first. These checks read the sources, so a control silently dropped in a later edit fails
 * here rather than in his hands.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../src/${path}`, import.meta.url), "utf8");
const flat = (text) => text.replace(/\s+/g, " ");

const settingsView = flat(read("views/Settings.svelte"));
const libraryView = flat(read("views/Library.svelte"));
const historyView = flat(read("views/History.svelte"));
const header = flat(read("components/LibraryHeader.svelte"));
const libraryPanel = flat(read("components/LibrarySettingsPanel.svelte"));
const historyPanel = flat(read("components/HistorySettingsPanel.svelte"));

test("Settings renders the shared panels instead of its own copies", () => {
  assert.match(settingsView, /<LibrarySettingsPanel \/>/, "the Library section draws the shared panel");
  assert.match(settingsView, /<HistorySettingsPanel \/>/, "the History section draws the shared panel");
  // The copies that used to live here are gone: one implementation, two doors.
  assert.doesNotMatch(settingsView, /Cover size/, "the hand-written Library rows left Settings");
  assert.doesNotMatch(settingsView, /Keep reading history/, "the hand-written History rows left Settings");
});

test("every Library control the old Settings group had is still in the panel", () => {
  for (const label of [
    "Category navigation",
    "Library panes",
    "Show “Continue reading”",
    "Library sections",
  ]) {
    assert.ok(libraryPanel.includes(label), `${label} is still a control`);
  }
  // Every option of the two selects, by name.
  for (const option of ["Automatic", "Tabs", "Sidebar"]) assert.ok(libraryPanel.includes(`>${option}<`), `${option} is still offered`);
  // Size and density live in the display menu; the panel does not repeat them.
  assert.doesNotMatch(libraryPanel, /Cover size/, "Cover size left the panel");
  // The view/columns row still comes from the one component that owns it.
  assert.match(libraryPanel, /<BrowseDisplay \/>/, "the panel draws BrowseDisplay unless the page does");
});

test("every History control the old Settings group had is still in the panel", () => {
  for (const label of ["Pause reading history", "Keep reading history", "History panes", "Clear reading history", "Clear history by date"]) {
    assert.ok(historyPanel.includes(label), `${label} is still a control`);
  }
  for (const choice of ["Forever", "30 days", "90 days", "6 months", "1 year", "Custom…"]) {
    assert.ok(historyPanel.includes(`>${choice}<`), `retention still offers ${choice}`);
  }
  for (const range of ["Today", "Last 7 days", "Last 30 days", "All time"]) {
    assert.ok(historyPanel.includes(`label: "${range}"`), `the date range still offers ${range}`);
  }
  // The two-step delete and its honest copy survived the move.
  assert.match(historyPanel, /Progress and read marks were not touched/, "the result still says what survived");
  assert.match(historyPanel, /deleted by retention|never deleted by retention/, "the retention copy came along");
});

test("the History pane control moved out of Layout, the back/forward corner did not", () => {
  assert.match(settingsView, /Back\/forward corner/, "the floating-nav corner is still in Layout");
  assert.doesNotMatch(settingsView, /History panes/, "History panes left the Layout section");
});

test("both pages open their panel in a sheet, from a gear, without navigating", () => {
  for (const [name, view, panel, title] of [
    ["Library", libraryView, "LibrarySettingsPanel", "Library settings"],
    ["History", historyView, "HistorySettingsPanel", "History settings"],
  ]) {
    assert.ok(view.includes(`<${panel}`), `${name} renders the shared panel`);
    assert.ok(view.includes(`title="${title}"`), `${name} names the sheet`);
    assert.match(view, /settingsOpen = true/, `${name} has state for the popup`);
    // A popup, not a route: no door to the panel may be a navigation.
    assert.ok(!view.includes('go("/settings")'), `${name} has no route to Settings left behind`);
    assert.match(view, /tick\(\)\.then\(\(\) => (header\?\.focusSettings\(\)|gear\?\.focus\(\))\)/, `${name} hands focus back to its gear`);
  }
  assert.match(libraryView, /<LibrarySettingsPanel browse=\{false\} \/>/, "the Library page does not draw the inline display row twice");
});

test("the gear says what it is, in the top bar of both pages", () => {
  assert.match(header, /aria-label="Library settings"/);
  assert.match(header, /title="Library settings"/);
  assert.match(header, /aria-haspopup="dialog"/);
  assert.match(historyView, /aria-label="History settings"/);
  assert.match(historyView, /title="History settings"/);
  // The four icons the bar already had are untouched.
  for (const label of ["Search the library", "Select series", "Refresh", "More library actions"]) {
    assert.ok(header.includes(`aria-label="${label}"`), `${label} is still in the top bar`);
  }
});

test("the ⋯ sheet's Library settings expands in place instead of leaving the page", () => {
  assert.doesNotMatch(libraryView, /onsettings=\{\(\) => go\("\/settings"\)\}/, "the old redirect is gone");
  assert.match(libraryView, /onsettings=\{\(\) => \(settingsOpen = true\)\}/, "it opens the popup");
});
