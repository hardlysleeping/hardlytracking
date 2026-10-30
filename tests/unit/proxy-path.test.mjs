import assert from "node:assert/strict";
import test from "node:test";

import { upstreamPath } from "../../server/upstream-path.mjs";

const MIHON = /^\/api\/mihon/;
const DALVIK = /^\/api\/dalvik/;

test("the Mihon prefix becomes the runtime's own /api prefix", () => {
  assert.equal(upstreamPath("/api/mihon/graphql", MIHON, "/api"), "/api/graphql");
  assert.equal(upstreamPath("/api/mihon/v1/manga/12/page/0", MIHON, "/api"), "/api/v1/manga/12/page/0");
});

test("the dalvik prefix is dropped, because that host serves at the root", () => {
  assert.equal(upstreamPath("/api/dalvik/dalvik", DALVIK), "/dalvik");
  assert.equal(upstreamPath("/api/dalvik/image/abc", DALVIK), "/image/abc");
});

test("a path that does not carry the prefix is passed through untouched", () => {
  assert.equal(upstreamPath("/v1/manga/1", MIHON, "/api"), "/v1/manga/1");
});
