import assert from "node:assert/strict";
import test from "node:test";

import { planReadState, remoteReadCount } from "../../src/lib/read-state.ts";

const local = (read = [], page = {}) => ({
  read: new Set(read),
  page: new Map(Object.entries(page).map(([id, value]) => [id, Number(value)])),
});
const known = (...ids) => new Set(ids);

test("a chapter the server says is read, and we do not, becomes read here", () => {
  const plan = planReadState(
    [{ chapterId: "a", read: true, at: 1000 }],
    local(),
    known("a"),
  );
  assert.deepEqual(plan.markRead, [{ chapterId: "a", read: true, at: 1000 }]);
  assert.deepEqual(plan.movePage, []);
});

test("a chapter already read here changes nothing", () => {
  const plan = planReadState([{ chapterId: "a", read: true }], local(["a"]), known("a"));
  assert.deepEqual(plan.markRead, []);
});

test("the server saying unread never unreads this device", () => {
  // A reset on the server is not a fact about this device; the next push corrects the server.
  const plan = planReadState([{ chapterId: "a", read: false }], local(["a"]), known("a"));
  assert.deepEqual(plan.markRead, []);
  assert.deepEqual(plan.movePage, []);
});

test("the page moves forward and never back", () => {
  const forward = planReadState([{ chapterId: "a", read: false, page: 12 }], local([], { a: 4 }), known("a"));
  assert.deepEqual(forward.movePage, [{ chapterId: "a", page: 12 }]);

  const back = planReadState([{ chapterId: "a", read: false, page: 4 }], local([], { a: 12 }), known("a"));
  assert.deepEqual(back.movePage, []);
});

test("a page of zero is no bookmark, not page one", () => {
  const plan = planReadState([{ chapterId: "a", read: false, page: 0 }], local(), known("a"));
  assert.deepEqual(plan.movePage, []);
});

test("a chapter we do not hold is ignored, never created", () => {
  // The chapter list is the provider's to publish; a mark for an id we cannot open is a dead row.
  const plan = planReadState([{ chapterId: "ghost", read: true, page: 9 }], local(), known("a"));
  assert.deepEqual(plan.markRead, []);
  assert.deepEqual(plan.movePage, []);
});

test("one server answer can both mark and move, per chapter", () => {
  const plan = planReadState(
    [
      { chapterId: "a", read: true, page: 20, at: 5 },
      { chapterId: "b", read: false, page: 7 },
    ],
    local(["b"], { b: 2 }),
    known("a", "b"),
  );
  assert.deepEqual(plan.markRead.map((row) => row.chapterId), ["a"]);
  // Both move: a read chapter still carries the server's bookmark, and "a" has none here yet.
  assert.deepEqual(plan.movePage, [
    { chapterId: "a", page: 20 },
    { chapterId: "b", page: 7 },
  ]);
});

test("the count is the server's own read total, not what changed", () => {
  const remote = [
    { chapterId: "a", read: true },
    { chapterId: "b", read: true },
    { chapterId: "c", read: false },
  ];
  assert.equal(remoteReadCount(remote), 2);
  assert.equal(remoteReadCount([]), 0);
});

test("an empty answer plans nothing", () => {
  const plan = planReadState([], local(), known("a"));
  assert.deepEqual(plan, { markRead: [], movePage: [] });
});
