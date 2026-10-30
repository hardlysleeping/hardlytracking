import assert from "node:assert/strict";
import test from "node:test";

import { parseSearch, matchesSearch, words, withoutOperator } from "../../src/lib/library/search.ts";

const SERIES = [
  { id: "a", provider: "local", title: "Berserk", author: "Kentaro Miura" },
  { id: "b", provider: "dalvik", title: "One Piece", author: "Eiichiro Oda" },
  { id: "c", provider: "dalvik", title: "Pluto", author: "Naoki Urasawa" },
];

test("a bare word matches a title or an author, case-insensitively", () => {
  assert.deepEqual(parseSearch("berserk").terms, ["berserk"]);
  assert.deepEqual(parseSearch("MIURA").terms, ["MIURA"], "the term keeps what was typed; matching is what ignores case");
  const found = parseSearch("miura");
  assert.deepEqual(SERIES.filter((series) => matchesSearch(found, series)).map((series) => series.id), ["a"]);
});

test("two words are AND, not OR", () => {
  const parsed = parseSearch("one oda");
  assert.deepEqual(SERIES.filter((series) => matchesSearch(parsed, series)).map((series) => series.id), ["b"]);
  assert.deepEqual(SERIES.filter((series) => matchesSearch(parseSearch("one urasawa"), series)), []);
});

test("source: folds into the filter the sheet reads, lowercased", () => {
  const parsed = parseSearch("source:MangaDex");
  assert.deepEqual(parsed.filter.sources, ["mangadex"]);
  assert.deepEqual(parsed.terms, [], "an operator is not also a word");
});

test("two source: operators collect into one list", () => {
  assert.deepEqual(parseSearch("source:local source:dalvik").filter.sources, ["local", "dalvik"]);
});

test("unread: and downloaded: are booleans in the same model", () => {
  assert.equal(parseSearch("unread:true").filter.unread, "unread");
  assert.equal(parseSearch("unread:false").filter.unread, "read");
  assert.equal(parseSearch("downloaded:true").filter.downloaded, true);
  assert.equal(parseSearch("downloaded:false").filter.notDownloaded, true);
  assert.equal(parseSearch("status:Completed").filter.statuses[0], "Completed");
});

test("scope:all overrides the toggle for one query", () => {
  assert.equal(parseSearch("pluto scope:all").scope, "all");
  assert.equal(parseSearch("pluto scope:collection").scope, undefined);
  assert.deepEqual(parseSearch("pluto scope:collection").terms, ["pluto", "scope:collection"], "an unknown value stays a word");
});

test("an unknown operator is a literal word, never dropped", () => {
  const parsed = parseSearch("title:berserk");
  assert.deepEqual(parsed.terms, ["title:berserk"]);
  assert.deepEqual(parsed.filter, {});
  assert.deepEqual(SERIES.filter((series) => matchesSearch(parsed, series)), [], "it searches for the text it was given");
});

test("a value that is not a boolean keeps the whole word", () => {
  assert.deepEqual(parseSearch("unread:maybe").terms, ["unread:maybe"]);
  assert.equal(parseSearch("unread:maybe").filter.unread, undefined);
});

test("a quoted phrase survives as one term, and an unclosed quote does not empty the grid", () => {
  assert.deepEqual(words('"one piece" oda'), ["one piece", "oda"]);
  assert.deepEqual(words('"one piece'), ["one", "piece"], "an unclosed quote is dropped, not searched for");
  const parsed = parseSearch('"one piece"');
  assert.deepEqual(SERIES.filter((series) => matchesSearch(parsed, series)).map((series) => series.id), ["b"]);
});

test("removing a chip's operator leaves every other word alone", () => {
  assert.equal(withoutOperator("berserk source:dalvik unread:true", "source:dalvik"), "berserk unread:true");
  assert.equal(withoutOperator("source:dalvik", "source:dalvik"), "");
  assert.equal(withoutOperator("unread:true berserk", "unread"), "berserk");
});
