/**
 * The fixture M-Extension-Server, on a fixed port, for checking a source's own filters in the app.
 *
 * The app talks to its extension host through its own `/api/dalvik` passthrough, so the way to point
 * a browser at this host is to serve the app with `DALVIK_URL` naming it:
 *
 *   node tests/manual/stub-dalvik-filters.mjs            # this host on :8710
 *   npm run build
 *   PORT=8461 DALVIK_URL=http://127.0.0.1:8710 node server/proxy.mjs
 *   open http://127.0.0.1:8461/                          # add /repo/index.min.json as a repository
 *
 * `json` answers a form (checkbox, a group of checkboxes, a sort, a select, a group of tri-states),
 * `html` a different one (a header, text, a checkbox), and the other two answer none — so a source
 * with nothing to filter can be seen to draw no Filters button next to one that does.
 */
import { createDalvikMock } from "../fixtures/dalvik-mock.mjs";

const PORT = Number(process.env.PORT ?? 8710);

const mock = await createDalvikMock({});
await mock.listen(PORT);

console.log(`fixture dalvik host on ${mock.baseUrl}`);
console.log(`repository: ${mock.baseUrl}/repo/index.min.json`);
console.log("json source has a form, html a different one, login/cookie none");

const stop = async () => {
  await mock.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
