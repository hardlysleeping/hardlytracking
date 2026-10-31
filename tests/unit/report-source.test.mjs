import { test } from "node:test";
import assert from "node:assert/strict";

import {
  REPORT_ADDRESS,
  REPORT_REASONS,
  reportActionLabel,
  reportMailto,
  reportSubject,
  sourceReport,
} from "../../src/lib/report/source.ts";

const target = {
  name: "Example",
  pkg: "ing.example",
  version: "1.4.2",
  repo: "https://example.invalid/repo/index.min.json",
  sources: 3,
};

test("a report names the package, not just the name", () => {
  assert.equal(reportSubject(target), "Report source: Example (ing.example)");
  const report = sourceReport(target, "adult", "", 0);
  assert.match(report.body, /^Source: Example$/m);
  assert.match(report.body, /^Package: ing\.example$/m, "two indexes can ship one name");
  assert.match(report.body, /^Version: 1\.4\.2$/m);
  assert.match(report.body, /^Repository: https:\/\/example\.invalid/m);
  assert.match(report.body, /^Reason: Adult content not declared$/m);
  assert.match(report.body, /^Reported from HardlyTracking on 1970/m);
});

test("a source installed from a file says so instead of showing a blank", () => {
  const report = sourceReport({ ...target, repo: null }, "broken");
  assert.match(report.body, /Repository: not from a repository \(installed from a file\)/);
});

test("a note is included only when there is one", () => {
  assert.doesNotMatch(sourceReport(target, "other").body, /What happened/);
  const withNote = sourceReport(target, "other", "  every page is a redirect  ");
  assert.match(withNote.body, /What happened:\nevery page is a redirect/);
});

test("every reason has a label, and an unknown one still produces a report", () => {
  assert.deepEqual(
    REPORT_REASONS.map((r) => r.id),
    ["adult", "broken", "malicious", "licensing", "other"],
  );
  const odd = sourceReport(target, "not-a-reason");
  assert.match(odd.body, /Reason: Something else/);
});

test("with no address configured the report is copied, and the screen says so", () => {
  assert.equal(REPORT_ADDRESS, null, "an invented mailbox would make the button lie");
  const report = sourceReport(target, "adult");
  assert.equal(reportMailto(report), null);
  assert.equal(reportActionLabel(report), "Copy report");
  assert.equal(reportActionLabel(null), "Copy report");
});
