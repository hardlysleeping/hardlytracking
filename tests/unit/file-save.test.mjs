/**
 * Where an exported backup actually goes.
 *
 * The export built a Blob, clicked a link and told the reader it had saved a file. In a browser tab
 * that is true; in a WebView it is a false claim, because neither WKWebView (iOS) nor a Tauri window
 * without a download handler writes anything to disk. A backup that says "saved" and is not is the
 * worst failure this screen can have.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { bytesToBase64, describeSaved, fileNameFromPath, saveFile } from "../../src/lib/files/save.ts";

test("bytes become base64 without blowing the argument limit", () => {
  // 200 000 bytes: `String.fromCharCode(...bytes)` throws at this size, chunking does not.
  const bytes = new Uint8Array(200_000);
  for (let at = 0; at < bytes.length; at += 1) bytes[at] = at % 256;
  const base64 = bytesToBase64(bytes);
  const decoded = Buffer.from(base64, "base64");
  assert.equal(decoded.length, bytes.length);
  assert.deepEqual([...decoded.subarray(0, 5)], [0, 1, 2, 3, 4]);
});

test("a saved file is described by where it landed, not by 'done'", () => {
  assert.match(describeSaved({ where: "documents", path: "/var/mobile/Documents/backup.json" }), /Documents folder/);
  assert.match(describeSaved({ where: "documents", path: "/var/mobile/Documents/backup.json" }), /backup\.json/);
  assert.match(describeSaved({ where: "downloads", path: "/home/me/Downloads/backup.json" }), /Downloads folder/);
  assert.match(describeSaved({ where: "browser", path: "backup.json" }), /downloads/);
});

test("a path is reduced to its own file name", () => {
  assert.equal(fileNameFromPath("/a/b/c/backup.json"), "backup.json");
  assert.equal(fileNameFromPath("backup.json"), "backup.json");
});

test("a native shell writes through its Filesystem plugin, not through a link", async () => {
  const written = [];
  globalThis.Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      Filesystem: {
        writeFile: async (options) => {
          written.push(options);
          return { uri: `file:///Documents/${options.path}` };
        },
      },
    },
  };
  try {
    const bytes = new TextEncoder().encode('{"hello":true}');
    const saved = await saveFile("backup.json", bytes, "application/json");
    assert.equal(saved.where, "documents");
    assert.equal(saved.path, "file:///Documents/backup.json");
    assert.equal(written.length, 1);
    assert.equal(written[0].directory, "DOCUMENTS");
    assert.equal(written[0].path, "backup.json");
    assert.equal(Buffer.from(written[0].data, "base64").toString("utf8"), '{"hello":true}');
  } finally {
    delete globalThis.Capacitor;
  }
});

test("the backup screen exports through the save seam, and nothing else", () => {
  const backup = readFileSync(new URL("../../src/views/Backup.svelte", import.meta.url), "utf8");
  assert.match(backup, /await saveFile\(file\.filename, file\.bytes, file\.mime\)/);
  assert.match(backup, /describeSaved\(saved\)/, "the notice does not say where the file went");
  assert.doesNotMatch(backup, /createObjectURL/, "the blob-anchor path is back");
});