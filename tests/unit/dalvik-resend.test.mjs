import { test } from "node:test";
import assert from "node:assert/strict";

import { DalvikClient, DalvikError, createDalvikProvider } from "../../src/api/dalvik.ts";

const SOURCE = "4508733312114627536";
const EXT = "abc123";
const APK = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

/** A client whose first call fails the way the runtime fails after it forgets an APK. */
function client(answer) {
  const calls = [];
  const client = new DalvikClient({ baseUrl: "http://runtime.test" });
  client.call = async (call) => {
    calls.push(call);
    const result = answer(call, calls.length);
    if (result instanceof Error) throw result;
    return { body: result, extensionId: EXT, setCookie: [] };
  };
  return { client, calls };
}

function providerWith(harness, apk) {
  return createDalvikProvider({
    client: harness.client,
    extensions: [{ extensionId: EXT, packageId: "pkg", sources: [{ id: SOURCE, name: "Komga" }], apk }],
  });
}

test("a runtime that forgot the APK is handed the bytes we kept, once", async () => {
  const harness = client((call, n) =>
    n === 1
      ? new DalvikError("Extension handle abc123 is no longer loaded; resend the APK", 500)
      : { mangas: [{ url: "/m/1", title: "One" }], hasNextPage: false },
  );
  const provider = providerWith(harness, APK.buffer.slice(0));
  const page = await provider.popular(`dalvik:src:${SOURCE}`, 1);
  assert.equal(page.items.length, 1);
  assert.equal(harness.calls.length, 2);
  assert.equal(harness.calls[0].data, undefined, "the first call carries no bytes");
  assert.equal(harness.calls[1].data, "UEsDBA==", "the retry carries the APK as base64");
});

test("any other failure is the caller's answer and is not retried", async () => {
  const harness = client(() => new DalvikError("HTTP error 401", 401));
  const provider = providerWith(harness, APK.buffer.slice(0));
  await assert.rejects(() => provider.popular(`dalvik:src:${SOURCE}`, 1), /401/);
  assert.equal(harness.calls.length, 1, "a login wall must not resend megabytes");
});

test("no kept bytes means no retry, and the runtime's own words reach the caller", async () => {
  const harness = client(() => new DalvikError("Extension handle abc123 is no longer loaded; resend the APK", 500));
  const provider = providerWith(harness, undefined);
  await assert.rejects(() => provider.popular(`dalvik:src:${SOURCE}`, 1), /resend the APK/);
  assert.equal(harness.calls.length, 1);
});
