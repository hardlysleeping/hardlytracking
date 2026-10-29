/**
 * Keeps the extension test matrix honest.
 *
 *   npm run matrix:check            # live index, real APK URLs
 *
 * It does not run extensions — it proves the matrix still describes reality:
 * every package still exists in the repository index, the recorded versionCode still
 * matches (or reports drift), the real source ids the matrix pins for library/backup
 * identity are still advertised, and every APK URL still returns a file.
 *
 * Exit 1 on a package that disappeared or an APK that does not resolve: a matrix row
 * nobody can test is worse than a missing row, because it reads as coverage.
 */
import { readFile } from "node:fs/promises";
import { parseIndex } from "../src/lib/extensions/index.ts";

const MATRIX = new URL("../docs/test-matrix.json", import.meta.url);
const matrix = JSON.parse(await readFile(MATRIX, "utf8"));
const indexUrl = process.env.MATRIX_INDEX ?? matrix.index;

const response = await fetch(indexUrl, { headers: { "User-Agent": "HardlyTracking-matrix-check" } });
if (!response.ok) {
  console.error(`index ${indexUrl} answered ${response.status}`);
  process.exit(1);
}
const index = parseIndex(await response.json());
const byPkg = new Map(index.extensions.map((e) => [e.pkg, e]));

let missing = 0;
let apkBad = 0;
let drift = 0;
let identityLost = 0;

console.log(`index: ${index.name} — ${index.extensions.length} extensions\n`);
for (const row of matrix.rows) {
  const live = byPkg.get(row.pkg);
  if (live === undefined) {
    console.log(`MISSING  ${row.name} (${row.pkg})`);
    missing += 1;
    continue;
  }

  // The matrix stores versionCode as a string (it is a JSON number in the index); compare numbers.
  const recorded = Number(row.versionCode);
  const sameVersion = live.versionCode === recorded;
  const versionNote = sameVersion ? `v${live.version} ✓` : `v${row.version} → v${live.version} (drift)`;
  if (!sameVersion) drift += 1;

  const liveIds = new Set(live.sources.map((s) => s.id));
  const lostIds = row.sources.filter((s) => !liveIds.has(s.id)).map((s) => s.id);
  if (lostIds.length > 0) identityLost += 1;

  let apkNote = "apk ✓";
  try {
    const head = await fetch(live.apkUrl, { method: "HEAD", redirect: "follow" });
    if (!head.ok) {
      apkNote = `apk ${head.status}`;
      apkBad += 1;
    }
  } catch (error) {
    apkNote = `apk error: ${String(error).slice(0, 60)}`;
    apkBad += 1;
  }

  console.log(
    `${row.name.padEnd(18)} ${String(live.sources.length).padStart(3)} sources  ${versionNote.padEnd(24)} ${apkNote}` +
      (lostIds.length > 0 ? `  SOURCE IDS GONE: ${lostIds.join(", ")}` : ""),
  );
}

console.log(
  `\n${matrix.rows.length} rows — missing ${missing}, apk unreachable ${apkBad}, version drift ${drift}, source-id loss ${identityLost}`,
);
process.exit(missing === 0 && apkBad === 0 ? 0 : 1);
