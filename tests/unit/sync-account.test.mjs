/**
 * HardlySyncing in this app: the account, the row, and the way back from Checkout.
 *
 * The point of these checks is the thing that would be wrong quietly: the row is
 * read with the *reader's* token against the *reader's* project, an expired grant
 * reads as no grant, and a purchase started here comes back here. Nothing is
 * asserted about Stripe — what Stripe does is not this app's business.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  clearSession,
  entitlement,
  readRow,
  readSession,
  requestCode,
  startCheckout,
  syncConfig,
  verifyCode,
  writeSession,
} from "../../src/api/sync-account.ts";

const CONFIG = { url: "https://project.supabase.co", anonKey: "anon-key" };
const USER = "11111111-1111-1111-1111-111111111111";

/** A storage with no browser behind it. */
function memoryStore() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    dump: () => Object.fromEntries(map),
  };
}

/** A fetch that answers whatever the test says, and remembers what it was asked. */
function stub(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return answer(String(url), init ?? {});
  };
  return { fetch, calls };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ------------------------------- the config ------------------------------- */

test("a build with no Supabase values has no row to show", () => {
  assert.equal(syncConfig(null), null);
  assert.equal(syncConfig({}), null);
  assert.equal(syncConfig({ PUBLIC_SUPABASE_URL: "https://x.supabase.co" }), null);
});

test("the same two names HardlyReader reads are the ones read here", () => {
  assert.deepEqual(syncConfig({ PUBLIC_SUPABASE_URL: "https://x.supabase.co/", PUBLIC_SUPABASE_ANON_KEY: "k" }), {
    url: "https://x.supabase.co",
    anonKey: "k",
  });
});

test("a service_role key is refused rather than used", () => {
  const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  const key = `header.${payload}.signature`;
  assert.equal(syncConfig({ PUBLIC_SUPABASE_URL: "https://x.supabase.co", PUBLIC_SUPABASE_ANON_KEY: key }), null);
});

/* -------------------------------- the session ------------------------------ */

test("a session survives a restart, and a corrupt one is no session", () => {
  const store = memoryStore();
  assert.equal(readSession(store), null);
  writeSession({ userId: USER, email: "a@b.test", token: "t", refresh: "r", expiresAt: 5 }, store);
  assert.deepEqual(readSession(store), { userId: USER, email: "a@b.test", token: "t", refresh: "r", expiresAt: 5 });
  store.setItem("hardlytracking.sync.session", "{not json");
  assert.equal(readSession(store), null);
  clearSession(store);
  assert.equal(readSession(store), null);
});

test("asking for a code posts to the project's own otp route", async () => {
  const { fetch, calls } = stub(() => json({}));
  assert.equal(await requestCode({ config: CONFIG, fetch, email: "  a@b.test " }), "sent");
  assert.equal(calls[0].url, "https://project.supabase.co/auth/v1/otp");
  assert.equal(calls[0].init.headers.apikey, "anon-key");
  assert.equal(JSON.parse(calls[0].init.body).email, "a@b.test");
  assert.equal(JSON.parse(calls[0].init.body).create_user, true);
});

test("a provider that refuses is a refusal, not a crash", async () => {
  const { fetch } = stub(() => json({ error: "rate limited" }, 429));
  assert.equal(await requestCode({ config: CONFIG, fetch, email: "a@b.test" }), "refused");
});

test("the code becomes a session the device keeps", async () => {
  const store = memoryStore();
  const { fetch, calls } = stub(() =>
    json({ access_token: "tok", refresh_token: "ref", expires_at: 1_800_000_000, user: { id: USER, email: "a@b.test" } }),
  );
  const session = await verifyCode({ config: CONFIG, fetch, email: "a@b.test", code: " 123456 ", store });
  assert.equal(session.userId, USER);
  assert.equal(session.token, "tok");
  assert.equal(session.expiresAt, 1_800_000_000_000);
  assert.equal(JSON.parse(calls[0].init.body).token, "123456");
  assert.equal(readSession(store).token, "tok");
});

test("a wrong code signs nobody in", async () => {
  const store = memoryStore();
  const { fetch } = stub(() => json({ error: "invalid" }, 401));
  assert.equal(await verifyCode({ config: CONFIG, fetch, email: "a@b.test", code: "000000", store }), null);
  assert.equal(readSession(store), null);
});

/* -------------------------------- the row --------------------------------- */

const SESSION = { userId: USER, email: "a@b.test", token: "tok", refresh: "ref", expiresAt: 0 };

test("the row is read with the reader's own token and their own id", async () => {
  const { fetch, calls } = stub(() => json([{ cloud_sync: true, expires_at: null }]));
  const state = await entitlement({ config: CONFIG, fetch, session: SESSION });
  assert.equal(state.state, "active");
  assert.equal(calls[0].url, `https://project.supabase.co/rest/v1/entitlements?select=cloud_sync,expires_at&user_id=eq.${USER}&limit=1`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(calls[0].init.headers.apikey, "anon-key");
});

test("a purchase made in another app is the same row, and reads as active here", async () => {
  const { fetch } = stub(() => json([{ cloud_sync: true, expires_at: "2027-01-01T00:00:00+00:00" }]));
  const state = await entitlement({ config: CONFIG, fetch, session: SESSION, now: Date.parse("2026-10-30T00:00:00Z") });
  assert.equal(state.state, "active");
  assert.equal(state.expiresAt, Date.parse("2027-01-01T00:00:00+00:00"));
});

test("an expired grant reads as no grant, without anyone pressing anything", async () => {
  const { fetch } = stub(() => json([{ cloud_sync: true, expires_at: "2026-10-01T00:00:00+00:00" }]));
  const state = await entitlement({ config: CONFIG, fetch, session: SESSION, now: Date.parse("2026-10-30T00:00:00Z") });
  assert.equal(state.state, "none");
  assert.match(state.reason, /run out/);
});

test("no row is no subscription", async () => {
  const { fetch } = stub(() => json([]));
  assert.equal((await entitlement({ config: CONFIG, fetch, session: SESSION })).state, "none");
});

test("a token the server disowns says so, and does not read as an error", async () => {
  const { fetch } = stub(() => json({ message: "JWT expired" }, 401));
  const state = await entitlement({ config: CONFIG, fetch, session: SESSION });
  assert.equal(state.state, "none");
  assert.match(state.reason, /sign-in has expired/);
});

test("a server that does not answer is unreachable, never a yes", async () => {
  const { fetch } = stub(() => {
    throw new Error("offline");
  });
  assert.equal((await entitlement({ config: CONFIG, fetch, session: SESSION })).state, "unreachable");
});

test("the row policy, on its own", () => {
  const now = 1_000_000;
  assert.equal(readRow(null, now).state, "none");
  assert.equal(readRow({ cloud_sync: false }, now).state, "none");
  assert.equal(readRow({ cloud_sync: true }, now).state, "active");
  assert.equal(readRow({ cloud_sync: true, expires_at: now + 1 }, now).state, "active");
  assert.equal(readRow({ cloud_sync: true, expires_at: now }, now).state, "none");
});

/* ------------------------------- Checkout --------------------------------- */

test("checkout names the plan and this app's origin, and opens what it is given", async () => {
  const { fetch, calls } = stub(() => json({ url: "https://checkout.stripe.test/session" }));
  const opened = [];
  const url = await startCheckout({
    config: CONFIG,
    fetch,
    session: SESSION,
    plan: "yearly",
    base: "https://billing.test/",
    origin: "https://tracking.test",
    open: (target) => opened.push(target),
  });
  assert.equal(url, "https://checkout.stripe.test/session");
  assert.deepEqual(opened, ["https://checkout.stripe.test/session"]);
  assert.equal(calls[0].url, "https://billing.test/checkout");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.deepEqual(JSON.parse(calls[0].init.body), { plan: "yearly", return: "https://tracking.test" });
});

test("a checkout answer that is not an https URL opens nothing", async () => {
  const { fetch } = stub(() => json({ url: "javascript:alert(1)" }));
  const opened = [];
  assert.equal(
    await startCheckout({ config: CONFIG, fetch, session: SESSION, plan: "monthly", open: (u) => opened.push(u) }),
    null,
  );
  assert.deepEqual(opened, []);
});
