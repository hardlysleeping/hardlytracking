import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { extractZip, listZip, readZipEntry } from "../../scripts/zip.mjs";
import { javaRelativePath, platformKey } from "../../scripts/prepare-runtime.mjs";

/** A zip of `entries` ([name, data, deflate?]) — enough of the format for the reader to parse. */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, data, deflate = false] of entries) {
    const body = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const nameBytes = Buffer.from(name, "utf8");
    const crc = 0; // the reader does not verify it, and computing it here would test nothing
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE(offset, 42);

    locals.push(local, nameBytes, body);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("entries are listed with their method and sizes", () => {
  const zip = buildZip([
    ["jre/jre/bin/java", Buffer.from("#!/bin/sh\n"), false],
    ["MExtensionServer-v1.0.9-r1.jar", Buffer.alloc(2048, 7), true],
  ]);
  const entries = listZip(zip);
  assert.deepEqual(
    entries.map((entry) => [entry.name, entry.method, entry.size]),
    [
      ["jre/jre/bin/java", 0, 10],
      ["MExtensionServer-v1.0.9-r1.jar", 8, 2048],
    ],
  );
  assert.deepEqual(readZipEntry(zip, entries[0]), Buffer.from("#!/bin/sh\n"));
  assert.equal(readZipEntry(zip, entries[1]).length, 2048);
});

test("a strip of one turns the bundle's jre/jre into jre", () => {
  const zip = buildZip([["jre/jre/bin/java", Buffer.from("x")], ["MExtensionServer.jar", Buffer.from("y")]]);
  const written = [];
  const dir = join(tmpdir(), `ht-zip-${process.pid}-${Date.now()}`);
  extractZip(zip, dir, {
    filter: (path) => path.startsWith("jre/"),
    strip: 1,
    writeFile: (path, data) => {
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, data);
      written.push([path.slice(dir.length + 1), data.toString()]);
    },
    mkdir: () => {},
  });
  assert.deepEqual(written, [["jre/bin/java", "x"]]);
  assert.ok(existsSync(join(dir, "jre", "bin", "java")));
  assert.equal(readFileSync(join(dir, "jre", "bin", "java"), "utf8"), "x");
});

test("an archive is data from the internet, so a path that climbs out is refused", () => {
  const zip = buildZip([["../../.ssh/authorized_keys", Buffer.from("nope")]]);
  assert.throws(
    () => extractZip(zip, "/tmp/ht-zip-unsafe", { writeFile: () => assert.fail("must not write"), mkdir: () => {} }),
    /unsafe path/,
  );
  const absolute = buildZip([["/etc/passwd", Buffer.from("nope")]]);
  assert.throws(() => extractZip(absolute, "/tmp/ht-zip-unsafe", { writeFile: () => {}, mkdir: () => {} }), /unsafe path/);
});

test("a truncated download is not an archive, and says so", () => {
  assert.throws(() => listZip(Buffer.alloc(100)), /end-of-central-directory/);
});

test("each platform maps to its own bundle, and the JVM has the name that platform uses", () => {
  assert.equal(platformKey("win32", "x64"), "windows-x64");
  assert.equal(platformKey("linux", "x64"), "linux-x64");
  assert.equal(platformKey("darwin", "arm64"), "macos-arm64");
  assert.equal(platformKey("darwin", "x64"), "macos-x64");
  assert.equal(platformKey("linux", "arm64"), null, "no Linux arm64 bundle is published");
  assert.equal(platformKey("freebsd", "x64"), null);

  assert.equal(javaRelativePath("win32"), "jre/bin/java.exe");
  assert.equal(javaRelativePath("linux"), "jre/bin/java");
  assert.equal(javaRelativePath("darwin"), "jre/bin/java");
});
