/**
 * A stand-in Mihon source host, for proving per-source filters end to end.
 *
 * The app talks to a Mihon runtime over `/api/mihon/graphql`, so this answers the small part of
 * Suwayomi's schema the provider uses: `sources`, `source(id){filters}`, `fetchSourceManga`,
 * `manga`, `chapters`, `fetchChapterPages`, `updateChapter`, plus a 1x1 PNG for every thumbnail.
 *
 * Two sources, deliberately: `stub-1` declares a real filter form (select, checkbox, text, sort),
 * `stub-2` declares none, so the UI can be seen to hide the Filters button where there is nothing
 * to filter.
 *
 * `fetchSourceManga` **applies** the filters it is sent, which is the point: a result set that
 * changes is the only proof a filter sheet works. Every request is kept in `GET /__log`.
 *
 *   PORT=25777 node tests/manual/stub-mihon-graphql.mjs
 *   RUNTIME_URL=http://127.0.0.1:25777 PORT=8461 node server/proxy.mjs
 */
import { createServer } from "node:http";

const PORT = Number(process.env.PORT ?? 25777);
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc00000030101005c5d5a5f0000000049454e44ae426082",
  "hex",
);

const SOURCES = [
  { id: "stub-1", displayName: "Stub Library", name: "Stub Library", lang: "en", isNsfw: false, supportsLatest: true },
  { id: "stub-2", displayName: "Stub Quiet", name: "Stub Quiet", lang: "en", isNsfw: false, supportsLatest: false },
];

const FILTERS_STUB_1 = [
  { __typename: "HeaderFilter", name: "Narrow it down" },
  { __typename: "SeparatorFilter", name: "" },
  { __typename: "SelectFilter", name: "Album", values: ["All albums", "Alpha", "Beta"], selectDefault: 0 },
  { __typename: "CheckBoxFilter", name: "Finished only", checkDefault: false },
  { __typename: "TextFilter", name: "Author", textDefault: "" },
  { __typename: "SortFilter", name: "Order by", values: ["Title", "Date"], sortDefault: { index: 0, ascending: true } },
];

/** Six titles: three in each album, some finished, with distinct dates. */
const MANGA = [
  { id: 1, title: "Alpha One", album: "Alpha", author: "Ada", finished: true, date: 10 },
  { id: 2, title: "Alpha Two", album: "Alpha", author: "Bo", finished: false, date: 30 },
  { id: 3, title: "Alpha Three", album: "Alpha", author: "Ada", finished: false, date: 20 },
  { id: 4, title: "Beta One", album: "Beta", author: "Cy", finished: true, date: 40 },
  { id: 5, title: "Beta Two", album: "Beta", author: "Ada", finished: true, date: 5 },
  { id: 6, title: "Beta Three", album: "Beta", author: "Dee", finished: false, date: 60 },
];

const log = [];

const THUMB = (m) => `/api/v1/manga/${m.id}/thumbnail`;

function mangaJson(m) {
  return {
    id: m.id,
    title: m.title,
    thumbnailUrl: THUMB(m),
    author: m.author,
    description: `${m.title} — ${m.album}, ${m.finished ? "finished" : "ongoing"}.`,
    status: m.finished ? "COMPLETED" : "ONGOING",
  };
}

/** What `fetchSourceManga` does with the filters it was handed — the reason this stub exists. */
function applyFilters(rows, changes) {
  let out = [...rows];
  for (const change of changes ?? []) {
    const position = change.position;
    if (position === 2 && typeof change.selectState === "number") {
      const album = FILTERS_STUB_1[2].values[change.selectState];
      if (album !== "All albums") out = out.filter((m) => m.album === album);
    }
    if (position === 3 && typeof change.checkBoxState === "boolean" && change.checkBoxState) {
      out = out.filter((m) => m.finished);
    }
    if (position === 4 && typeof change.textState === "string" && change.textState !== "") {
      const needle = change.textState.toLowerCase();
      out = out.filter((m) => m.author.toLowerCase().includes(needle));
    }
    if (position === 5 && change.sortState) {
      const byIndex = change.sortState.index === 0 ? (a, b) => a.title.localeCompare(b.title) : (a, b) => a.date - b.date;
      out.sort(byIndex);
      if (change.sortState.ascending === false) out.reverse();
    }
  }
  return out;
}

function json(res, body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": bytes.length });
  res.end(bytes);
}

/** The query is answered by its operation name, not by parsing GraphQL: this is a fixture. */
function answer(query, variables) {
  if (/query\s+Sources/.test(query)) {
    return { data: { sources: { nodes: SOURCES } } };
  }
  if (/query\s+SourceFilters/.test(query)) {
    const filters = variables.id === "stub-1" ? FILTERS_STUB_1 : [];
    return { data: { source: { filters } } };
  }
  if (/mutation\s+FetchSource/.test(query)) {
    const type = variables.type ?? "POPULAR";
    const rows = applyFilters(MANGA, type === "SEARCH" ? variables.filters : null);
    return { data: { fetchSourceManga: { mangas: rows.map(mangaJson), hasNextPage: false } } };
  }
  if (/query\s+Manga/.test(query)) {
    const m = MANGA.find((row) => row.id === Number(variables.id));
    return { data: { manga: m ? mangaJson(m) : null } };
  }
  if (/query\s+Chapters/.test(query)) {
    return {
      data: {
        chapters: {
          nodes: [
            { id: 1, name: "Chapter 1", chapterNumber: 1, pageCount: 2, isRead: false, lastPageRead: 0, lastReadAt: null, uploadDate: null },
            { id: 2, name: "Chapter 2", chapterNumber: 2, pageCount: 2, isRead: false, lastPageRead: 0, lastReadAt: null, uploadDate: null },
          ],
        },
      },
    };
  }
  if (/mutation\s+Pages/.test(query)) {
    return { data: { fetchChapterPages: { pages: ["/page/1", "/page/2"] } } };
  }
  if (/mutation\s+SetRead/.test(query)) {
    return { data: { updateChapter: { chapter: { id: Number(variables.id), isRead: variables.read } } } };
  }
  return { data: {} };
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

  if (url.pathname === "/__log") return json(res, log);
  if (/^\/api\/v1\/manga\/\d+\/(thumbnail|chapter\/\d+\/page\/\d+)$/.test(url.pathname) || /^\/page\/\d+$/.test(url.pathname)) {
    res.writeHead(200, { "content-type": "image/png", "content-length": PNG.length });
    return res.end(PNG);
  }

  if (url.pathname === "/api/graphql" && req.method === "POST") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, { errors: [{ message: "bad json" }] }, 400);
      }
      const op = /(mutation|query)\s+(\w+)/.exec(parsed.query ?? "")?.[2] ?? "(anonymous)";
      log.push({ op, variables: parsed.variables ?? {} });
      return json(res, answer(parsed.query ?? "", parsed.variables ?? {}));
    });
    return;
  }

  json(res, { error: `no stub for ${req.method} ${url.pathname}` }, 404);
});

server.listen(PORT, "127.0.0.1", () => console.log(`stub mihon graphql on http://127.0.0.1:${PORT}`));
