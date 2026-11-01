/**
 * Deadlines and the slow-call counter.
 *
 * The interesting cases are the ones a passing happy-path test hides: a socket that opens and never
 * answers, a caller that cancels first, and a counter that must not leak when a call settles.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DeadlineError, RUNTIME_DEADLINE_MS, activity, deadlined, withDeadline } from "../../src/lib/deadline.ts";

/** A `fetch` that never answers, but does hand back the signal so a test can see the abort. */
function hanging() {
  let signal;
  const impl = (_input, init) => {
    signal = init?.signal ?? undefined;
    return new Promise(() => {});
  };
  return { impl, signal: () => signal };
}

/** A `fetch` that answers immediately. */
const okFetch = async () => new Response("{}", { status: 200 });

test("a call that never answers is ended by its deadline, by name", async () => {
  const { impl } = hanging();
  const started = Date.now();
  await assert.rejects(
    deadlined(impl, 30, "the repository")(`https://example.invalid/index.json`),
    (error) => {
      assert.ok(error instanceof DeadlineError, `expected a DeadlineError, got ${String(error)}`);
      assert.equal(error.label, "the repository");
      // The message is what a screen shows, so it has to name the thing and the seconds.
      assert.match(error.message, /the repository did not answer within 0 s/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 2000, "the deadline fired long after it was due");
});

test("the fetch it wraps is actually aborted, not just abandoned", async () => {
  const { impl, signal } = hanging();
  await assert.rejects(deadlined(impl, 20, "the source")("https://example.invalid/x"));
  assert.equal(signal()?.aborted, true, "the underlying request kept running after the deadline");
});

test("a fast answer passes straight through, and is counted while it runs", async () => {
  let seen = 0;
  const watch = activity.subscribe(() => (seen += 1));
  assert.equal(activity.count, 0);
  const response = await deadlined(okFetch, 5_000, "the source")("https://example.invalid/x");
  watch();
  assert.equal(response.status, 200);
  assert.equal(activity.count, 0, "a finished call stayed in the counter");
  assert.ok(seen >= 2, "the counter never notified anyone");
});

test("a caller's own signal still cancels, and is not reported as a deadline", async () => {
  const { impl } = hanging();
  const controller = new AbortController();
  const call = deadlined(impl, 5_000, "the source")("https://example.invalid/x", { signal: controller.signal });
  setTimeout(() => controller.abort(new Error("user cancelled")), 10);
  await assert.rejects(call, (error) => {
    assert.ok(!(error instanceof DeadlineError), "a caller's cancel was reported as a deadline");
    return true;
  });
});

test("withDeadline stops waiting on a promise that is not a fetch", async () => {
  const never = new Promise(() => {});
  await assert.rejects(withDeadline(never, 20, "the Suwayomi runtime"), /the Suwayomi runtime did not answer within 0 s/);
  assert.equal(activity.count, 0);
});

test("the counter names the oldest call, so the chip does not flicker between two", () => {
  let clock = 1_000;
  activity.now = () => clock;
  const first = activity.begin("the Internet Archive");
  clock += 4_000;
  const second = activity.begin("your Komga server");
  clock += 1_000;
  const slowest = activity.slowest();
  assert.deepEqual(slowest, { label: "the Internet Archive", elapsedMs: 5_000 });
  first();
  assert.deepEqual(activity.slowest(), { label: "your Komga server", elapsedMs: 1_000 });
  second();
  assert.equal(activity.slowest(), null);
  activity.now = () => Date.now();
});

test("ending a call twice does not disturb the count", () => {
  const end = activity.begin("the source");
  const other = activity.begin("the repository");
  end();
  end();
  assert.equal(activity.count, 1);
  other();
  assert.equal(activity.count, 0);
});

test("the default deadline is long enough for a real interpreter, short enough to notice", () => {
  // Not a style assertion: too short kills a working slow source, too long is the hang this exists
  // to prevent. Thirty seconds is the compromise the release plan asks for.
  assert.equal(RUNTIME_DEADLINE_MS, 30_000);
});
