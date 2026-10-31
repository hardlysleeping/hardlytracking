import { test } from "node:test";
import assert from "node:assert/strict";

import {
  THIRD_PARTY_NOTICE,
  ecosystemLabel,
  ecosystemOf,
  packagesLabel,
  proposalOf,
} from "../../src/lib/extensions/proposal.ts";

test("an index names its ecosystem only when the filename really says", () => {
  assert.equal(ecosystemOf("https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.min.json"), "mihon");
  assert.equal(ecosystemOf("https://example.invalid/repo/index.json"), "mihon");
  assert.equal(ecosystemOf("https://example.invalid/repo/index.pb"), "mihon");
  assert.equal(ecosystemOf("https://example.invalid/repo/versioning.json"), "paperback");
  // index.min.json is published by Aidoku too; the honest answer is the format this build reads.
  assert.equal(ecosystemOf("https://example.invalid/somewhere/index.min.json?x=1"), "mihon");
  assert.equal(ecosystemOf("https://example.invalid/repo/extension.json"), "unknown");
  assert.equal(ecosystemOf("not a url"), "unknown");
});

test("each ecosystem is named in words, and unknown does not pretend", () => {
  assert.match(ecosystemLabel("mihon"), /Mihon \/ Keiyoushi/);
  assert.match(ecosystemLabel("paperback"), /Paperback/);
  assert.equal(ecosystemLabel("unknown"), "Extension repository");
});

test("a proposal carries what a person needs to say yes or no", () => {
  const proposal = proposalOf({
    url: "https://example.invalid/repo",
    indexUrl: "https://example.invalid/repo/index.min.json",
    name: "Example",
    extensions: [{ pkg: "a" }, { pkg: "b" }, { pkg: "c" }],
  });

  assert.equal(proposal.name, "Example");
  assert.equal(proposal.host, "example.invalid", "the host is the part a person recognises");
  assert.equal(proposal.packages, 3);
  assert.equal(proposal.ecosystem, "mihon");
  assert.equal(proposal.url, "https://example.invalid/repo", "the URL that would be stored");
  assert.equal(proposal.notice, THIRD_PARTY_NOTICE);
  assert.match(proposal.notice, /not maintained by HardlyTracking/);
});

test("counts read as words, never as \"1 packages\"", () => {
  assert.equal(packagesLabel(1), "1 package");
  assert.equal(packagesLabel(2), "2 packages");
  assert.equal(packagesLabel(0), "no packages");
  assert.equal(packagesLabel(-3), "no packages");
});
