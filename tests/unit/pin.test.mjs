// The screen-curtain PIN: a salted hash, defensive parsing, and a verification that only says yes
// to the digits that made the record. Synthetic codes only; nothing here touches a real library.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasPin,
  makePinRecord,
  parsePinRecord,
  pinRecordOf,
  pinValid,
  verifyPin,
} from "../../src/lib/pin.ts";
import { memoryDatabase } from "../../src/lib/db/open.ts";
import { LibraryStore } from "../../src/lib/db/store.ts";
import { documentFromStore } from "../../src/lib/sync/from-store.ts";
import { serializeSync, parseSync } from "../../src/lib/sync/document.ts";
import { applyDocument } from "../../src/lib/sync/apply.ts";

const PIN = "2468";

test("a PIN is 4 to 8 digits and nothing else", () => {
  for (const good of ["0000", "1234", "98765432", "55555"]) assert.equal(pinValid(good), true, good);
  for (const bad of ["", "1", "123", "123456789", "12a4", "12 34", " 1234", "1234 ", "00123\n", "-1234", "１２３４"]) {
    assert.equal(pinValid(bad), false, JSON.stringify(bad));
  }
  assert.equal(pinValid(2468), false, "only a string is a PIN");
  assert.equal(pinValid(null), false);
});

test("the stored record is sha256:salt:hash and never the PIN itself", async () => {
  const record = await makePinRecord(PIN);
  assert.match(record, /^sha256:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(record.length, 7 + 32 + 1 + 64, "fixed size: salt and hash, nothing appended");
  assert.equal(/^[0-9a-z:]+$/.test(record), true, "hex and separators only — the digits are not carried as text");

  // Salted: the same PIN makes a different record every time, so two devices' rows cannot be
  // compared to learn that the code is the same.
  const again = await makePinRecord(PIN);
  assert.notEqual(again, record);
  assert.notEqual(parsePinRecord(again)?.hash.join(","), parsePinRecord(record)?.hash.join(","));

  // And it is not a bare digest of the digits: the record is a domain-separated, salted hash.
  const bare = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(PIN)));
  const bareHex = [...bare].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  assert.equal(record.includes(bareHex), false);

  await assert.rejects(() => makePinRecord("123"), RangeError, "a malformed PIN is never stored");
});

test("verification accepts the code that made the record and nothing else", async () => {
  const record = await makePinRecord(PIN);
  assert.equal(await verifyPin(record, PIN), true);
  for (const wrong of ["0000", "2469", "246", "24680", "2468x"]) {
    assert.equal(await verifyPin(record, wrong), false, wrong);
  }
  // Another salt for the same PIN verifies too: the salt travels inside the record.
  const other = await makePinRecord(PIN);
  assert.equal(await verifyPin(other, PIN), true);
  assert.equal(await verifyPin(await makePinRecord("1111"), PIN), false);
});

test("corrupt or foreign records are 'no PIN', not a screen nobody can open", async () => {
  for (const value of [
    undefined,
    null,
    42,
    {},
    "",
    "garbage",
    "sha256::",
    "sha256:ab:cd",
    "md5:" + "aa".repeat(16) + ":" + "bb".repeat(32),
    "sha256:" + "zz".repeat(16) + ":" + "bb".repeat(32),
    "sha256:" + "aa".repeat(16) + ":" + "bb".repeat(31),
    "sha256:" + "a".repeat(33) + ":" + "bb".repeat(32),
    "sha256:" + "aa".repeat(16) + ":" + "bb".repeat(32) + ":extra",
  ]) {
    assert.equal(parsePinRecord(value), null, String(value));
    assert.equal(hasPin(value), false, String(value));
    assert.equal(pinRecordOf(value), "", String(value));
    assert.equal(await verifyPin(value, PIN), false, String(value));
  }

  // A foreign value in the preferences is dropped, so the app asks for a PIN instead of locking.
  assert.equal(pinRecordOf({ scheme: "sha256" }), "");
});

test("a recognised record is canonicalised, so uppercase hex and padding travel clean", async () => {
  const record = await makePinRecord(PIN);
  assert.equal(pinRecordOf(record), record);
  const [, salt, hash] = record.split(":");
  assert.equal(pinRecordOf(`  sha256:${salt.toUpperCase()}:${hash.toUpperCase()}  `), record);
  assert.equal(hasPin(record), true);
});

test("one PIN travels as a HardlySync preference, and the other device can verify it", async () => {
  const record = await makePinRecord(PIN);
  const store = new LibraryStore(memoryDatabase());
  await store.setPref("settings.privacyPin", record);

  const doc = await documentFromStore(store, { device: "dev-a", at: 1_700_000_000_000 });
  const row = doc.preferences.find((entry) => entry.key === "settings.privacyPin");
  assert.ok(row, "the PIN is an ordinary preference, so the document carries it");
  assert.equal(row.value, record, "the hash travels, never the digits");

  // Round-trip into a second device: the same PIN opens the same curtain there.
  const other = new LibraryStore(memoryDatabase());
  await applyDocument(other, parseSync(serializeSync(doc)));
  assert.equal(await other.getPref("settings.privacyPin"), record);
  assert.equal(await verifyPin(await other.getPref("settings.privacyPin"), PIN), true);
});
