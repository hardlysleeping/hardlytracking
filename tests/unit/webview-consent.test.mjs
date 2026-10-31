import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONSENT_DETAIL,
  consentKey,
  consentQuestion,
  describeGrant,
  grantConsent,
  isGranted,
  normaliseDomain,
  revokeConsent,
} from "../../src/lib/webview/consent.ts";

test("a grant is one source on one domain", () => {
  assert.equal(consentKey("2499283573021220255", "Example.COM"), "2499283573021220255|example.com");
  assert.equal(normaliseDomain("  .Example.com:443 "), "example.com");

  const empty = [];
  assert.equal(isGranted(empty, "a", "example.com"), false);

  const one = grantConsent(empty, "a", "Example.com", 1000);
  assert.equal(isGranted(one, "a", "example.com"), true, "the host is compared, not the spelling");
  assert.equal(isGranted(one, "b", "example.com"), false, "another source is another question");
  assert.equal(isGranted(one, "a", "other.com"), false, "another domain is another question");
});

test("yes is idempotent, and the first answer keeps its time", () => {
  const once = grantConsent([], "a", "example.com", 1000);
  const twice = grantConsent(once, "a", "example.com", 2000);
  assert.equal(twice.length, 1);
  assert.equal(twice[0].at, 1000, "re-tapping Allow is not a new decision");
});

test("a no can be one domain or the whole source", () => {
  const grants = [
    ...grantConsent(grantConsent([], "a", "one.com", 1), "a", "two.com", 2),
    ...grantConsent([], "b", "one.com", 3),
  ];
  assert.equal(revokeConsent(grants, "a", "one.com").length, 2);
  assert.equal(isGranted(revokeConsent(grants, "a", "one.com"), "a", "one.com"), false);
  assert.equal(isGranted(revokeConsent(grants, "a", "one.com"), "a", "two.com"), true);

  const dropped = revokeConsent(grants, "a");
  assert.equal(dropped.length, 1, "uninstalling a source takes every grant it had");
  assert.equal(dropped[0].sourceId, "b");
});

test("the question names the domain, and the detail says what is kept", () => {
  assert.equal(consentQuestion("Example.com"), "Allow this source to use cookies for example.com?");
  assert.match(CONSENT_DETAIL, /kept on this device/);
  assert.match(CONSENT_DETAIL, /Refusing keeps the source working/);
  assert.equal(describeGrant({ sourceId: "a", domain: "example.com", at: 1 }), "a — example.com");
});
