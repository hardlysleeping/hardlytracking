/**
 * The app's own repository, before its index exists.
 *
 * `ensurePinnedRepo` seeds `hardlysleeping/hardlytracking-extensions` on every boot, and the
 * Extensions screen opens the first repository without being asked. Until the portable packages ship
 * that address answers 404, so the seeded row met the reader as
 *
 *   could not read a repository index from …/repo/index.json — tried …/repo/index.json → 404
 *
 * on a screen with nothing they could do about it. A 404 from every candidate is not a broken
 * repository, it is an address with nothing at it; a mixed answer (one 404, one not-JSON) is a
 * repository that is there and wrong, and stays an error.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { isMissingIndex, loadRepository } from "../../src/lib/extensions/repository.ts";
import { OFFICIAL_REPO_INDEX_URL } from "../../src/lib/extensions/pinned-repo.ts";

const missing = async () => new Response("not found", { status: 404 });

test("every candidate answering 404 is a missing index, not a failure", async () => {
  const error = await loadRepository(OFFICIAL_REPO_INDEX_URL, { fetchImpl: missing }).then(
    () => null,
    (e) => e,
  );
  assert.notEqual(error, null, "a 404 must not load");
  assert.equal(isMissingIndex(error), true);
  assert.equal(error.message, `could not read a repository index from ${OFFICIAL_REPO_INDEX_URL}`);
});

test("a repository root with both names missing is a missing index too", async () => {
  const error = await loadRepository("https://example.test/repo", { fetchImpl: missing }).then(
    () => null,
    (e) => e,
  );
  assert.equal(isMissingIndex(error), true);
  assert.equal(error.tried.length, 2, "both published names were tried");
});

test("an index that is there but unreadable stays an error", async () => {
  let call = 0;
  const mixed = async () => {
    call += 1;
    // 404 for index.json, HTML for index.min.json: something is published, and it is not an index.
    return call === 1 ? new Response("not found", { status: 404 }) : new Response("<html>", { status: 200 });
  };
  const error = await loadRepository("https://example.test/repo", { fetchImpl: mixed }).then(
    () => null,
    (e) => e,
  );
  assert.equal(isMissingIndex(error), false, "a mixed answer is not a missing index");
});

test("anything that is not a repository error is not a missing index", () => {
  assert.equal(isMissingIndex(new Error("network down")), false);
  assert.equal(isMissingIndex(null), false);
  assert.equal(isMissingIndex(undefined), false);
});
