import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EMPTY_FILTER,
  activeChips,
  countActive,
  isEmptyFilter,
  matchesFilter,
  withoutChip,
} from "../../src/lib/library/filter.ts";
import { emptyFacts } from "../../src/lib/library/query.ts";

function series(id, over = {}) {
  return { id, provider: "mihon", title: id, categoryIds: [], ...over };
}

/** Facts for two titles: Alpha is fully read with a download, Beta is untouched. */
function facts() {
  const base = emptyFacts();
  base.total.set("Alpha", 4);
  base.downloaded.set("Alpha", 1);
  base.total.set("Beta", 3);
  base.unread.set("Beta", 3);
  base.status.set("Alpha", "Ongoing");
  base.status.set("Beta", "Completed");
  return base;
}

test("an empty filter keeps everything and draws no chips", () => {
  const rows = [series("Alpha"), series("Beta")];
  assert.deepEqual(rows.filter((row) => matchesFilter(EMPTY_FILTER, facts(), row)).map((row) => row.id), ["Alpha", "Beta"]);
  assert.equal(countActive(EMPTY_FILTER), 0);
  assert.deepEqual(activeChips(EMPTY_FILTER), []);
  assert.equal(isEmptyFilter(EMPTY_FILTER), true);
});

test("unread is tri-state: has unread keeps Beta, fully read keeps Alpha only", () => {
  const rows = [series("Alpha"), series("Beta")];
  const unread = { ...EMPTY_FILTER, unread: "unread" };
  const read = { ...EMPTY_FILTER, unread: "read" };
  assert.deepEqual(rows.filter((row) => matchesFilter(unread, facts(), row)).map((row) => row.id), ["Beta"]);
  assert.deepEqual(rows.filter((row) => matchesFilter(read, facts(), row)).map((row) => row.id), ["Alpha"]);
  assert.deepEqual(activeChips(unread), [{ key: "unread", label: "Has unread" }]);
  assert.deepEqual(activeChips(read), [{ key: "unread", label: "Fully read" }]);
});

test("fully read needs at least one chapter: a title with none is not 'fully read'", () => {
  const base = emptyFacts();
  assert.equal(matchesFilter({ ...EMPTY_FILTER, unread: "read" }, base, series("Empty")), false);
});

test("both download boxes ticked is one chip that matches nothing", () => {
  const filter = { ...EMPTY_FILTER, downloaded: true, notDownloaded: true };
  assert.equal(countActive(filter), 1);
  assert.deepEqual(activeChips(filter), [{ key: "downloads", label: "Downloaded and not downloaded" }]);
  assert.equal(matchesFilter(filter, facts(), series("Alpha")), false);
  assert.equal(matchesFilter(filter, facts(), series("Beta")), false);
});

test("one download box at a time keeps the rows that answer it", () => {
  const only = { ...EMPTY_FILTER, downloaded: true };
  const none = { ...EMPTY_FILTER, notDownloaded: true };
  assert.deepEqual([series("Alpha"), series("Beta")].filter((row) => matchesFilter(only, facts(), row)).map((row) => row.id), ["Alpha"]);
  assert.deepEqual([series("Alpha"), series("Beta")].filter((row) => matchesFilter(none, facts(), row)).map((row) => row.id), ["Beta"]);
});

test("status and source are conjunctions over what the rows actually say", () => {
  const rows = [series("Alpha"), series("Beta")];
  const ongoing = { ...EMPTY_FILTER, statuses: ["Ongoing"] };
  assert.deepEqual(rows.filter((row) => matchesFilter(ongoing, facts(), row)).map((row) => row.id), ["Alpha"]);
  const mihon = { ...EMPTY_FILTER, sources: ["mihon"] };
  assert.equal(rows.filter((row) => matchesFilter(mihon, facts(), row)).length, 2);
  const komga = { ...EMPTY_FILTER, sources: ["komga"] };
  assert.equal(rows.filter((row) => matchesFilter(komga, facts(), row)).length, 0);
});

test("tracked reads the mapping set, and absent mapping information means untracked", () => {
  const base = facts();
  base.tracked = new Set(["Alpha"]);
  const tracked = { ...EMPTY_FILTER, tracked: "tracked" };
  const untracked = { ...EMPTY_FILTER, tracked: "untracked" };
  assert.deepEqual([series("Alpha"), series("Beta")].filter((row) => matchesFilter(tracked, base, row)).map((row) => row.id), ["Alpha"]);
  assert.deepEqual([series("Alpha"), series("Beta")].filter((row) => matchesFilter(untracked, base, row)).map((row) => row.id), ["Beta"]);
});

test("every chip round-trips: removing it changes the filter, and only that field", () => {
  const full = {
    unread: "unread",
    downloaded: true,
    notDownloaded: false,
    statuses: ["Ongoing"],
    sources: ["mihon"],
    tracked: "tracked",
  };
  assert.equal(countActive(full), 5);
  for (const chip of activeChips(full)) {
    const next = withoutChip(full, chip.key);
    assert.ok(countActive(next) < countActive(full), `${chip.key} should disappear`);
    assert.ok(!activeChips(next).some((row) => row.key === chip.key), `${chip.key} is still drawn`);
  }
});

test("removing the contradictory downloads chip clears both boxes", () => {
  const both = { ...EMPTY_FILTER, downloaded: true, notDownloaded: true };
  const next = withoutChip(both, "downloads");
  assert.equal(next.downloaded, false);
  assert.equal(next.notDownloaded, false);
  assert.equal(countActive(next), 0);
});

test("an unknown chip key is a no-op rather than a throw", () => {
  const filter = { ...EMPTY_FILTER, unread: "unread" };
  assert.deepEqual(withoutChip(filter, "source:uninstalled"), filter);
  assert.deepEqual(withoutChip(filter, "nonsense"), filter);
});
