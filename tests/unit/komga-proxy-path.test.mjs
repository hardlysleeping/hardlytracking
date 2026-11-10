/**
 * Which address a `/api/komga/…` request is asking about.
 *
 * A Komga is not always at the root of a host: `https://example.com/komga` behind a reverse proxy is
 * an ordinary install, and the packaged app talks to those directly (no proxy involved). The browser
 * build does go through this route, so it has to keep the base's **path** as well as its origin —
 * dropping the path sent `/api/v1/users/me` to the proxy root, which answers 404 from whatever else
 * is served there, with a correct login and no way to tell what went wrong.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { komgaTarget } from "../../server/komga-target.mjs";
import { encodeBase64Url } from "../../src/lib/komga.ts";

test("a Komga at the root of a private host is forwarded with the path asked for", () => {
  const target = komgaTarget(`/api/komga/${encodeBase64Url("http://192.168.1.9:25600")}/api/v1/users/me`);
  assert.equal(target.url, "http://192.168.1.9:25600/api/v1/users/me");
});

test("a Komga under a reverse-proxy path keeps it", () => {
  const base = "http://192.168.1.9:25600/komga";
  const target = komgaTarget(`/api/komga/${encodeBase64Url(base)}/api/v1/libraries?page=0`);
  assert.equal(
    target.url,
    "http://192.168.1.9:25600/komga/api/v1/libraries?page=0",
    "the base's path is part of the address, not noise",
  );
});

test("a base path with a trailing slash does not double it", () => {
  const base = "http://192.168.1.9:25600/komga/";
  const target = komgaTarget(`/api/komga/${encodeBase64Url(base)}/api/v1/libraries`);
  assert.equal(target.url, "http://192.168.1.9:25600/komga/api/v1/libraries");
});

test("a public host is still refused, path or not", () => {
  const refused = komgaTarget(`/api/komga/${encodeBase64Url("https://komga.example.org/comics")}/api/v1/users/me`);
  assert.equal(refused.status, 403);
  assert.equal(refused.url, undefined);
});
