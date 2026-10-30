import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFetchableRepo,
  repoFromLocation,
  repoFromQuery,
} from "../../src/lib/deep-link.ts";
import { candidateIndexUrls, parseInstallLink } from "../../src/lib/extensions/repository.ts";

const PB = "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb";

test("an install link yields the repository URL inside it", () => {
  assert.equal(parseInstallLink(`mihon://extension-store?url=${PB}`), PB);
  assert.equal(parseInstallLink(`tachiyomi://extension-store?url=${encodeURIComponent(PB)}`), PB);
  assert.equal(parseInstallLink(`komikku://extension-store?url=${PB}&x=1`), PB);
  // A root, an index URL and a GitHub blob URL are all accepted as typed.
  assert.equal(parseInstallLink("https://raw.githubusercontent.com/keiyoushi/extensions/repo"), "https://raw.githubusercontent.com/keiyoushi/extensions/repo");
  assert.equal(parseInstallLink(PB), PB);
  assert.equal(
    parseInstallLink("https://github.com/keiyoushi/extensions/blob/repo/index.pb"),
    "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb",
  );
  assert.equal(parseInstallLink("   "), "");
  assert.equal(parseInstallLink("mihon://extension-store"), "");
});

test("a protobuf index link tries its JSON siblings before giving up", () => {
  assert.deepEqual(candidateIndexUrls(`mihon://extension-store?url=${PB}`), [
    "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.json",
    "https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json",
    PB,
  ]);
});

test("a JSON index URL is taken at its word, a root gets both names", () => {
  assert.deepEqual(candidateIndexUrls("https://example.test/repo/index.min.json"), ["https://example.test/repo/index.min.json"]);
  assert.deepEqual(candidateIndexUrls("https://example.test/repo/"), [
    "https://example.test/repo/index.json",
    "https://example.test/repo/index.min.json",
  ]);
  assert.deepEqual(candidateIndexUrls(""), []);
});

test("an app URL can carry the repository in the hash or the query", () => {
  assert.equal(repoFromLocation(`http://127.0.0.1:8460/?repo=${encodeURIComponent(PB)}`), PB);
  assert.equal(repoFromLocation(`http://127.0.0.1:8460/#/extensions?repo=${encodeURIComponent(PB)}`), PB);
  assert.equal(repoFromLocation("http://127.0.0.1:8460/#/library"), null);
  assert.equal(repoFromQuery("?url=https%3A%2F%2Fx.test%2Fr"), "https://x.test/r");
  assert.equal(repoFromQuery(""), null);
});

test("only http(s) repositories are fetchable", () => {
  assert.equal(isFetchableRepo(PB), true);
  assert.equal(isFetchableRepo("mihon://extension-store?url=x"), false);
  assert.equal(isFetchableRepo("file:///etc/passwd"), false);
  assert.equal(isFetchableRepo("not a url"), false);
});
