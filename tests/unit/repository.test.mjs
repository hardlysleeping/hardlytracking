import assert from "node:assert/strict";
import test from "node:test";

test("index.min.json is a stub now, so its sibling index.json is tried first", async () => {
  const { candidateIndexUrls } = await import("../../src/lib/extensions/repository.ts");
  assert.deepEqual(
    candidateIndexUrls("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"),
    [
      "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json",
      "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
    ],
  );
});

test("any other named index file is still taken at its word", async () => {
  const { candidateIndexUrls } = await import("../../src/lib/extensions/repository.ts");
  assert.deepEqual(candidateIndexUrls("https://example.test/custom-index.json"), ["https://example.test/custom-index.json"]);
});
