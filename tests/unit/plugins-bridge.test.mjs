import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENTS,
  MAX_MESSAGE_BYTES,
  METHODS,
  errorOf,
  newChannel,
  pluginDocument,
  readEnvelope,
  responseOf,
} from "../../src/plugins/bridge.ts";

const CONTEXT = { channel: "a".repeat(32), pluginId: "dev.example.reader-tools" };

function request(overrides = {}) {
  return { channel: CONTEXT.channel, plugin: CONTEXT.pluginId, kind: "request", id: "r1", method: "library.getSeries", params: { id: "mihon:1" }, ...overrides };
}

test("a well-formed request is accepted and its method is one the host knows", () => {
  const result = readEnvelope(request(), CONTEXT);
  assert.equal(result.ok, true);
  assert.equal(result.message.method, "library.getSeries");
  assert.deepEqual(result.message.params, { id: "mihon:1" });
});

test("a JSON string is accepted; the host does not require one shape on the wire", () => {
  const result = readEnvelope(JSON.stringify(request()), CONTEXT);
  assert.equal(result.ok, true);
  assert.equal(result.message.id, "r1");
});

test("a message on another channel is refused — the channel is the instance identity", () => {
  const result = readEnvelope(request({ channel: "b".repeat(32) }), CONTEXT);
  assert.equal(result.ok, false);
  assert.equal(result.problem, "wrong_channel");
});

test("a message naming another plugin is refused", () => {
  const result = readEnvelope(request({ plugin: "dev.example.impostor" }), CONTEXT);
  assert.equal(result.ok, false);
  assert.equal(result.problem, "wrong_plugin");
});

test("an unknown method is refused rather than forwarded to the host", () => {
  for (const method of ["fetch", "eval", "library.delete", "parent.postMessage", "__proto__"]) {
    const result = readEnvelope(request({ method }), CONTEXT);
    assert.equal(result.ok, false, `${method} should be refused`);
    assert.equal(result.problem, "unknown_method");
  }
});

test("an unknown kind and a missing id are refused", () => {
  assert.equal(readEnvelope(request({ kind: "command" }), CONTEXT).problem, "unknown_kind");
  assert.equal(readEnvelope(request({ id: undefined }), CONTEXT).problem, "missing_id");
  assert.equal(readEnvelope(request({ method: undefined }), CONTEXT).problem, "missing_method");
});

test("a response needs no method, and an event must be one the host pushes", () => {
  const response = readEnvelope({ channel: CONTEXT.channel, plugin: CONTEXT.pluginId, kind: "response", id: "r1", ok: true, result: 1 }, CONTEXT);
  assert.equal(response.ok, true);

  const goodEvent = readEnvelope({ channel: CONTEXT.channel, plugin: CONTEXT.pluginId, kind: "event", event: "library.opened" }, CONTEXT);
  assert.equal(goodEvent.ok, true);
  assert.equal(goodEvent.message.event, "library.opened");

  const badEvent = readEnvelope({ channel: CONTEXT.channel, plugin: CONTEXT.pluginId, kind: "event", event: "os.shell" }, CONTEXT);
  assert.equal(badEvent.ok, true, "the envelope is still valid…");
  assert.equal(badEvent.message.event, undefined, "…but the unknown event name is dropped");
});

test("an oversized payload is refused before it is parsed", () => {
  const huge = "x".repeat(MAX_MESSAGE_BYTES + 10);
  const asString = readEnvelope(JSON.stringify({ ...request(), params: { blob: huge } }), CONTEXT);
  assert.equal(asString.ok, false);
  assert.equal(asString.problem, "too_large");

  const asObject = readEnvelope({ ...request(), params: { blob: huge } }, CONTEXT);
  assert.equal(asObject.ok, false);
  assert.equal(asObject.problem, "too_large");
});

test("garbage is refused, not thrown on", () => {
  for (const value of [null, undefined, 42, [], "{oops", Symbol("x")]) {
    const result = readEnvelope(value, CONTEXT);
    assert.equal(result.ok, false);
  }
});

test("an error message is truncated, and a response cannot carry an unknown field", () => {
  const envelope = errorOf(CONTEXT, "r1", "e".repeat(2_000));
  assert.equal(envelope.error.length, 500);

  const echoed = readEnvelope(
    { ...request(), evil: "payload", __proto__: { polluted: true } },
    CONTEXT,
  );
  assert.equal(echoed.ok, true);
  assert.equal("evil" in echoed.message, false);
  assert.equal({}.polluted, undefined, "a message cannot pollute a prototype");
});

test("a channel is 128 bits of randomness, and two are never the same", () => {
  const one = newChannel();
  const two = newChannel();
  assert.match(one, /^[0-9a-f]{32}$/);
  assert.notEqual(one, two);
});

test("a response echoes the request's id", () => {
  const envelope = responseOf(CONTEXT, "r9", { title: "T" });
  assert.equal(envelope.kind, "response");
  assert.equal(envelope.id, "r9");
  assert.deepEqual(envelope.result, { title: "T" });
});

test("every method either needs no permission or names one that exists", () => {
  const allowed = new Set(["library.read", "plugin.storage", "ui.series", "ui.reader", "ui.library", "events.library"]);
  for (const [method, permission] of Object.entries(METHODS)) {
    if (permission === null) continue;
    assert.ok(allowed.has(permission), `${method} names an unknown permission ${permission}`);
  }
  assert.deepEqual([...EVENTS], ["library.opened", "library.added", "library.removed"]);
});

test("the plugin document is sandboxed by CSP: no network, no frames, no navigation", () => {
  const html = pluginDocument({
    channel: CONTEXT.channel,
    pluginId: CONTEXT.pluginId,
    apiVersion: 1,
    source: "ht.ui.toast('hi');",
  });
  const csp = /content="([^"]+)"/.exec(html)?.[1] ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-src 'none'/);
  assert.match(csp, /form-action 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.doesNotMatch(csp, /https?:/);
  assert.doesNotMatch(csp, /allow-same-origin/);
});

test("the document carries the instance's channel, and only its own source", () => {
  const html = pluginDocument({
    channel: CONTEXT.channel,
    pluginId: CONTEXT.pluginId,
    apiVersion: 1,
    source: "globalThis.marker = 'plugin-code';",
  });
  assert.ok(html.includes(CONTEXT.channel), "the bootstrap must know its channel");
  assert.ok(html.includes("globalThis.marker = 'plugin-code';"));
  assert.equal(html.split("<script>").length - 1, 2, "one bootstrap, one plugin script");
});

test("a plugin id cannot break out of the document it is named in", () => {
  const html = pluginDocument({
    channel: CONTEXT.channel,
    pluginId: "</title><script>alert(1)</script>",
    apiVersion: 1,
    source: "",
  });
  assert.equal(html.includes("</title><script>alert(1)"), false);
  assert.match(html, /&lt;\/title&gt;/);
});

test("the bootstrap refuses a message whose source is not its parent", () => {
  // The check is in the generated code; assert it is there rather than pretending to run a frame.
  const html = pluginDocument({ channel: CONTEXT.channel, pluginId: CONTEXT.pluginId, apiVersion: 1, source: "" });
  assert.match(html, /event\.source !== parent/);
  assert.match(html, /message\.channel !== CHANNEL/);
  assert.match(html, /parent\.postMessage/);
});
