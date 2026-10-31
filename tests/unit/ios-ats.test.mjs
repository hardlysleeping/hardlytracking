/**
 * The App Store networking gate: ATS is narrowed, not disabled.
 *
 * `docs/app-store-release-checklist.md` §7 asks for the blanket `NSAllowsArbitraryLoads` to be
 * replaced by the exceptions the app actually needs — the loopback runtime, Komga and the HT-Server
 * — and for that to stay true. A plist is the one file in this repo where a one-line edit can undo
 * a review answer silently, so this test reads the real `ios/App/App/Info.plist` and pins the shape.
 *
 * What it refuses, and why each one matters:
 *
 * - `NSAllowsArbitraryLoads` (or the media / web-content variants) set to true: the blanket allow is
 *   back, and App Review asks for a justification the app cannot give — every public host it talks
 *   to is https.
 * - an exception domain that is not loopback or a private range: a public name here is either a
 *   hardcoded server or a hole. Remote sources do not need one; the extension runtime fetches them
 *   with its own Java HTTP stack, which ATS does not govern.
 * - a private-range entry missing `NSExceptionAllowsInsecureHTTPLoads`: from iOS 17 ATS refuses IP
 *   connections by default, so the entry would exist and still block the request.
 * - anything else inside an exception dictionary (`NSExceptionMinimumTLSVersion`,
 *   `NSExceptionRequiresForwardSecrecy`): an exception is a permission, not a place to relax more.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const PLIST = join(here, "..", "..", "ios", "App", "App", "Info.plist");

/**
 * A reader for the plist subset Apple uses here: dict, array, key, string, integer, true, false.
 * Node ships no XML parser and a plist is not JSON, so this walks the tokens instead of adding a
 * dependency for one file. Comments, the XML declaration and the doctype are skipped.
 */
function readPlist(xml) {
  const tokens = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([A-Za-z]+)\s*>|<([A-Za-z]+)\s*\/>|<([A-Za-z]+)[^>]*>|([^<]+)/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const [, close, empty, open, text] = match;
    if (close !== undefined) tokens.push({ kind: "close", name: close });
    else if (empty !== undefined) tokens.push({ kind: "empty", name: empty });
    else if (open !== undefined) tokens.push({ kind: "open", name: open });
    else if (text !== undefined && text.trim() !== "") tokens.push({ kind: "text", text: text.trim() });
  }

  let at = 0;
  const peek = () => tokens[at];
  const take = () => tokens[at++];

  function value() {
    const token = take();
    assert.ok(token !== undefined, "plist ended early");
    if (token.kind === "open" && token.name === "dict") {
      const out = {};
      for (;;) {
        const next = peek();
        if (next === undefined) assert.fail("unclosed <dict>");
        if (next.kind === "close" && next.name === "dict") {
          take();
          return out;
        }
        const key = take();
        assert.equal(key.kind, "open", `expected <key>, saw ${JSON.stringify(key)}`);
        assert.equal(key.name, "key", `expected <key>, saw <${key.name}>`);
        const name = take();
        assert.equal(name.kind, "text", "a <key> carries no value");
        assert.equal(out[name.text], undefined, `duplicate key ${name.text}`);
        assert.equal(take().name, "key", "a <key> closes immediately");
        out[name.text] = value();
      }
    }
    if (token.kind === "open" && token.name === "array") {
      const out = [];
      for (;;) {
        const next = peek();
        if (next === undefined) assert.fail("unclosed <array>");
        if (next.kind === "close" && next.name === "array") {
          take();
          return out;
        }
        out.push(value());
      }
    }
    if (token.kind === "empty" && token.name === "true") return true;
    if (token.kind === "empty" && token.name === "false") return false;
    if (token.kind === "open" && token.name === "string") {
      const text = take();
      assert.equal(take().name, "string", "a <string> closes after its text");
      return text.kind === "text" ? text.text : "";
    }
    if (token.kind === "open" && token.name === "integer") {
      const text = take();
      assert.equal(take().name, "integer", "an <integer> closes after its digits");
      return Number(text.text);
    }
    assert.fail(`unsupported plist element ${JSON.stringify(token)}`);
  }

  const first = take();
  assert.ok(first.kind === "open" && first.name === "plist", "not a plist");
  const root = value();
  return root;
}

const plist = readPlist(readFileSync(PLIST, "utf8"));
const ats = plist.NSAppTransportSecurity;

/** Loopback, RFC 1918, the tailnet's CGNAT range and its IPv6 ULA — nothing else. */
const PRIVATE_V4 = [
  [ip4("127.0.0.0"), 8],
  [ip4("10.0.0.0"), 8],
  [ip4("172.16.0.0"), 12],
  [ip4("192.168.0.0"), 16],
  [ip4("100.64.0.0"), 10],
];
const PRIVATE_V6 = ["::1", "fd7a:115c:a1e0::/48", "fc00::/7"];

function ip4(text) {
  const parts = text.split(".");
  assert.equal(parts.length, 4, `${text} is not an IPv4 address`);
  // Multiplication, not `<<`: a 32-bit shift wraps at 2^31 and 172.16.0.0 crosses it.
  return parts.reduce((acc, part) => acc * 256 + Number(part), 0) >>> 0;
}

/** Whether a plist domain key is a name or range the app is allowed to have an exception for. */
function isLocalOrPrivate(key) {
  if (key === "localhost" || key.endsWith(".local")) return true;
  if (PRIVATE_V6.includes(key)) return true;
  const [address, prefixText] = key.split("/");
  if (address.includes(":")) return false;
  const prefix = prefixText === undefined ? 32 : Number(prefixText);
  const net = ip4(address);
  return PRIVATE_V4.some(([base, basePrefix]) => {
    const mask = basePrefix === 0 ? 0 : (0xffffffff << (32 - basePrefix)) >>> 0;
    // The entry must sit inside a private block *and* be no wider than it, or "0.0.0.0/0" in
    // private clothing would pass. `>>> 0` because `&` answers a signed 32-bit int and 172.x
    // does not fit in one.
    return ((net & mask) >>> 0) === base && prefix >= basePrefix;
  });
}

test("ATS is not globally disabled", () => {
  assert.ok(ats !== undefined, "Info.plist has no NSAppTransportSecurity");
  for (const key of ["NSAllowsArbitraryLoads", "NSAllowsArbitraryLoadsForMedia", "NSAllowsArbitraryLoadsInWebContent"]) {
    assert.notEqual(ats[key], true, `${key} is a blanket allow; §7 exists to remove it`);
  }
});

test("local networking is declared, which is what exempts .local and unqualified names", () => {
  assert.equal(ats.NSAllowsLocalNetworking, true);
});

test("the loopback runtime has an exception, because /dalvik and /image are plain http on 127.0.0.1", () => {
  const domains = ats.NSExceptionDomains;
  assert.ok(domains !== undefined, "no NSExceptionDomains");
  for (const host of ["127.0.0.1", "::1", "localhost"]) {
    assert.equal(domains[host]?.NSExceptionAllowsInsecureHTTPLoads, true, `${host} is not exempt`);
  }
});

test("Komga and the HT-Server are covered by private ranges, not by a public name", () => {
  const domains = Object.keys(ats.NSExceptionDomains);
  for (const key of domains) {
    assert.ok(isLocalOrPrivate(key), `${key} is not loopback or a private range`);
  }
  // iOS 17 refuses IP connections by default, so a Komga at 192.168.1.20 needs the range listed.
  for (const range of ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10"]) {
    assert.equal(ats.NSExceptionDomains[range]?.NSExceptionAllowsInsecureHTTPLoads, true, `${range} is not exempt`);
  }
});

test("an exception grants insecure http and nothing else", () => {
  for (const [host, entry] of Object.entries(ats.NSExceptionDomains)) {
    assert.deepEqual(
      Object.keys(entry).sort(),
      ["NSExceptionAllowsInsecureHTTPLoads"],
      `${host} relaxes more than plain http`,
    );
  }
});

test("NSLocalNetworkUsageDescription is accurate, so the prompt names what is being reached", () => {
  const text = plist.NSLocalNetworkUsageDescription;
  assert.equal(typeof text, "string");
  assert.ok(text.length > 20, "the prompt string is too short to explain anything");
  assert.match(text, /Komga/, "the app reaches Komga, and the prompt says so");
  assert.match(text, /PC/, "the HT-Server is a PC, and the prompt says so");
});
