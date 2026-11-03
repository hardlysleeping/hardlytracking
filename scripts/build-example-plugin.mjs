/**
 * Builds `examples/reader-tools.htp` from the example plugin's source.
 *
 * The package is written here rather than in the app on purpose: a `.htp` is a file a person has, and
 * building one should not need the app's installer. `npm run plugin:example` is the whole build step.
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const here = fileURLToPath(new URL("..", import.meta.url));
const folder = process.argv[2] ?? "examples/reader-tools";
const source = join(here, folder);
const out = `${source}.htp`;

const entries = await readdir(source, { withFileTypes: true });
const files = {};
for (const entry of entries) {
  if (!entry.isFile()) continue;
  if (entry.name === "README.md") continue; // documentation for the repository, not the package
  const path = relative(source, join(source, entry.name));
  files[path] = new Uint8Array(await readFile(join(source, entry.name)));
}

const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
if (manifest.entry === undefined) throw new Error("the example manifest has no entry");
if (files[manifest.entry] === undefined) {
  throw new Error(`the example package has no ${manifest.entry}`);
}

const bytes = zipSync(files, { level: 6 });
await writeFile(out, bytes);
console.log(`wrote ${relative(here, out)} (${bytes.byteLength} bytes, ${Object.keys(files).length} files)`);
