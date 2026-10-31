import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  THIRD_PARTY_DECISION,
  THIRD_PARTY_DISCLOSURE,
  THIRD_PARTY_NOTICE,
} from "../../src/lib/extensions/disclosure.ts";

test("the disclosure says the three things that make it a disclosure", () => {
  assert.match(THIRD_PARTY_DISCLOSURE, /not developed or maintained by HardlyTracking/);
  assert.match(THIRD_PARTY_DISCLOSURE, /Support for an extension goes to whoever publishes it/);
  assert.match(THIRD_PARTY_DISCLOSURE, /not to this app's issues/);
  assert.match(THIRD_PARTY_DISCLOSURE, /not what they do with your data/);
});

test("it makes no claim about a source's content, because it cannot", () => {
  assert.match(THIRD_PARTY_DISCLOSURE, /we provide no information about them/);
  assert.doesNotMatch(THIRD_PARTY_DISCLOSURE, /safe|verified|trusted|approved/i);
});

test("the decision line keeps the disclosure from reading as a bare warning", () => {
  assert.match(THIRD_PARTY_DECISION, /Nothing is installed until you tap Add Repository/);
  assert.match(THIRD_PARTY_DECISION, /disabled or uninstalled/);
});

test("the short notice and the long one agree about who maintains nothing", () => {
  assert.match(THIRD_PARTY_NOTICE, /not maintained by HardlyTracking/);
  assert.equal(THIRD_PARTY_NOTICE.length < THIRD_PARTY_DISCLOSURE.length, true);
});

test("README publishes the same promise the app does", async () => {
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  assert.match(readme, /## Third-party sources/);
  assert.match(readme, /not developed or maintained by the\s+HardlyTracking developers/);
  assert.match(readme, /Support for an extension goes to the person who publishes it/);
  assert.match(readme, /not offered in\s+this repository's issues/);
  assert.match(readme, /nothing is added until \*\*Add Repository\*\* is tapped/);
});
