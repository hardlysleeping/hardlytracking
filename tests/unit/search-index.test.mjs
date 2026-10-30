import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEARCH_CACHE_TTL_MS,
  isFresh,
  scoreRow,
  searchCacheKey,
  searchRows,
  tokenize,
} from "../../src/lib/search/index.ts";

const rows = [
  { title: "One Piece", author: "Oda" },
  { title: "Berserk", author: "Miura" },
  { title: "Piece of Cake", author: "Someone" },
  { title: "Oda's Interviews", author: "Oda" },
];

test("a title that starts with the query outranks a title that merely contains it", () => {
  const found = searchRows(rows, "piece").map((row) => row.title);
  assert.deepEqual(found, ["Piece of Cake", "One Piece"]);
});

test("an author match is found, but below a title match", () => {
  const found = searchRows(rows, "oda").map((row) => row.title);
  assert.deepEqual(found, ["Oda's Interviews", "One Piece"]);
});

test("scoring is prefix friendly and never negative", () => {
  assert.ok(scoreRow({ title: "One Piece" }, "one") > 0);
  assert.ok(scoreRow({ title: "One Piece" }, "piece") > 0);
  assert.equal(scoreRow({ title: "Berserk" }, "zzz"), 0);
  assert.equal(scoreRow({ title: "Berserk" }, "   "), 0);
});

test("tokens drop punctuation and stopwords, and keep unicode words", () => {
  assert.deepEqual(tokenize("The One-Piece, Vol. 2"), ["one", "piece"]);
  assert.deepEqual(tokenize("Yūzōnō"), ["yūzōnō"]);
});

test("cached source answers are keyed per source and per query, and go stale", () => {
  assert.equal(searchCacheKey("dalvik:src:1", "One Piece"), "dalvik:src:1\u0000one piece");
  const cached = { key: "k", sourceId: "s", query: "q", items: [], at: 1000 };
  assert.equal(isFresh(cached, 1000 + SEARCH_CACHE_TTL_MS - 1), true);
  assert.equal(isFresh(cached, 1000 + SEARCH_CACHE_TTL_MS + 1), false);
});
