import { test } from "node:test";
import assert from "node:assert/strict";
import { base64ToBlob, nameFromPath, pathFromFileUrl } from "../../src/lib/files/opened.ts";

test("an iCloud file URL becomes a path, spaces and all", () => {
  assert.equal(
    pathFromFileUrl("file:///private/var/mobile/Library/Mobile%20Documents/Saga%20v01.cbz"),
    "/private/var/mobile/Library/Mobile Documents/Saga v01.cbz",
  );
});

test("anything that is not a file URL is left alone", () => {
  // A deep link or a web address handed to the app must not be read as a comic.
  assert.equal(pathFromFileUrl("mihon://series/12"), null);
  assert.equal(pathFromFileUrl("https://example.com/a.cbz"), null);
});

test("a stray percent sign does not lose the file", () => {
  assert.equal(pathFromFileUrl("file:///tmp/100%.cbz"), "/tmp/100%.cbz");
});

test("the name is the last path segment, not the whole path", () => {
  assert.equal(nameFromPath("/a/b/My Comic v1.cbz"), "My Comic v1.cbz");
  assert.equal(nameFromPath("/a/b/"), "b");
});

test("base64 from the filesystem plugin becomes the exact bytes", async () => {
  const original = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff]);
  const base64 = Buffer.from(original).toString("base64");
  const blob = base64ToBlob(base64, "application/zip");
  assert.equal(blob.type, "application/zip");
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), original);
});
