#!/usr/bin/env node
/**
 * The T11 gate: the TypeScript bridge against a real M-Extension-Server and a real APK.
 *
 *   DALVIK_URL=http://127.0.0.1:8792 APK=/path/to/extension.apk npm run dalvik:smoke
 *
 * It installs by sending the APK bytes, then walks popular → chapters → pages through
 * `createDalvikProvider`, so what is proven is the code the app will ship, not a curl.
 * Without the two variables it says so and exits 2 — a skipped gate is never a pass.
 */
import { readFile } from "node:fs/promises";
import { DalvikClient, createDalvikProvider } from "../src/api/dalvik.ts";

const baseUrl = process.env.DALVIK_URL;
const apkPath = process.env.APK;

if (!baseUrl || !apkPath) {
  console.error("skip: set DALVIK_URL (e.g. http://127.0.0.1:8792) and APK (path to a Mihon extension APK)");
  process.exit(2);
}

const client = new DalvikClient({ baseUrl });
const started = Date.now();

const apk = await readFile(apkPath);
const installed = await client.install(new Uint8Array(apk));
console.log(`install        ${installed.sources.length} sources, extensionId ${installed.extensionId}`);

const provider = createDalvikProvider({
  client,
  extensions: [{ extensionId: installed.extensionId, packageId: apkPath.split("/").pop() ?? "apk", sources: installed.sources }],
});

const sources = await provider.sources();
console.log(`sources        ${sources.length} (first: ${sources[0]?.name ?? "none"} ${sources[0]?.lang ?? ""})`);

const english = installed.sources.find((source) => source.lang === "en") ?? installed.sources[0];
if (english === undefined) {
  console.error("fail: the APK exposes no sources");
  process.exit(1);
}

const popular = await provider.popular(english.id, 1);
console.log(`popular        ${popular.items.length} titles, hasNext=${popular.hasNext}`);
const first = popular.items[0];
if (first === undefined) {
  console.error("fail: popular returned nothing");
  process.exit(1);
}
console.log(`  first        ${first.title} -> ${first.id}`);
console.log(`  cover        ${first.cover ?? "(none)"}`);

const details = await provider.details(first.id);
console.log(`details        author=${details.author ?? "-"} description=${(details.description ?? "").length} chars`);

const chapters = await provider.chapters(first.id);
console.log(`chapters       ${chapters.length} (first: ${chapters[0]?.name ?? "none"} number=${chapters[0]?.number ?? "-"})`);

if (chapters.length === 0) {
  console.error("fail: no chapters");
  process.exit(1);
}

const pages = await provider.pages(chapters[0].id);
console.log(`pages          ${pages.length} (first: ${pages[0]?.url ?? "none"})`);

const search = await provider.search(english.id, first.title.slice(0, 12), 1);
console.log(`search         ${search.items.length} titles for "${first.title.slice(0, 12)}"`);

const ok = popular.items.length > 0 && chapters.length > 0 && pages.length > 0;
console.log(`${ok ? "PASS" : "FAIL"}  ${((Date.now() - started) / 1000).toFixed(1)}s through ${baseUrl}`);
process.exit(ok ? 0 : 1);
