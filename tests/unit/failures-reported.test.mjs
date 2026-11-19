/**
 * A control that can fail says so.
 *
 * Every screen here had the same shape of defect: a `void`ed promise with no `catch`, so a rejected
 * write left the old state on screen, the sheet closed as if it had worked, and nothing was said.
 * The phone has no console and no reload; a tap that fails and says nothing is a tap that looks
 * ignored, and the reader tries it again.
 *
 * These are source checks on purpose. The failure they guard against is the *absence* of a handler,
 * which no unit of behaviour can show — the suite's fake stores answer, and the real ones only fail
 * on a device whose storage is full or locked.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

const trackers = read("src/components/TrackersPanel.svelte");
const downloads = read("src/views/Downloads.svelte");
const extensions = read("src/views/Extensions.svelte");
const historyPanel = read("src/components/HistorySettingsPanel.svelte");
const libraryView = read("src/views/Library.svelte");
const messages = read("src/views/Messages.svelte");
const updates = read("src/views/Updates.svelte");
const addFiles = read("src/components/AddFiles.svelte");
const welcome = read("src/components/Welcome.svelte");
const migrate = read("src/components/MigrateSheet.svelte");
const syncAccount = read("src/components/SyncAccount.svelte");
const paneState = read("src/state/reader-pane.svelte.ts");
const search = read("src/views/Search.svelte");

/** The body of one named function, so a `catch` in a neighbour cannot answer for it. */
function bodyOf(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.ok(start >= 0, `${name} is not there`);
  const next = source.indexOf("\n  async function ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

test("a tracker that could not be disconnected stays connected, and says why", () => {
  const disconnect = bodyOf(trackers, "disconnect");
  assert.match(disconnect, /catch \(problem\)/, "a rejected removal escaped as an unhandled rejection");
  assert.match(disconnect, /error = problem instanceof Error/, "the card kept saying Connected with no reason");
  // The account is still stored, so clearing it here would be the lie, not the fix.
  assert.doesNotMatch(disconnect.split("catch")[1] ?? "", /connected = null/, "a failed removal cleared the card");
});

test("a delete that fails leaves the row and says so", () => {
  for (const name of ["removeRow", "removeGroup"]) {
    const body = bodyOf(downloads, name);
    assert.match(body, /catch \(problem\)/, `${name} had no catch`);
    assert.match(body, /notice = `Could not delete/, `${name} failed silently`);
  }
});

test("an extension or repository that could not be removed says so", () => {
  assert.match(bodyOf(extensions, "uninstall"), /catch \(problem\)/, "a failed uninstall closed the dialog as if it worked");
  assert.match(bodyOf(extensions, "remove"), /catch \(problem\)/, "a refused repository removal looked like a dead button");
  assert.match(extensions, /\{#if error\}<p class="banner">\{error\}<\/p>\{\/if\}/, "nothing draws the error");
});

test("clearing history reports its own failure, and retention says how much it removed", () => {
  const clear = bodyOf(historyPanel, "clearNow");
  assert.match(clear, /catch \(problem\)/, "a rejected clear left the confirm up with no explanation");
  assert.match(clear, /failed = `Could not delete/, "the failure is not named");
  assert.match(historyPanel, /\{#if failed !== null\}[\s\S]{0,120}role="alert"/, "the failure is never drawn");
  // Changing the retention setting deletes what is already past it; that is what it means, so the
  // count has to be said rather than the log quietly shrinking.
  assert.match(historyPanel, /Removed \$\{removed\} session\$\{removed === 1/);
  assert.match(historyPanel, /void prune\(/);
});

test("a bulk remove in the library asks twice, and a failure does not leave the rest untouched in silence", () => {
  const remove = bodyOf(libraryView, "bulkRemove");
  assert.match(remove, /catch \(problem\)/, "a throw mid-loop aborted the set with nothing said");
  assert.match(remove, /removeError = `Stopped removing/);
  assert.match(libraryView, /confirmingRemove = true/, "the first tap removed the selection outright");
  assert.match(libraryView, /Remove \{selection\.size\} from library/, "the second tap does not say what it will do");
  assert.match(libraryView, /\{#if removeError !== null\}<p class="hint" role="alert">/, "the failure is never drawn");
});

test("a build with no account service does not tell the reader to sign in", () => {
  const unavailable = messages.indexOf("!inbox.available");
  const signedOut = messages.indexOf("!inbox.signedIn");
  assert.ok(unavailable >= 0, "nothing reads `inbox.available`");
  assert.ok(unavailable < signedOut, "the sign-in paragraph still answers a project-less build");
  assert.match(messages, /built without one|no account service configured/);
});

test("an outage is not a quiet week on Updates, and a queued download shows it", () => {
  assert.match(updates, /library\.updatesFailed > 0/, "a skipped title looked like a quiet one");
  assert.match(updates, /could not be reached, so this list is not everything/);
  assert.match(updates, /library\.updatesFailed >= asked/, "an all-failed check still said nothing was new");
  // The arrow used to stay enabled and unchanged for the whole download.
  assert.match(updates, /downloads\.isDownloaded\(row\.chapter\.id\) \|\| downloads\.inQueue\(row\.chapter\.id\)/);
  assert.match(updates, /downloads\.inQueue\(row\.chapter\.id\) \? "…"/);
});

test("the folder button asks for a folder, and the welcome screen opens once a comic arrives", () => {
  // A `webkitdirectory` input is desktop-only; Android has to go through the system folder picker.
  assert.match(addFiles, /onclick=\{\(\) => void pickFolder\(\)\}/, "Add folder opened a single-file picker");
  assert.deepEqual(addFiles.match(/folderInput\?\.click\(\)/g) ?? [], ["folderInput?.click()"], "the input is clicked in more than one place");
  assert.match(addFiles, /if \(result\.added > 0\) onimport\?\.\(\)/, "an import never reports that it imported");
  assert.match(welcome, /onimport=\{\(\) => done\(\)\}/, "the welcome screen stayed up over the library it just imported");
});

test("migrate names the source it lands on, says when the list is cut, and when a preview failed", () => {
  assert.match(migrate, /mappingSourceId\(source\.id\)/, "a source id was fed to the series-id parser");
  assert.match(migrate, /catch \(problem\)[\s\S]{0,420}could not be checked/, "a failed preview left a dead end");
  assert.match(migrate, /results\.length > limit/, "twelve rows read as the whole source");
  assert.match(migrate, /Showing \{limit\} of \{results\.length\}/);
});

test("Check says it is checking, and cannot be tapped twice", () => {
  assert.match(syncAccount, /checking = true/);
  assert.match(syncAccount, /\{#if checking \|\| entitlementState === null\}/, "the row kept its old answer while a read was out");
  assert.match(syncAccount, /disabled=\{busy \|\| checking\}/);
});

test("Read only hands a chapter to a pane that is actually on screen", () => {
  assert.match(paneState, /get drawnNow\(\): boolean/);
  assert.match(paneState, /showsPane\(\): \(\) => void/);
  // The preference is not the layout: a narrow window degrades a split Library to one column, and
  // Browse and Source draw no pane at all.
  assert.match(paneState, /if \(allowPane && readerPane\.available && readerPane\.drawnNow\)/);
  assert.match(libraryView, /\$effect\(\(\) => readerPane\.showsPane\(\)\)/, "the library never says it can draw a pane");
  assert.match(search, /if \(!split\) return;\s*return readerPane\.showsPane\(\);/, "search claims a pane it does not draw");
});