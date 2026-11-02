import { test } from "node:test";
import assert from "node:assert/strict";
import { komgaProxyPath, komgaTarget, privateHost } from "../../server/komga-target.mjs";
import { encodeBase64Url, komgaUrl } from "../../src/lib/komga.ts";

const b64 = (value) => Buffer.from(value, "utf8").toString("base64url");

test("a Komga on this machine is proxied to the path the page asked for", () => {
  const routed = komgaTarget(`/api/komga/${b64("http://127.0.0.1:25600")}/api/v1/series`, "?page=0&size=40");
  assert.equal(routed.url, "http://127.0.0.1:25600/api/v1/series?page=0&size=40");
});

test("a LAN, tailnet or .local address is accepted — those are the servers people run", () => {
  for (const base of ["http://192.168.1.20:25600", "http://100.101.102.103:25600", "http://komga.local:25600", "https://10.0.0.5"]) {
    const routed = komgaTarget(`/api/komga/${b64(base)}/api/v1/libraries`);
    assert.equal(routed.url, `${base.replace(/\/$/, "")}/api/v1/libraries`, base);
  }
});

test("a public Komga is refused: those do not need the proxy, and this must not be an open one", () => {
  const routed = komgaTarget(`/api/komga/${b64("https://komga.example.com")}/api/v1/libraries`);
  assert.equal(routed.status, 403);
  assert.match(routed.error, /your own network/);
  assert.equal(privateHost("komga.example.com"), false);
  assert.equal(privateHost("8.8.8.8"), false);
});

test("a path that tries to leave the origin stays on it", () => {
  // `new URL("//evil.example/x", base)` would swap the host; the path is appended instead.
  const routed = komgaTarget(`/api/komga/${b64("http://127.0.0.1:25600")}//evil.example/steal`);
  assert.equal(routed.url, "http://127.0.0.1:25600//evil.example/steal");
});

test("junk in the address is a plain 400, not a crash", () => {
  assert.equal(komgaTarget("/api/komga/").status, 400);
  assert.equal(komgaTarget(`/api/komga/${b64("not a url")}/x`).status, 400);
  assert.equal(komgaTarget(`/api/komga/${b64("file:///etc/passwd")}/x`).status, 400);
});

test("the client's proxy path and the server's parser agree", () => {
  const path = komgaProxyPath("http://127.0.0.1:25600", "/api/v1/books/b-1/pages");
  assert.equal(path, `/api/komga/${b64("http://127.0.0.1:25600")}/api/v1/books/b-1/pages`);
  assert.equal(komgaTarget(path).url, "http://127.0.0.1:25600/api/v1/books/b-1/pages");
});

test("in the page every Komga URL is proxied; in a packaged build it is not", () => {
  assert.equal(
    komgaUrl("http://127.0.0.1:25600", "/api/v1/series", true),
    `/api/komga/${b64("http://127.0.0.1:25600")}/api/v1/series`,
  );
  assert.equal(komgaUrl("http://127.0.0.1:25600/", "/api/v1/series", false), "http://127.0.0.1:25600/api/v1/series");
  assert.equal(komgaUrl("http://h:1", "api/v1/x", false), "http://h:1/api/v1/x", "a missing slash is added");
});

test("the base64 in the path is URL-safe with no padding", () => {
  const encoded = encodeBase64Url("http://192.168.1.20:25600");
  assert.equal(/[+/=]/.test(encoded), false);
  assert.equal(Buffer.from(encoded, "base64url").toString("utf8"), "http://192.168.1.20:25600");
});
