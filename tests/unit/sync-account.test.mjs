/**
 * HardlySyncing in this app: the sign-in is the reader's, the row is the
 * reader's, and the shop is the reader's.
 *
 * These checks exist because the failure they guard against is quiet: a client
 * that invented its own way in — a typed code, its own auth endpoints, its own
 * stored session — would still look like it worked while being a different setup
 * for the same subscription. The reader signs in with `signInWithOtp`; so does
 * this. Nothing is asserted about Stripe, which is not this app's business.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CheckoutError,
  LINK_SENT,
  SyncAccount,
  billingUrl,
  createSyncAccount,
  readRow,
  roleOf,
  syncConfig,
} from "../../src/api/sync-account.ts";

const CONFIG = { url: "https://project.supabase.co", anonKey: "anon-key" };
const USER = "11111111-1111-1111-1111-111111111111";

const SESSION = {
  access_token: "tok",
  user: { id: USER, email: "a@b.test" },
};

/** A client that answers like the SDK, and remembers what it was asked. */
function fakeClient({ session = null, otpError = null } = {}) {
  const asked = [];
  return {
    asked,
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signInWithOtp: async (options) => {
        asked.push({ kind: "otp", options });
        return { data: {}, error: otpError };
      },
      signOut: async () => {
        asked.push({ kind: "signOut" });
        return { error: null };
      },
    },
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

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/* ------------------------------- the config ------------------------------- */

test("a build with no Supabase values has no row to show, and no paid switch", () => {
  assert.equal(syncConfig(null), null);
  assert.equal(syncConfig({}), null);
  assert.equal(syncConfig({ PUBLIC_SUPABASE_URL: "https://x.supabase.co" }), null);
  assert.equal(createSyncAccount(null), null);
});

test("the same two names HardlyReader reads are the ones read here", () => {
  assert.deepEqual(
    syncConfig({ PUBLIC_SUPABASE_URL: "https://x.supabase.co/", PUBLIC_SUPABASE_ANON_KEY: " k " }),
    { url: "https://x.supabase.co", anonKey: "k" },
  );
});

test("a service_role key is refused rather than used", () => {
  const payload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  const key = `header.${payload}.signature`;
  assert.equal(roleOf(key), "service_role");
  assert.equal(
    syncConfig({ PUBLIC_SUPABASE_URL: "https://x.supabase.co", PUBLIC_SUPABASE_ANON_KEY: key }),
    null,
  );
});

test("the shop is the reader's shop, and a build may point it elsewhere", () => {
  assert.equal(billingUrl({}), "https://billing.hardlysleep.ing");
  assert.equal(billingUrl({ PUBLIC_BILLING_URL: "https://b.test/" }), "https://b.test");
});

/* -------------------------------- the way in ------------------------------- */

test("the sign-in is a link through the SDK, with no code to type", async () => {
  const client = fakeClient();
  const account = new SyncAccount({ config: CONFIG, client, redirectTo: "https://app.test/" });
  await account.sendLink("  a@b.test ");
  assert.equal(client.asked.length, 1);
  assert.equal(client.asked[0].kind, "otp");
  assert.equal(client.asked[0].options.email, "a@b.test");
  assert.equal(client.asked[0].options.options.emailRedirectTo, "https://app.test/");
  // The sentence says what actually happens: a link, opened, signs this device in.
  assert.match(LINK_SENT, /link/i);
  assert.doesNotMatch(LINK_SENT, /code/i);
});

test("a link for nobody is refused before anything is sent", async () => {
  const client = fakeClient();
  const account = new SyncAccount({ config: CONFIG, client });
  await assert.rejects(() => account.sendLink("   "), /needs an address/);
  assert.equal(client.asked.length, 0);
});

test("a provider that refuses says so", async () => {
  const client = fakeClient({ otpError: { message: "rate limited" } });
  const account = new SyncAccount({ config: CONFIG, client });
  await assert.rejects(() => account.sendLink("a@b.test"), /rate limited/);
});

test("no session is no account, never a cached one", async () => {
  const account = new SyncAccount({ config: CONFIG, client: fakeClient() });
  assert.equal(await account.session(), null);
  assert.deepEqual(await account.entitlement(), {
    state: "none",
    reason: "this device is not signed in",
  });
});

/* -------------------------------- the row --------------------------------- */

test("the row is read once, as this user, with this user's token, and only read", async () => {
  const { fetch, calls } = stub(() => json([{ cloud_sync: true, expires_at: null }]));
  const account = new SyncAccount({ config: CONFIG, client: fakeClient({ session: SESSION }), fetch });
  assert.equal((await account.entitlement()).state, "active");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(
    calls[0].url,
    `https://project.supabase.co/rest/v1/entitlements?select=cloud_sync,expires_at&user_id=eq.${USER}&limit=1`,
  );
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  assert.equal(calls[0].init.headers.apikey, "anon-key");
});

test("a purchase made in another app is the same row, and reads as active here", async () => {
  const { fetch } = stub(() => json([{ cloud_sync: true, expires_at: "2027-01-01T00:00:00+00:00" }]));
  const account = new SyncAccount({ config: CONFIG, client: fakeClient({ session: SESSION }), fetch });
  const state = await account.entitlement(Date.parse("2026-10-30T00:00:00Z"));
  assert.equal(state.state, "active");
  assert.equal(state.expiresAt, Date.parse("2027-01-01T00:00:00+00:00"));
});

test("an expired grant reads as no grant, without anyone pressing anything", async () => {
  const { fetch } = stub(() => json([{ cloud_sync: true, expires_at: "2026-10-01T00:00:00+00:00" }]));
  const account = new SyncAccount({ config: CONFIG, client: fakeClient({ session: SESSION }), fetch });
  const state = await account.entitlement(Date.parse("2026-10-30T00:00:00Z"));
  assert.equal(state.state, "none");
  assert.match(state.reason, /run out/);
});

test("no row is no subscription", async () => {
  const { fetch } = stub(() => json([]));
  const account = new SyncAccount({ config: CONFIG, client: fakeClient({ session: SESSION }), fetch });
  assert.equal((await account.entitlement()).state, "none");
});

test("a token the server disowns says so, and is not an error", async () => {
  const { fetch } = stub(() => json({ message: "JWT expired" }, 401));
  const account = new SyncAccount({ config: CONFIG, client: fakeClient({ session: SESSION }), fetch });
  const state = await account.entitlement();
  assert.equal(state.state, "none");
  assert.match(state.reason, /sign-in has expired/);
});

test("a server that does not answer is unreachable, never a yes", async () => {
  const { fetch } = stub(() => {
    throw new Error("offline");
  });
  const account = new SyncAccount({ config: CONFIG, client: fakeClient({ session: SESSION }), fetch });
  assert.equal((await account.entitlement()).state, "unreachable");

  const broken = new SyncAccount({
    config: CONFIG,
    client: fakeClient({ session: SESSION }),
    fetch: stub(() => json({ message: "no" }, 500)).fetch,
  });
  assert.equal((await broken.entitlement()).state, "unreachable");
});

test("the row policy, on its own", () => {
  const now = 1_000_000;
  assert.equal(readRow(null, now).state, "none");
  assert.equal(readRow({ cloud_sync: false }, now).state, "none");
  assert.equal(readRow({ cloud_sync: "true" }, now).state, "none");
  assert.equal(readRow({ cloud_sync: true }, now).state, "active");
  assert.equal(readRow({ cloud_sync: true, expires_at: null }, now).state, "active");
  assert.equal(readRow({ cloud_sync: true, expires_at: now + 1 }, now).state, "active");
  assert.equal(readRow({ cloud_sync: true, expires_at: now }, now).state, "none");
});

/* ------------------------------- Checkout --------------------------------- */

test("checkout names the plan and this app's origin, and opens what it is given", async () => {
  const { fetch, calls } = stub(() => json({ url: "https://checkout.stripe.test/session" }));
  const opened = [];
  const account = new SyncAccount({
    config: CONFIG,
    client: fakeClient({ session: SESSION }),
    fetch,
    billingBase: "https://billing.test/",
  });
  const url = await account.checkout("yearly", (target) => opened.push(target));
  assert.equal(url, "https://checkout.stripe.test/session");
  assert.deepEqual(opened, ["https://checkout.stripe.test/session"]);
  assert.equal(calls[0].url, "https://billing.test/checkout");
  assert.equal(calls[0].init.headers.Authorization, "Bearer tok");
  // Under Node there is no origin to name, so the field is absent rather than wrong.
  assert.deepEqual(JSON.parse(calls[0].init.body), { plan: "yearly" });
});

test("a signed-out reader is never sent to Checkout", async () => {
  const account = new SyncAccount({ config: CONFIG, client: fakeClient() });
  await assert.rejects(
    () => account.checkout("monthly", () => {}),
    (error) => error instanceof CheckoutError && error.code === "not_signed_in",
  );
});

test("a checkout answer that is not an https URL opens nothing", async () => {
  const opened = [];
  const account = new SyncAccount({
    config: CONFIG,
    client: fakeClient({ session: SESSION }),
    fetch: stub(() => json({ url: "javascript:alert(1)" })).fetch,
  });
  await assert.rejects(
    () => account.checkout("monthly", (url) => opened.push(url)),
    (error) => error instanceof CheckoutError && error.code === "no_url",
  );
  assert.deepEqual(opened, []);
});

test("a refusal keeps the service's own name, and an unreachable shop is named too", async () => {
  const refused = new SyncAccount({
    config: CONFIG,
    client: fakeClient({ session: SESSION }),
    fetch: stub(() => json({ error: "plan_not_offered" }, 400)).fetch,
  });
  await assert.rejects(
    () => refused.checkout("monthly", () => {}),
    (error) => error instanceof CheckoutError && error.code === "plan_not_offered",
  );

  const offline = new SyncAccount({
    config: CONFIG,
    client: fakeClient({ session: SESSION }),
    fetch: stub(() => {
      throw new Error("offline");
    }).fetch,
  });
  await assert.rejects(
    () => offline.checkout("monthly", () => {}),
    (error) => error instanceof CheckoutError && error.code === "billing_unreachable",
  );
});

test("signing out clears this device and touches no row", async () => {
  const client = fakeClient({ session: SESSION });
  const account = new SyncAccount({ config: CONFIG, client });
  await account.signOut();
  assert.deepEqual(
    client.asked.map((entry) => entry.kind),
    ["signOut"],
  );
});
