import { test } from "node:test";
import assert from "node:assert/strict";
import { pairFromLocation, pairingLink } from "../../src/lib/host.ts";

test("a pairing link carries the host and the token", () => {
  const plain = pairFromLocation("http://10.0.0.10:8470/?token=s3cret");
  assert.equal(plain.token, "s3cret");
  assert.equal(plain.host, null, "same-origin: the host is implied");

  const remote = pairFromLocation("http://phone.local/?host=http%3A%2F%2F10.0.0.10%3A8470&token=abc");
  assert.equal(remote.host, "http://10.0.0.10:8470");
  assert.equal(remote.token, "abc");

  // The hash form works too, because the router owns the hash.
  const hashed = pairFromLocation("http://phone.local/#/library?host=http%3A%2F%2F10.0.0.10%3A8470&token=abc");
  assert.equal(hashed.host, "http://10.0.0.10:8470");
  assert.equal(hashed.token, "abc");

  assert.deepEqual(pairFromLocation("http://phone.local/#/library"), { host: null, token: null });
});

test("the phone link uses the first address and includes the token only when there is one", () => {
  const info = {
    host: "0.0.0.0",
    port: 8470,
    serving: true,
    tokenRequired: true,
    addresses: [
      { name: "wlp6s0", address: "10.0.0.10" },
      { name: "tailscale0", address: "100.114.238.95" },
    ],
    runtime: "http://127.0.0.1:4567",
    dalvik: "http://127.0.0.1:8792",
  };
  assert.equal(pairingLink(info, "s3cret"), "http://10.0.0.10:8470/?token=s3cret");
  assert.equal(pairingLink(info, ""), "http://10.0.0.10:8470/");
  assert.equal(pairingLink({ ...info, addresses: [] }, "x"), null, "no address, no link");
});
