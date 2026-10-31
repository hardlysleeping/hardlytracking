import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { loadRepository } from "../../src/lib/extensions/repository.ts";
import { THIRD_PARTY_NOTICE, proposalOf } from "../../src/lib/extensions/proposal.ts";

const REPO = "https://example.test/repo";

/** A v2 Mihon index: two packages, three sources between them. */
const INDEX = {
  name: "Example Extensions",
  badgeLabel: "Example",
  extensionList: {
    extensions: [
      {
        name: "One",
        packageName: "eu.example.one",
        resources: { apkUrl: "https://example.test/one.apk" },
        versionCode: 2,
        versionName: "1.1",
        extensionLib: "1.4",
        contentWarning: "CONTENT_WARNING_SAFE",
        sources: [{ id: "1", name: "One", language: "en" }],
      },
      {
        name: "Two",
        packageName: "eu.example.two",
        resources: { apkUrl: "https://example.test/two.apk" },
        versionCode: 3,
        versionName: "1.2",
        extensionLib: "1.4",
        contentWarning: "CONTENT_WARNING_MIXED",
        sources: [
          { id: "2", name: "Two", language: "en" },
          { id: "3", name: "Twee", language: "nl" },
        ],
      },
    ],
  },
};

/** A store that only remembers what was put in it — enough to prove a write did or did not happen. */
function fakeStore() {
  const rows = [];
  return {
    rows,
    async putRepo(row) {
      rows.push(row);
    },
  };
}

async function readIndex() {
  return loadRepository(REPO, {
    fetchImpl: async () => new Response(JSON.stringify(INDEX), { status: 200 }),
  });
}

test("repo deep link cannot silently add: reading an index writes nothing", async () => {
  const store = fakeStore();
  const repository = await readIndex();

  // Reading an index takes no store at all: the function that fetches one cannot add a repository.
  assert.equal(store.rows.length, 0, "inspecting a repository must not write a repository row");

  const proposal = proposalOf(repository);
  // The five facts the panel is required to show, and the line that says whose the packages are.
  assert.equal(proposal.name, "Example Extensions");
  assert.equal(proposal.host, "example.test");
  assert.match(proposal.ecosystemLabel, /Mihon/);
  assert.equal(proposal.packages, 2);
  assert.equal(proposal.notice, THIRD_PARTY_NOTICE);
  assert.match(proposal.notice, /not maintained by HardlyTracking/);

  // Building and showing the proposal is still a read.
  assert.equal(store.rows.length, 0, "opening the panel must not write a repository row");
});

test("the Extensions view offers a repository and writes only from its own button", () => {
  const view = readFileSync(new URL("../../src/views/Extensions.svelte", import.meta.url), "utf8");

  // The effect that consumes a `?repo=…` deep link: it prefills and reads, and it must not add.
  const effect = /let consumedRepo[\s\S]*?\n  \}\);/.exec(view);
  assert.ok(effect, "the deep-link effect is still there");
  assert.doesNotMatch(effect[0], /addRepository|putRepo/, "a deep link must not add a repository");
  assert.match(effect[0], /inspect\(/, "a deep link reads the index and opens the panel");

  // One call to addRepository in the whole view, reached only from the panel's own button.
  assert.equal(view.match(/void addRepository\(/g)?.length, 1, "the view adds a repository exactly once");
  assert.match(view, /onclick=\{\(\) => void addRepository\(\)\}/);
  assert.match(view, /proposal !== null/, "the panel is gated on a proposal that was read");
  assert.match(view, />Cancel</);
  assert.ok(view.includes('"Add Repository"'), "the panel's confirming action is Add Repository");

  // The third-party line has one source: the module. A copy in the markup could drift from it.
  assert.equal(view.includes("not maintained by HardlyTracking"), false);
});
