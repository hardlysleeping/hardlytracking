import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { DownloadEngine } from "../../src/lib/downloads/engine.ts";
import {
  QUEUE_PREF,
  bytesOf,
  chaptersToFetch,
  grabbedLabel,
  grabbedOf,
  groupBySeries,
  isComplete,
  manageRows,
  matchesDownloadQuery,
  planQueue,
  reconcile,
  retryable,
  sortForManage,
  staleRows,
  stateOf,
} from "../../src/lib/downloads/state.ts";

// ---- rows ---------------------------------------------------------------

function row(over = {}) {
  return {
    chapterId: "ch1",
    seriesId: "s1",
    chapterName: "Chapter 1",
    pages: 10,
    bytes: 1000,
    at: 100,
    total: 10,
    state: "done",
    ...over,
  };
}

function item(over = {}) {
  return { chapterId: "ch1", seriesId: "s1", chapterName: "Chapter 1", ...over };
}

function stored(entries) {
  return new Map(Object.entries(entries).map(([chapterId, value]) => [chapterId, { pages: value[0], bytes: value[1] }]));
}

// ---- isComplete ---------------------------------------------------------

test("a finished download is complete only when its numbers agree", () => {
  assert.equal(isComplete(row()), true);
  assert.equal(isComplete(row({ state: "partial" })), false);
  assert.equal(isComplete(row({ state: "failed" })), false);
  assert.equal(isComplete(row({ state: "downloading" })), false);
  assert.equal(isComplete(row({ pages: 0, bytes: 0 })), false);
});

test("a partial download never reads as complete, whatever its state field says", () => {
  const half = row({ pages: 4, bytes: 400, total: 40, state: "done" });
  assert.equal(isComplete(half), false, "4 stored pages of a 40-page chapter is not a download");
  assert.equal(stateOf(half), "partial");
});

test("rows written before the state field existed are complete when they have pages", () => {
  const legacy = { chapterId: "ch9", seriesId: "s1", chapterName: "Chapter 9", pages: 12, bytes: 900, at: 1 };
  assert.equal(isComplete(legacy), true);
  assert.equal(stateOf(legacy), "done");
});

// ---- planQueue ----------------------------------------------------------

test("nothing runs while a chapter is running, and the rest keeps its order", () => {
  const queue = [item({ chapterId: "a" }), item({ chapterId: "b" })];
  const plan = planQueue(queue, { chapterId: "z", done: 2, total: 9 });
  assert.equal(plan.next, null);
  assert.deepEqual(plan.rest.map((entry) => entry.chapterId), ["a", "b"]);
});

test("the queue runs one at a time, first in first out", () => {
  const queue = [item({ chapterId: "a" }), item({ chapterId: "b" }), item({ chapterId: "c" })];
  const plan = planQueue(queue, null);
  assert.equal(plan.next.chapterId, "a");
  assert.deepEqual(plan.rest.map((entry) => entry.chapterId), ["b", "c"]);
  assert.equal(planQueue([], null).next, null);
});

test("a chapter that gave up is skipped but stays in the list to be retried", () => {
  const queue = [item({ chapterId: "broken", state: "failed" }), item({ chapterId: "b" })];
  const plan = planQueue(queue, null);
  assert.equal(plan.next.chapterId, "b", "a failure at the head must not block the queue");
  assert.deepEqual(plan.rest.map((entry) => entry.chapterId), ["broken"]);
  assert.equal(planQueue([item({ chapterId: "only", state: "failed" })], null).next, null, "and it is not retried forever");
});

// ---- retryable ----------------------------------------------------------

test("retry is offered for a dropped connection, not for a chapter that is not there", () => {
  assert.equal(retryable(new Error("Failed to fetch")), true);
  assert.equal(retryable(new Error("page 3: HTTP 500")), true);
  assert.equal(retryable(new Error("the extension host is not answering")), true);
  assert.equal(retryable(new Error("cancelled")), true);
  assert.equal(retryable(new Error("page 2: HTTP 404")), false);
  assert.equal(retryable(new Error("the source returned no pages")), false);
  assert.equal(retryable(new Error("403")), false);
  assert.equal(retryable(new Error("")), false);
  assert.equal(retryable(undefined), false);
});

// ---- size, order, grouping ---------------------------------------------

test("bytes add up, and a row without a size is not a crash", () => {
  assert.equal(bytesOf([{ bytes: 10 }, { bytes: 32 }]), 42);
  assert.equal(bytesOf([]), 0);
  assert.equal(bytesOf([{ bytes: Number.NaN }, { bytes: 5 }]), 5);
});

test("a manage list runs series by series, chapters in chapter order", () => {
  const rows = [
    row({ chapterId: "s1:12", seriesId: "s1", chapterName: "Chapter 12", number: 12 }),
    row({ chapterId: "s2:1", seriesId: "s2", chapterName: "Chapter 1", number: 1 }),
    row({ chapterId: "s1:3", seriesId: "s1", chapterName: "Chapter 3", number: 3 }),
  ];
  assert.deepEqual(
    sortForManage(rows).map((entry) => entry.chapterId),
    ["s1:3", "s1:12", "s2:1"],
  );
});

test("grouping keeps each series whole, with its own size and count", () => {
  const rows = [
    row({ chapterId: "a2", seriesId: "a", number: 2, bytes: 200 }),
    row({ chapterId: "a1", seriesId: "a", number: 1, bytes: 100 }),
    row({ chapterId: "b1", seriesId: "b", number: 1, bytes: 50 }),
  ];
  const groups = groupBySeries(rows);
  assert.deepEqual(groups.map((group) => group.seriesId), ["a", "b"]);
  assert.deepEqual(groups[0].rows.map((entry) => entry.chapterId), ["a1", "a2"]);
  assert.equal(groups[0].bytes, 300);
  assert.equal(groups[0].chapters, 2);
  // A known title orders the list; an unknown id is still a stable key.
  const titled = groupBySeries(rows, new Map([["a", "Zeta"], ["b", "Alpha"]]));
  assert.deepEqual(titled.map((group) => group.seriesId), ["b", "a"]);
});

// ---- stale --------------------------------------------------------------

test("a download whose stored pages do not match its total is stale", () => {
  const stale = staleRows([row({ pages: 4, total: 40 }), row({ chapterId: "ok", pages: 40, total: 40 })]);
  assert.deepEqual(stale.map((entry) => entry.chapterId), ["ch1"]);
});

test("a download with no pages at all is stale, and so is one that disagrees with the source", () => {
  assert.equal(staleRows([row({ pages: 0, bytes: 0 })]).length, 1);
  const rows = [row({ pages: 10, total: 10 })];
  assert.equal(staleRows(rows, 12).length, 1, "the source says 12 pages, the row has 10");
  assert.equal(staleRows(rows, new Map([["ch1", 10]])).length, 0);
  assert.equal(staleRows(rows, { ch1: 11 }).length, 1);
  assert.equal(staleRows(rows, (entry) => (entry.chapterId === "ch1" ? 9 : undefined)).length, 1);
});

// ---- reconcile ----------------------------------------------------------

test("an interrupted run becomes partial, with the pages that really arrived", () => {
  const rows = [row({ pages: 40, total: 40, state: "downloading" })];
  const result = reconcile(rows, stored({ ch1: [4, 400] }), []);
  assert.equal(result.rows[0].state, "partial");
  assert.equal(result.rows[0].pages, 4);
  assert.equal(result.rows[0].bytes, 400);
  assert.equal(result.rows[0].error, "interrupted");
  assert.equal(result.changed, true);
});

test("an interrupted run goes back to the head of the queue, so a reload resumes it", () => {
  const rows = [row({ chapterId: "ch2", pages: 30, total: 30, state: "downloading" })];
  const result = reconcile(rows, stored({ ch2: [5, 500] }), [item({ chapterId: "ch3" })]);
  assert.deepEqual(result.queue.map((entry) => entry.chapterId), ["ch2", "ch3"]);
  assert.equal(result.queue[0].state, undefined, "a resumed chapter is queued, not failed");
});

test("a chapter that is already complete is not queued again", () => {
  const rows = [row()];
  const result = reconcile(rows, stored({ ch1: [10, 1000] }), [item()]);
  assert.deepEqual(result.queue, []);
});

test("page rows with no download row are reported so the bytes can be freed", () => {
  const result = reconcile([row()], stored({ ch1: [10, 1000], ghost: [3, 300] }), []);
  assert.deepEqual(result.orphans, ["ghost"]);
});

test("a row that called itself done with the wrong number of pages is demoted", () => {
  const result = reconcile([row({ pages: 10, total: 40, state: "done" })], stored({ ch1: [10, 1000] }), []);
  assert.equal(result.rows[0].state, "partial");
});

test("rows that already tell the truth are not rewritten", () => {
  const result = reconcile([row()], stored({ ch1: [10, 1000] }), []);
  assert.equal(result.changed, false);
  assert.deepEqual(result.rows.map((entry) => entry.state), ["done"]);
});

// ---- manage rows --------------------------------------------------------

test("a queued chapter and its partial row are one line, and the queue wins", () => {
  const lines = manageRows([row({ pages: 4, total: 40, state: "partial" })], [item()], null);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].state, "queued");
  assert.equal(lines[0].bytes, 1000, "the size is what is really on disk");
});

test("the running chapter says how far it has got", () => {
  const lines = manageRows([], [item()], { chapterId: "ch1", done: 7, total: 20 });
  assert.equal(lines[0].state, "downloading");
  assert.equal(lines[0].done, 7);
  assert.equal(lines[0].total, 20);
});

// ---- the engine, against the in-memory database -------------------------

function page(index) {
  return { index, url: `https://example.test/${index}.jpg` };
}

/** A store, an engine, and the two things it cannot own: a page list and page bytes. */
function rig(options = {}) {
  const store = new LibraryStore(memoryDatabase());
  const host = { rows: [], queue: [], active: null, error: null };
  const created = [];
  const revoked = [];
  const calls = { pages: 0, fetched: 0 };
  let failOn = options.failOn ?? null;
  const engine = new DownloadEngine(host, {
    store,
    pages: async (chapterId) => {
      calls.pages += 1;
      if (options.hostDown) throw new Error("the extension host is not answering");
      const count = options.pages ?? 5;
      return Array.from({ length: count }, (_, index) => page(index));
    },
    fetchBlob: async (entry) => {
      calls.fetched += 1;
      if (failOn !== null && entry.index === failOn) throw new Error(`page ${entry.index + 1}: HTTP 404`);
      return new Blob([new Uint8Array(100)]);
    },
    now: () => 1000,
    createUrl: (blob) => {
      const url = `blob:test/${created.length}/${blob.size}`;
      created.push(url);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
  });
  return {
    store,
    host,
    engine,
    created,
    revoked,
    calls,
    setFailOn: (index) => (failOn = index),
  };
}

const chapter = (id, number) => ({ id, seriesId: "s1", name: `Chapter ${number}`, number, pageCount: 5, read: false });

test("a queued chapter downloads, is stored, and reads back from the device", async () => {
  const { store, host, engine } = rig();
  engine.enqueue("s1", chapter("ch1", 1));
  await engine.whenIdle();

  const rows = await store.listDownloads();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "done");
  assert.equal(rows[0].pages, 5);
  assert.equal(rows[0].total, 5);
  assert.equal(rows[0].bytes, 500);
  assert.deepEqual(host.queue, [], "a finished chapter leaves the queue");
  assert.deepEqual((await store.getPref(QUEUE_PREF)) ?? [], []);

  const local = await engine.local("ch1");
  assert.equal(local.complete, true);
  assert.equal(local.urls.length, 5);
  assert.ok(local.urls.every((url) => typeof url === "string"));
});

test("the queue is written down, so a reload resumes the chapters that had not started", async () => {
  const store = new LibraryStore(memoryDatabase());
  const host = { rows: [], queue: [], active: null, error: null };
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const first = new DownloadEngine(host, {
    store,
    pages: async () => {
      await gate; // the first chapter is still downloading while the queue is inspected
      return [page(0), page(1)];
    },
    fetchBlob: async () => new Blob([new Uint8Array(10)]),
  });
  first.enqueueMany("s1", [chapter("ch1", 1), chapter("ch2", 2)]);

  // The chapter that has not started is already on disk, so a kill now loses nothing.
  let queued = [];
  for (let attempt = 0; attempt < 50 && (queued.length === 0 || host.active === null); attempt += 1) {
    queued = (await store.getPref(QUEUE_PREF)) ?? [];
    if (queued.length === 0 || host.active === null) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual(queued.map((entry) => entry.chapterId), ["ch2"]);
  assert.equal(host.active.chapterId, "ch1");

  open();
  await first.whenIdle();
  assert.equal((await store.listDownloads()).length, 2);

  // A second engine on the same database is a reload: nothing in memory, everything in the store.
  const second = new DownloadEngine({ rows: [], queue: [], active: null, error: null }, {
    store,
    pages: async () => [page(0)],
    fetchBlob: async () => new Blob([new Uint8Array(10)]),
  });
  await second.load();
  assert.deepEqual((await store.getPref(QUEUE_PREF)) ?? [], [], "nothing is left to resume");
});

test("an interrupted chapter is partial, and Retry fetches only the pages that are missing", async () => {
  const { store, host, engine, calls } = rig();
  // What a kill leaves behind: a row saying `downloading`, and two of five pages on disk.
  await store.putDownload({ chapterId: "ch1", seriesId: "s1", chapterName: "Chapter 1", pages: 5, bytes: 500, at: 1, total: 5, state: "downloading" });
  for (const index of [0, 1]) {
    await store.putDownloadPage({ id: `ch1#${index}`, chapterId: "ch1", index, blob: new Blob([new Uint8Array(100)]) });
  }

  // The reload both tells the truth about the row and puts the chapter back in the queue; the
  // queue then finishes it without fetching the two pages that are already here.
  await engine.load();
  await engine.whenIdle();
  assert.equal(calls.fetched, 3, "the two pages already on the device are not fetched again");
  assert.equal(host.rows[0].state, "done");
  assert.equal(host.rows[0].pages, 5);
  assert.equal(host.rows[0].error, undefined);
  assert.equal((await engine.local("ch1")).complete, true);
});

test("a page that fails mid-chapter leaves a readable partial, not a blank chapter", async () => {
  const { store, host, engine } = rig({ failOn: 2 });
  engine.enqueue("s1", chapter("ch1", 1));
  await engine.whenIdle();

  const rows = await store.listDownloads();
  assert.equal(rows[0].state, "partial");
  assert.equal(rows[0].pages, 2);
  assert.equal(rows[0].total, 5);
  assert.match(rows[0].error, /404/);
  assert.equal(host.queue[0].state, "failed");
  assert.match(host.error, /Chapter 1/);

  const local = await engine.local("ch1");
  assert.equal(local.complete, false, "a partial must never read as complete");
  assert.equal(local.stored, 2);
  assert.equal(local.total, 5);
  assert.equal(typeof local.urls[0], "string", "the pages that did arrive are readable");
  assert.equal(typeof local.urls[1], "string");
  assert.equal(local.urls[2], null, "and the missing one is honestly missing");
});

test("a host that is down leaves a failed queue item, and Retry picks it up when it is back", async () => {
  const down = rig({ hostDown: true });
  down.engine.enqueue("s1", chapter("ch1", 1));
  await down.engine.whenIdle();
  assert.deepEqual(await down.store.listDownloads(), [], "nothing was stored, so nothing pretends to be a download");
  assert.equal(down.host.queue[0].state, "failed");
  assert.match(down.host.queue[0].error, /host/);
  assert.equal(await down.engine.local("ch1"), null, "the reader falls back to the network as before");

  down.setFailOn(null);
  const up = new DownloadEngine(down.host, {
    store: down.store,
    pages: async () => [page(0), page(1)],
    fetchBlob: async () => new Blob([new Uint8Array(50)]),
  });
  up.retry("ch1");
  await up.whenIdle();
  const rows = await down.store.listDownloads();
  assert.equal(rows[0].state, "done");
  assert.equal(rows[0].pages, 2);
});

test("cancelling a chapter that has not started simply leaves the queue", async () => {
  const store = new LibraryStore(memoryDatabase());
  const host = { rows: [], queue: [], active: null, error: null };
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const engine = new DownloadEngine(host, {
    store,
    pages: async () => {
      await gate;
      return [page(0)];
    },
    fetchBlob: async () => new Blob([new Uint8Array(10)]),
  });
  engine.enqueueMany("s1", [chapter("ch1", 1), chapter("ch2", 2)]);
  for (let attempt = 0; attempt < 50 && host.active === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(host.active.chapterId, "ch1");
  engine.cancel("ch2");
  open();
  await engine.whenIdle();
  const rows = await store.listDownloads();
  assert.deepEqual(rows.map((entry) => entry.chapterId), ["ch1"], "only the chapter that was asked for");
  assert.deepEqual(host.queue, []);
});

test("cancelling a running chapter stops it, keeps what arrived, and is not an error", async () => {
  const store = new LibraryStore(memoryDatabase());
  const host = { rows: [], queue: [], active: null, error: null };
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  let reached;
  const inFlight = new Promise((resolve) => (reached = resolve));
  const engine = new DownloadEngine(host, {
    store,
    pages: async () => Array.from({ length: 5 }, (_, index) => page(index)),
    fetchBlob: async (entry) => {
      if (entry.index === 1) {
        reached();
        await gate;
      }
      return new Blob([new Uint8Array(100)]);
    },
    now: () => 1000,
  });
  engine.enqueue("s1", chapter("ch1", 1));
  await inFlight;
  engine.cancel("ch1");
  open();
  await engine.whenIdle();

  const rows = await store.listDownloads();
  assert.equal(rows[0].state, "partial");
  assert.equal(rows[0].pages, 2);
  assert.equal(rows[0].total, 5);
  assert.equal(rows[0].error, "cancelled");
  assert.deepEqual(host.queue, [], "a cancelled chapter is not left in the queue to retry");
  assert.equal(host.error, null, "the user asked for this, so it is not an error banner");
});

test("deleting a download removes the row, the pages, and the object URLs", async () => {
  const { store, host, engine, created, revoked } = rig();
  engine.enqueue("s1", chapter("ch1", 1));
  await engine.whenIdle();
  const local = await engine.local("ch1");
  assert.equal(local.urls.length, 5);

  await engine.remove("ch1");
  assert.deepEqual(await store.listDownloads(), []);
  assert.deepEqual(await store.allDownloadPages(), [], "no page rows are left behind");
  assert.equal(revoked.length, created.length, "every object URL was freed");
  assert.deepEqual(host.rows, []);
  assert.equal(await engine.local("ch1"), null);
});

test("deleting a series deletes every chapter of it and nothing else", async () => {
  const { store, engine } = rig();
  engine.enqueueMany("s1", [chapter("ch1", 1), chapter("ch2", 2)]);
  engine.enqueue("s2", { ...chapter("ch3", 3), seriesId: "s2" });
  await engine.whenIdle();
  assert.equal((await store.listDownloads()).length, 3);

  await engine.removeSeries("s1");
  const left = await store.listDownloads();
  assert.deepEqual(left.map((entry) => entry.chapterId), ["ch3"]);
  assert.equal((await store.allDownloadPages()).filter((entry) => entry.chapterId !== "ch3").length, 0);
});

test("an orphaned page row is freed on the next load instead of holding the bytes forever", async () => {
  const { store, engine } = rig();
  await store.putDownloadPage({ id: "ghost#0", chapterId: "ghost", index: 0, blob: new Blob([new Uint8Array(64)]) });
  await engine.load();
  assert.deepEqual(await store.allDownloadPages(), []);
});

test("fetch new takes what this device has never seen, fetch all also retries the broken ones", () => {
  const chapters = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const seen = {
    complete: new Set(["a"]),
    known: new Set(["a", "b"]),
    queued: new Set(["d"]),
  };
  assert.deepEqual(chaptersToFetch(chapters, seen, "new").map((c) => c.id), ["c"], "b already has a row");
  assert.deepEqual(chaptersToFetch(chapters, seen, "all").map((c) => c.id), ["b", "c"], "d is already queued");
  assert.deepEqual(chaptersToFetch([], seen, "all"), []);
});

test("the count reads as issues grabbed of issues known", () => {
  assert.equal(grabbedLabel(3, 12), "3 of 12 issues");
  assert.equal(grabbedLabel(1, 1), "1 of 1 issue");
  assert.equal(grabbedLabel(0, 5), "0 of 5 issues");
  assert.equal(grabbedLabel(4), "4 issues", "no list means no total, not a guess");
  assert.equal(grabbedLabel(7, 5), "7 of 7 issues", "never fewer than what is here");
  assert.deepEqual(grabbedOf(2, undefined), { grabbed: 2, total: null });
  assert.deepEqual(grabbedOf(Number.NaN, 4), { grabbed: 0, total: 4 });
});

test("the search box matches the series as well as the chapter", () => {
  assert.ok(matchesDownloadQuery("berserk", "Berserk", "Chapter 1"));
  assert.ok(matchesDownloadQuery("chap", "Berserk", "Chapter 1"));
  assert.ok(matchesDownloadQuery("", "Berserk", "Chapter 1"), "empty is everything");
  assert.ok(!matchesDownloadQuery("vinland", "Berserk", "Chapter 1"));
  assert.ok(matchesDownloadQuery("berserk", undefined, "Berserk chapter 3"), "a missing title is not a match killer");
});

test("a chapter deleted while it is downloading stays deleted", async () => {
  // The confirmation promises to free the chapters it names. A running chapter is in neither `rows`
  // nor `queue` — the run takes it out of the queue before starting — so a delete that looked only
  // at those two lists left it alone, and its own write a moment later put the chapter and its pages
  // back, taking the space the dialog said it had reclaimed.
  const store = new LibraryStore(memoryDatabase());
  const host = { rows: [], queue: [], active: null, error: null };
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const engine = new DownloadEngine(host, {
    store,
    pages: async () => {
      await gate; // still downloading while the delete happens
      return [page(0), page(1)];
    },
    fetchBlob: async () => new Blob([new Uint8Array(10)]),
  });
  engine.enqueueMany("s1", [chapter("ch1", 1)]);
  for (let attempt = 0; attempt < 50 && host.active === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(host.active.chapterId, "ch1", "nothing was downloading");

  await engine.removeSeries("s1");
  release();
  await engine.whenIdle();

  assert.deepEqual(await store.listDownloads(), [], "the deleted chapter came back");
  assert.deepEqual(await store.downloadPageMeta("ch1"), [], "its pages were left behind");
});
