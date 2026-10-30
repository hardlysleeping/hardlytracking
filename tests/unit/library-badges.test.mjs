import assert from "node:assert/strict";
import test from "node:test";

import { BADGE_KINDS, DEFAULT_BADGES, PRESET_BADGES, badgeList } from "../../src/lib/library/badges.ts";

test("the default set is unread, downloaded and new — the three that are about the reader", () => {
  assert.deepEqual(
    BADGE_KINDS.filter((kind) => DEFAULT_BADGES[kind]),
    ["unread", "downloaded", "new"],
  );
  const badges = badgeList({ unread: 3, downloaded: 2, isNew: true, source: "local", language: "en" }, DEFAULT_BADGES);
  assert.deepEqual(badges.map((badge) => badge.kind), ["unread", "downloaded", "new"]);
});

test("a fact of zero draws nothing, not a zero", () => {
  assert.deepEqual(badgeList({ unread: 0, downloaded: 0, isNew: false }, DEFAULT_BADGES), []);
  assert.deepEqual(badgeList({}, undefined), [], "no facts at all is an empty card");
});

test("counted badges carry their count, so the pill is a number and not a dot", () => {
  const [unread] = badgeList({ unread: 12 }, DEFAULT_BADGES);
  assert.equal(unread.label, "12");
  assert.equal(unread.count, 12);
});

test("a kind the settings turn off is not drawn even when the fact is there", () => {
  const badges = badgeList({ unread: 4, downloaded: 1 }, { ...DEFAULT_BADGES, unread: false });
  assert.deepEqual(badges.map((badge) => badge.kind), ["downloaded"]);
});

test("an unknown kind in a stored setting is dropped, never drawn", () => {
  const badges = badgeList({ unread: 2 }, { unread: true, wat: true });
  assert.deepEqual(badges.map((badge) => badge.kind), ["unread"], "an unknown key is ignored, never drawn");
  assert.ok(badges.every((badge) => BADGE_KINDS.includes(badge.kind)), "only declared kinds can reach a card");
});

test("the off-by-default facts draw when they are turned on", () => {
  const badges = badgeList(
    { source: "local", language: "en", tracked: true },
    { ...DEFAULT_BADGES, source: true, language: true, tracker: true },
  );
  assert.deepEqual(badges.map((badge) => badge.label), ["local", "EN", "Tracked"]);
});

test("Compact keeps the counted badges and drops the wordy ones", () => {
  assert.equal(PRESET_BADGES.compact.unread, true);
  assert.equal(PRESET_BADGES.compact.downloaded, true);
  assert.equal(PRESET_BADGES.compact.new, false);
  assert.deepEqual(PRESET_BADGES.comfortable, DEFAULT_BADGES);
});
