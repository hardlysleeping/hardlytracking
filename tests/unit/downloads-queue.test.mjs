import assert from "node:assert/strict";
import test from "node:test";


test("the queue is stored as plain data, because a rune proxy cannot be cloned", async () => {
  const { plainQueue } = await import("../../src/lib/downloads/state.ts");
  const proxy = new Proxy(
    [{ chapterId: "c1", seriesId: "s1", chapterName: "One", number: 1, state: "queued" }],
    {},
  );
  const plain = plainQueue(proxy);
  assert.deepEqual(plain, [{ chapterId: "c1", seriesId: "s1", chapterName: "One", number: 1, state: "queued" }]);
  // structuredClone is exactly what IndexedDB does: it refuses a proxy and accepts the copy.
  assert.throws(() => structuredClone(proxy), /could not be cloned|cannot be cloned/);
  assert.doesNotThrow(() => structuredClone(plain));
});
