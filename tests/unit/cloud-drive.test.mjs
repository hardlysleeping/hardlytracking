import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DriveError,
  comicFiles,
  downloadFile,
  driveToFiles,
  folderIdFrom,
  folderQuery,
  listFolder,
} from "../../src/lib/cloud/drive.ts";

/** A fetch that answers from a table of URLs, and records what was asked for. */
function fakeFetch(routes) {
  const asked = [];
  const fetcher = async (url, init) => {
    asked.push({ url, headers: init?.headers ?? {} });
    const match = Object.keys(routes).find((needle) => url.includes(needle));
    if (match === undefined) throw new Error(`unexpected request: ${url}`);
    const route = routes[match];
    const answer = typeof route === "function" ? route(url) : route;
    return new Response(typeof answer === "string" ? answer : JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetcher, asked };
}

const folder = { id: "f1", name: "Comics", mimeType: "application/vnd.google-apps.folder" };
const cbz = (id, name, size = "1000") => ({ id, name, size, mimeType: "application/zip" });

test("a folder link, a share link and a bare id all give the folder id", () => {
  const id = "1AbCdEfGhIjKlMnOpQrStUvWxYz";
  assert.equal(folderIdFrom(`https://drive.google.com/drive/folders/${id}`), id);
  assert.equal(folderIdFrom(`https://drive.google.com/drive/u/0/folders/${id}?usp=sharing`), id);
  assert.equal(folderIdFrom(id), id);
});

test("a file link is refused rather than read as a folder", () => {
  // Treating it as a folder would list nothing and read as an empty folder, not a mistake.
  assert.equal(folderIdFrom("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view"), null);
  assert.equal(folderIdFrom(""), null);
  assert.equal(folderIdFrom("my comics"), null);
});

test("the query is the folder's children, and a quote in an id cannot break out of it", () => {
  assert.equal(folderQuery("abc"), "'abc' in parents and trashed = false");
  assert.equal(folderQuery("a'b"), "'a\\'b' in parents and trashed = false");
});

test("folders and non-comics are dropped, and the rest sort naturally", () => {
  const files = [
    folder,
    cbz("2", "Saga v10.cbz"),
    { id: "d", name: "Notes.gdoc", mimeType: "application/vnd.google-apps.document" },
    cbz("1", "Saga v2.cbz"),
    cbz("3", "Saga v1.pdf"),
    { id: "x", name: "cover.jpg", mimeType: "image/jpeg" },
  ];
  assert.deepEqual(
    comicFiles(files).map((file) => file.name),
    ["Saga v1.pdf", "Saga v2.cbz", "Saga v10.cbz"],
  );
});

test("a listing is paged until Drive stops handing out page tokens", async () => {
  const { fetcher, asked } = fakeFetch({
    pageToken: { files: [cbz("2", "b.cbz")] },
    files: { files: [cbz("1", "a.cbz")], nextPageToken: "next" },
  });
  const files = await listFolder("tok", "folder1", fetcher);
  assert.deepEqual(files.map((file) => file.name), ["a.cbz", "b.cbz"]);
  assert.equal(asked.length, 2);
  assert.match(asked[0].url, /q=%27folder1%27\+in\+parents/);
  assert.match(asked[0].url, /fields=nextPageToken/);
  assert.match(asked[1].url, /pageToken=next/);
  assert.equal(asked[0].headers.Authorization, "Bearer tok");
});

test("a run of pages that never ends is capped rather than followed forever", async () => {
  const { fetcher, asked } = fakeFetch({ files: () => ({ files: [], nextPageToken: "more" }) });
  await listFolder("tok", "folder1", fetcher, 3);
  assert.equal(asked.length, 3);
});

test("an expired token says so, and a 403 points at the consent screen", async () => {
  const expired = async () => new Response("{}", { status: 401 });
  await assert.rejects(listFolder("tok", "f", expired), (error) => {
    assert.ok(error instanceof DriveError);
    assert.equal(error.status, 401);
    assert.match(error.message, /connect again/);
    return true;
  });
  const forbidden = async () => new Response("{}", { status: 403 });
  await assert.rejects(listFolder("tok", "f", forbidden), /test user on the OAuth consent screen/);
});

test("a file is fetched as content, not metadata", async () => {
  const { fetcher, asked } = fakeFetch({ "files/abc": "PAGES" });
  const blob = await downloadFile("tok", "abc", fetcher);
  assert.equal(await blob.text(), "PAGES");
  assert.match(asked[0].url, /alt=media/);
});

test("chosen files become File objects in order, one at a time, with progress", async () => {
  const { fetcher, asked } = fakeFetch({ "files/one": "ONE", "files/two": "TWO" });
  const progress = [];
  const files = await driveToFiles("tok", [cbz("one", "one.cbz"), cbz("two", "two.cbz")], fetcher, (done, total) =>
    progress.push(`${done}/${total}`),
  );
  assert.deepEqual(files.map((file) => file.name), ["one.cbz", "two.cbz"]);
  assert.deepEqual(progress, ["1/2", "2/2"]);
  assert.equal(asked.length, 2);
  assert.equal(await files[1].text(), "TWO");
});
