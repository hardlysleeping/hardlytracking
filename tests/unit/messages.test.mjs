/**
 * Messages: the two calls, without a project, a token or a socket.
 *
 *   npm test
 *
 * What is load-bearing here:
 *
 *   - **A message is one app's.** Every call names HardlyTracking, and the
 *     account's own token goes with it — the anon key alone is not a reader.
 *   - **A failure is a sentence, never an empty inbox.** A signed-out device, an
 *     expired token, a 500 and no network are four different things to say, and
 *     only the first is "there is nothing to read".
 *   - **A row this build cannot draw is dropped, not drawn empty**, and the list
 *     arrives newest first.
 *   - **Reading is recorded with the same ids**, and an empty batch asks the
 *     server nothing.
 *
 * The state the screen draws (`state/inbox.svelte.ts`) is held to the same
 * behaviour by HardlyReader's `tests/unit/inbox.mjs`, where the harness already
 * compiles runes modules; this suite covers the seam where the mistakes live.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MESSAGES_APP, MessagesClient, messageOf } from "../../src/api/messages.ts";

const PROJECT_URL = "https://project.test";
const ANON = "anon-key";
const TOKEN = "token-1";
const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

/** A row as PostgREST sends it. */
function row(id, title, publishedAt, readAt = null) {
  return {
    id,
    app: MESSAGES_APP,
    title,
    body: `Body of ${title}.`,
    published_at: new Date(publishedAt).toISOString(),
    read_at: readAt === null ? null : new Date(readAt).toISOString(),
  };
}

/** An account whose session is whatever the test says, and a recorded fetch. */
function account(session) {
  return {
    client: { supabaseUrl: PROJECT_URL, supabaseKey: ANON },
    session: async () => session,
  };
}

function server(answer, { ok = true, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body === undefined ? null : JSON.parse(String(init.body)) });
    if (answer === "throw") throw new TypeError("network down");
    const payload = typeof answer === "function" ? answer(calls.length) : answer;
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { calls, fetch: fetchImpl };
}

const SIGNED_IN = { userId: "user-1", email: "one@example.test", token: TOKEN };

/* --------------------------------- the list -------------------------------- */

test("the list is one RPC call that names this app", async () => {
  const seen = server([]);
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  await client.list();
  assert.equal(seen.calls.length, 1);
  assert.equal(seen.calls[0].url, `${PROJECT_URL}/rest/v1/rpc/my_app_messages`);
  assert.deepEqual(seen.calls[0].body, { p_app: "hardlytracking" });
});

test("and carries the account's own token beside the anon key", async () => {
  const seen = server([]);
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  await client.list();
  assert.equal(seen.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(seen.calls[0].init.headers.apikey, ANON);
});

test("a message arrives with milliseconds and its read state", async () => {
  const seen = server([row("a", "Outage", NOW), row("b", "Upgrade", NOW - DAY)]);
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  const answer = await client.list();
  assert.equal(answer.ok, true);
  assert.equal(answer.messages[0].title, "Outage");
  assert.equal(answer.messages[0].publishedAt, NOW);
  assert.equal(answer.messages[0].readAt, null);
});

test("the list is newest first even when the server is not", async () => {
  const seen = server([row("old", "Older", NOW - DAY), row("new", "Newer", NOW)]);
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  const answer = await client.list();
  assert.equal(answer.messages.map((message) => message.id).join(","), "new,old");
});

test("a row with nothing to draw is dropped rather than drawn empty", () => {
  assert.equal(messageOf({ id: "a", title: "   ", body: "x", published_at: new Date(NOW).toISOString() }), null);
  assert.equal(messageOf({ id: "a", title: "T", body: "x", published_at: null }), null);
  assert.equal(messageOf(null), null);
});

/* -------------------------------- refusals --------------------------------- */

test("a 500 is a sentence, not an empty inbox", async () => {
  const seen = server({ message: "boom" }, { ok: false, status: 500 });
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  const answer = await client.list();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /500/);
});

test("an expired token says so", async () => {
  const seen = server({}, { ok: false, status: 401 });
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  const answer = await client.list();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /sign-in has expired/);
});

test("no network is its own sentence", async () => {
  const seen = server("throw");
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  const answer = await client.list();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /did not answer/);
});

test("a signed-out device is told it is signed out, without a request", async () => {
  const seen = server([]);
  const client = new MessagesClient({ account: account(null), fetch: seen.fetch });
  const answer = await client.list();
  assert.equal(answer.ok, false);
  assert.match(answer.reason, /not signed in/);
  assert.equal(seen.calls.length, 0);
});

test("a build with no account service has nothing to ask", async () => {
  const client = new MessagesClient({ account: null });
  assert.equal(client.available, false);
  const answer = await client.list();
  assert.equal(answer.ok, false);
});

/* ------------------------------ reading them ------------------------------- */

test("marking read posts the ids under this app", async () => {
  const seen = server(2);
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  assert.equal(await client.markRead(["a", "b"]), true);
  assert.equal(seen.calls[0].url, `${PROJECT_URL}/rest/v1/rpc/mark_app_messages_read`);
  assert.deepEqual(seen.calls[0].body, { p_app: "hardlytracking", p_messages: ["a", "b"] });
});

test("marking nothing read asks the server nothing", async () => {
  const seen = server(0);
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  assert.equal(await client.markRead([]), true);
  assert.equal(seen.calls.length, 0);
});

test("a refused record is not confirmed", async () => {
  const seen = server({}, { ok: false, status: 500 });
  const client = new MessagesClient({ account: account(SIGNED_IN), fetch: seen.fetch });
  assert.equal(await client.markRead(["a"]), false);
});
