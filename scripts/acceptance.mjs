/**
 * The desktop acceptance gate (TEST-04, `#30`).
 *
 *   npm run accept
 *
 * Runs the three fixtures the card names — the pane fixture, the reader matrix and the SQLite
 * storage benchmark — plus the browser shelf bench, and checks the five acceptance criteria against
 * what they measured:
 *
 *   1. ≥ 55 fps during normal grid scrolling          `perf/bench.html` (Chromium, scripted 2 s scroll)
 *   2. no multi-second UI freeze                      every interaction's worst case < 1 000 ms
 *   3. picking another title does not move the shelf  the pane fixture's own check
 *   4. the first reader page does not wait on writes  the reader's load order, asserted from source
 *                                                    and by `tests/unit/reader-matrix.test.mjs`
 *   5. no page is blank without state/error/retry     the per-page markers, and the reader/retry tests
 *
 * It refuses to call a run "passed" on numbers it could not take: a missing browser is reported as
 * `unavailable` with its reason, and the exit code says the gate is incomplete rather than green.
 *
 * Nothing here touches a real library: the SQLite benchmark writes a temp database, and the browser
 * fixtures generate their own titles.
 *
 * Environment:
 *   BASE                dev server to use; one is started (and stopped) when absent
 *   PLAYWRIGHT_MODULE   path to Playwright's index.mjs, when it is not resolvable as `playwright`
 *   PERF_SERIES, …      forwarded to `scripts/library-perf-sqlite.mjs`
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;
const LOADER = ["--experimental-strip-types", "--import", "./tests/unit/register-ts.mjs"];

/** The card's own numbers. */
const FPS_MIN = 55;
const FREEZE_MS = 1_000;
/**
 * A tap that still feels like a tap. The index made this 0.10–1.29 ms p95 on a 48 000-chapter
 * library, down from ~130 ms, so the bound sits at 50 ms: loose enough for a loaded CI box, tight
 * enough that a return to the old per-chapter pass fails here instead of on the phone.
 */
const SELECTION_P95_MS = 50;
/** A cold start that is not a wait; measured at ~176 ms. */
const COLD_OPEN_MAX_MS = 1_500;

const gates = [];
const fixtures = {};

function gate(name, requirement, measured, pass) {
  gates.push({ name, requirement, measured, pass });
  const text = typeof measured === "object" ? JSON.stringify(measured) : String(measured);
  console.log(`${pass ? "ok  " : "FAIL"} ${name.padEnd(46)} ${text}`);
}

async function run(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (code) => resolve({ code, out, err }));
  });
}

/** A dev server of our own, so the browser fixtures never depend on a stray terminal. */
async function withServer(run_) {
  if (process.env.BASE !== undefined) return await run_(process.env.BASE.replace(/\/$/, ""));
  const { createServer } = await import("vite");
  const vite = await createServer({
    configFile: join(ROOT, "vite.config.ts"),
    server: { port: 0, host: "localhost" },
    logLevel: "error",
  });
  try {
    await vite.listen();
    const base = (vite.resolvedUrls?.local?.[0] ?? `http://localhost:${vite.config.server.port}`).replace(/\/$/, "");
    return await run_(base);
  } finally {
    await vite.close();
  }
}

const results = {
  card: "TEST-04 (#30)",
  measuredAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    cpus: cpus().map((cpu) => cpu.model).slice(0, 2),
    cpuCount: cpus().length,
    browser: "Chromium (headless Playwright)",
    webkit: "not run: libicudata.so.74 is missing on this host, so Playwright's WebKit cannot launch",
    engine: "src/lib/db/sqlite.ts over node:sqlite (the Tauri plugin's IPC hop is not measured)",
  },
  thresholds: { FPS_MIN, FREEZE_MS, SELECTION_P95_MS, COLD_OPEN_MAX_MS },
  gates,
  fixtures,
};

let incomplete = false;

/* ---- 1. the SQLite storage benchmark ------------------------------------------------------- */

console.log("\n— storage: populated SQLite library —");
const perf = await run(NODE, [...LOADER, "scripts/library-perf-sqlite.mjs"]);
fixtures.sqlite = { code: perf.code, tail: perf.out.trim().split("\n").slice(-12).join("\n") };
if (perf.code !== 0) {
  incomplete = true;
  gate("SQLite benchmark ran", "exit 0", perf.code, false);
  console.log(perf.err);
} else {
  const baseline = JSON.parse(readFileSync(join(ROOT, "perf", "sqlite-baseline.json"), "utf8"));
  results.storage = baseline;
  const m = baseline.measurements;
  gate("cold Library open", `< ${COLD_OPEN_MAX_MS} ms`, `${m.coldOpen.p50} ms (p95 ${m.coldOpen.p95})`, m.coldOpen.p50 < COLD_OPEN_MAX_MS);
  gate("pane selection", `< ${SELECTION_P95_MS} ms p95`, `${m.paneSelection.p95} ms`, m.paneSelection.p95 < SELECTION_P95_MS);
  gate("series selection", `< ${SELECTION_P95_MS} ms p95`, `${m.seriesSelection.p95} ms`, m.seriesSelection.p95 < SELECTION_P95_MS);
  gate("reader first page (device copy)", "< 200 ms p95", `${m.readerPage1.p95} ms`, m.readerPage1.p95 < 200);
  const worst = Math.max(m.coldOpen.max, m.paneSelection.max, m.seriesSelection.max, m.readerPage1.max, m.scrollP95.max);
  gate("no multi-second freeze (storage)", `< ${FREEZE_MS} ms worst case`, `${worst.toFixed(1)} ms`, worst < FREEZE_MS);
}

/* ---- 2. reader + page state, from the tests the card names --------------------------------- */

console.log("\n— reader: provider/fallback matrix and per-page retry —");
const readerTests = await run(NODE, [
  "--experimental-strip-types",
  "--experimental-test-module-mocks",
  "--import",
  "./tests/unit/register-ts.mjs",
  "--test",
  "--test-force-exit",
  "tests/unit/reader-matrix.test.mjs",
  "tests/unit/page-retry.test.mjs",
]);
fixtures.reader = { code: readerTests.code, tail: readerTests.out.trim().split("\n").slice(-6).join("\n") };
gate("reader matrix + page retry pass", "exit 0", readerTests.code, readerTests.code === 0);
if (readerTests.code !== 0) console.log(`${readerTests.out}\n${readerTests.err}`);

const readerSource = readFileSync(join(ROOT, "src", "views", "Reader.svelte"), "utf8");
const paintsFirst = readerSource.indexOf("busy = false");
const savesPlace = readerSource.indexOf("library.remember(");
const historyFirst = readerSource.indexOf("recordHistory(");
gate(
  "the first page paints before the place is saved",
  "busy = false before remember()/history",
  { busy: paintsFirst, remember: savesPlace, history: historyFirst },
  paintsFirst > 0 && savesPlace > paintsFirst && (historyFirst === -1 || historyFirst > paintsFirst),
);
const markers = {
  loading: /data-loading=\{loading\[page\.index\] === true/.test(readerSource),
  failed: /class="pageerror" role="alert" data-page-error=\{page\.index\}/.test(readerSource),
  retry: /Retry page \{page\.index \+ 1\}/.test(readerSource),
  missing: /Page \{page\.index \+ 1\} is not on this device/.test(readerSource),
  empty: /This chapter has no pages\./.test(readerSource),
  stored: /data-pages="stored"/.test(readerSource),
};
gate("every page state is visible", "loading/failed/retry/missing/empty/stored", markers, Object.values(markers).every(Boolean));

/* ---- 3. the browser fixtures --------------------------------------------------------------- */

const candidates = [
  process.env.PLAYWRIGHT_MODULE,
  "/home/bazzite/apps/ada-bot/node_modules/playwright/index.mjs",
].filter((value) => value !== undefined && existsSync(value));
const playwrightModule = candidates[0];

if (playwrightModule === undefined) {
  incomplete = true;
  gate("browser fixtures available", "Playwright resolvable", "unavailable", false);
  results.browser = { status: "unavailable", reason: "no Playwright module; set PLAYWRIGHT_MODULE" };
} else {
  await withServer(async (base) => {
    results.base = base;

    // 3a. the shelf bench: fps, first paint, and the worst frame.
    console.log(`\n— browser: shelf bench at ${base} —`);
    const bench = await run(NODE, [join(ROOT, "scripts", "bench-read.mjs")], {
      env: { BASE: base, PLAYWRIGHT_MODULE: playwrightModule, BENCH_ROWS: process.env.BENCH_ROWS ?? "5000" },
    });
    if (bench.code !== 0) {
      incomplete = true;
      gate("shelf bench ran", "exit 0", bench.code, false);
      console.log(bench.err.split("\n").slice(-6).join("\n"));
    } else {
      const numbers = JSON.parse(bench.out.trim().split("\n").at(-1));
      fixtures.bench = numbers;
      const p95 = numbers.frames.length === 0 ? 0 : [...numbers.frames].sort((a, b) => a - b)[Math.floor(numbers.frames.length * 0.95)];
      gate("grid scrolling keeps its frames", `≥ ${FPS_MIN} fps`, `${numbers.fps.toFixed(0)} fps`, numbers.fps >= FPS_MIN);
      gate("no long frame during the scroll", `< ${FREEZE_MS} ms`, `${numbers.worstFrame.toFixed(1)} ms`, numbers.worstFrame < FREEZE_MS);
      results.bench = { fps: numbers.fps, firstPaintMs: numbers.firstPaint, p95FrameMs: p95, worstFrameMs: numbers.worstFrame, frames: numbers.frames.length };
    }

    // 3b. the pane fixture, whose own checks include the shelf-scroll invariant.
    console.log("\n— browser: three panes —");
    const panes = await run(NODE, [join(ROOT, "tests", "manual", "panes-window.mjs")], {
      env: { BASE: base, PLAYWRIGHT_MODULE: playwrightModule },
    });
    fixtures.panes = { code: panes.code, tail: panes.out.trim().split("\n").slice(-3).join("\n") };
    gate("pane fixture passes", "all checks", panes.code, panes.code === 0);
    if (panes.code !== 0) console.log(panes.out);
    const keepLine = panes.out.split("\n").find((line) => line.includes("picking another title does not move the shelf"));
    gate("picking a title leaves the shelf where it was", "ok", keepLine?.trim() ?? "not reported", keepLine?.startsWith("ok") === true);

    // 3c. the windowed shelf, which is what makes 5 000 rows scroll at all.
    console.log("\n— browser: windowed shelf —");
    const shelf = await run(NODE, [join(ROOT, "tests", "manual", "shelf-window.mjs"), "chromium"], {
      env: { BASE: base, PLAYWRIGHT_MODULE: playwrightModule },
    });
    fixtures.shelf = { code: shelf.code, tail: shelf.out.trim().split("\n").slice(-3).join("\n") };
    gate("windowed shelf fixture passes", "all checks", shelf.code, shelf.code === 0);
    if (shelf.code !== 0) console.log(shelf.out);
  });
}

/* ---- the report ---------------------------------------------------------------------------- */

const failed = gates.filter((entry) => entry.pass === false).length;
results.failed = failed;
results.incomplete = incomplete;
results.status = failed > 0 ? "failed" : incomplete ? "incomplete" : "passed";

console.log(`\n${gates.length - failed} of ${gates.length} gates passed${incomplete ? " (run incomplete)" : ""} — ${results.status}`);
mkdirSync(join(ROOT, "perf"), { recursive: true });
const out = join(ROOT, "perf", "acceptance.json");
writeFileSync(
  out,
  `${JSON.stringify(
    {
      ...results,
      fixtures: Object.fromEntries(
        Object.entries(fixtures).map(([name, value]) => [name, { code: value.code, tail: value.tail }]),
      ),
      // The bench's frame array is the one bulky field; the summary above keeps what a gate reads.
      bench: results.bench,
      temp: tmpdir(),
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out}`);
process.exitCode = failed > 0 ? 1 : incomplete ? 2 : 0;