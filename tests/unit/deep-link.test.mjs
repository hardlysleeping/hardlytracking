import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFetchableRepo,
  repoFromLocation,
  repoFromQuery,
  withoutLinkPayload,
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
  // `index.min.json` is the exception: live repositories publish it as an "outdated app" stub, so
  // the sibling that actually lists the extensions is tried first.
  assert.deepEqual(candidateIndexUrls("https://example.test/repo/index.min.json"), [
    "https://example.test/repo/index.json",
    "https://example.test/repo/index.min.json",
  ]);
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

test("an install link is consumed once, not kept in the address bar", () => {
  // Left in place, `repoFromLocation` re-reads it on every hash change and pulls the person back to
  // Extensions — and the first arrival never moved at all, because `go("/extensions")` on an address
  // that already says `#/extensions?repo=…` is no hash change.
  const quoted = "http://127.0.0.1:8460/?repo=" + encodeURIComponent(PB) + "#/extensions";
  // The result is what `history.replaceState` takes: same origin, path + query + hash.
  assert.equal(withoutLinkPayload(quoted), "/#/extensions");
  assert.equal(withoutLinkPayload("http://127.0.0.1:8460/#/extensions?repo=" + encodeURIComponent(PB)), "/#/extensions");
  // `url` is the same payload under its other name.
  assert.equal(withoutLinkPayload("http://x.test/?url=" + encodeURIComponent(PB)), "/");

  // Everything that is not the payload stays where it was.
  assert.equal(
    withoutLinkPayload("http://x.test/?pair=abc&repo=" + encodeURIComponent(PB) + "#/extensions?tab=available"),
    "/?pair=abc#/extensions?tab=available",
  );
  // An address with no link is returned unchanged, and the result never parses as a link again.
  assert.equal(withoutLinkPayload("http://x.test/#/library"), "/#/library");
  assert.equal(repoFromLocation(withoutLinkPayload(quoted)), null);
  assert.equal(repoFromLocation(withoutLinkPayload("http://x.test/#/extensions?repo=" + encodeURIComponent(PB))), null);
});
