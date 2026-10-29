/**
 * Live check against the real runtime. Not part of `npm test`: it needs a Mihon
 * extension host answering on :4567 (Suwayomi today).
 *
 *   node scripts/smoke.mjs                     # straight at the runtime
 *   BASE=http://127.0.0.1:8457/api/mihon node scripts/smoke.mjs   # through the proxy
 *
 * It asserts shapes, not content: the only extensions installed on this box are
 * adult sources, so the chapter/page checks use a cached non-NSFW manga id.
 */
import { browserMihonTransport, createMihonProvider } from "../src/api/mihon.ts";

const BASE = process.env.BASE ?? "http://127.0.0.1:4567/api";
const MANGA = Number(process.env.MANGA ?? 12);

const provider = createMihonProvider(browserMihonTransport(BASE));
const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const sources = await provider.sources();
check("sources answer", sources.length > 0, `${sources.length} sources`);
check("source ids are namespaced", sources.every((s) => s.id.startsWith("mihon:src:")), sources[0]?.id ?? "none");

const local = sources.find((s) => s.id === "mihon:src:0");
if (local) {
  const popular = await provider.popular(local.id, 1);
  check("popular on the local source answers a page", Array.isArray(popular.items), `${popular.items.length} items`);
  const search = await provider.search(local.id, "test", 1);
  check("search on the local source answers a page", Array.isArray(search.items), `${search.items.length} items`);
}

const details = await provider.details(`mihon:${MANGA}`);
check("details answer", details.title.length > 0, details.title);
check("cover is an absolute URL", details.cover === undefined || /^https?:\/\//.test(details.cover), details.cover ?? "no cover");

const chapters = await provider.chapters(`mihon:${MANGA}`);
check("chapters answer", Array.isArray(chapters), `${chapters.length} chapters`);
if (chapters.length > 0) {
  const pages = await provider.pages(chapters[0].id);
  check("pages answer", pages.length > 0, `${pages.length} pages`);
  check("page URLs are absolute", pages.every((p) => /^https?:\/\//.test(p.url)), pages[0]?.url ?? "none");
}

const failed = checks.filter((c) => !c.ok).length;
console.log(`\n${checks.length - failed}/${checks.length} checks passed against ${BASE}`);
process.exit(failed === 0 ? 0 : 1);
