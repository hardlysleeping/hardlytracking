/**
 * The notice log: what the app said at the top of the screen, kept on the Settings page.
 *
 * The overlay is transient by design, so the log is what makes it answerable later. These tests pin
 * the three things that would make it useless: an unbounded log, a log that repeats one sentence
 * until everything else falls out of it, and a stored value that a hand edit can break.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

const { appendNotice, parseNoticeLog, noticeTime, NOTICE_LOG_LIMIT } = await import("../../src/lib/notice-log.ts");

test("a new notice goes on top", () => {
  const log = appendNotice([], { at: 1, text: "first" });
  assert.deepEqual(log.map((row) => row.text), ["first"]);
  assert.deepEqual(appendNotice(log, { at: 2, text: "second" }).map((row) => row.text), ["second", "first"]);
});

test("the same sentence is not written twice, and its time moves instead", () => {
  const log = appendNotice([{ at: 1, text: "host did not start" }], { at: 9, text: "host did not start" });
  assert.equal(log.length, 1);
  assert.equal(log[0].at, 9);
  // A different sentence in between is not disturbed by the dedupe.
  const mixed = appendNotice([{ at: 3, text: "another" }, { at: 1, text: "host did not start" }], { at: 9, text: "host did not start" });
  assert.deepEqual(mixed.map((row) => row.text), ["host did not start", "another"]);
});

test("the log is capped, and the oldest entries are what fall off", () => {
  let log = [];
  for (let i = 0; i < NOTICE_LOG_LIMIT + 12; i += 1) log = appendNotice(log, { at: i, text: `notice ${i}` });
  assert.equal(log.length, NOTICE_LOG_LIMIT);
  assert.equal(log[0].text, `notice ${NOTICE_LOG_LIMIT + 11}`);
  assert.equal(log.at(-1).text, "notice 12");
});

test("blank text is not a notice", () => {
  assert.deepEqual(appendNotice([], { at: 1, text: "   " }), []);
});

test("a stored value is read defensively", () => {
  assert.deepEqual(parseNoticeLog("nonsense"), []);
  assert.deepEqual(parseNoticeLog([null, 3, { text: "" }, { text: 5 }]), []);
  assert.deepEqual(parseNoticeLog([{ at: 5, text: " kept " }, { text: "no time" }]), [
    { at: 5, text: "kept" },
    { at: 0, text: "no time" },
  ]);
  const many = Array.from({ length: NOTICE_LOG_LIMIT + 5 }, (_, i) => ({ at: i, text: `n${i}` }));
  assert.equal(parseNoticeLog(many).length, NOTICE_LOG_LIMIT);
});

test("a missing time prints nothing rather than 1970", () => {
  assert.equal(noticeTime(0), "");
  assert.notEqual(noticeTime(Date.parse("2026-11-06T12:00:00Z")), "");
});
