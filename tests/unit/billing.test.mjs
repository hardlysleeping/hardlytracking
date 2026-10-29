/**
 * The billing service, without Stripe, without Supabase, without a socket.
 *
 *   npm test
 *
 * What is checked here is the half of the paid feature that costs money to get
 * wrong: the state machine that decides `cloud_sync`, the two guards around it
 * (a duplicate event, an event delivered out of order), the signature that makes
 * the webhook the only writer, and the fact that the read path cannot write.
 *
 * Every clock is injected and every price id is a fixture, so nothing below
 * touches the network and nothing below needs a key. The signatures are computed
 * with `node:crypto` in the test itself, so "the service accepts a correctly
 * signed body" is checked against the HMAC rule rather than against the service's
 * own idea of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

import { readConfig, REQUIRED } from "../../server/billing/config.mjs";
import {
  GRACE_MS,
  applyStripeEvent,
  effectiveEntitlement,
  emptyEntitlement,
  paidUntilMs,
  planOf,
} from "../../server/billing/entitlements.mjs";
import { memoryStore, readOnlyStore, StoreError, SupabaseStore } from "../../server/billing/store.mjs";
import { signWebhookPayload, verifyWebhookSignature } from "../../server/billing/stripe.mjs";
import {
  checkoutRoute,
  entitlementRoute,
  portalRoute,
  verifyAccessToken,
  webhookRoute,
} from "../../server/billing/server.mjs";

/* --------------------------------- fixtures -------------------------------- */

const S = 1000;
const DAY = 86_400 * S;
/** The moment the suite stands at: 2026-10-29T12:00:00Z. */
const NOW = Date.UTC(2026, 9, 29, 12, 0, 0);

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER_USER = "22222222-2222-4222-8222-222222222222";
const CUSTOMER = "cus_test_1";
const SUB = "sub_test_1";

const MONTHLY = "price_monthly_test";
const YEARLY = "price_yearly_test";

/** An environment that would boot, with placeholder values and no real key. */
function goodEnv(overrides = {}) {
  return {
    STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: "whsec_placeholder",
    STRIPE_PRICE_MONTHLY: MONTHLY,
    STRIPE_PRICE_YEARLY: YEARLY,
    SUPABASE_URL: "https://project.invalid",
    SUPABASE_SERVICE_KEY: "service_role_placeholder",
    SUPABASE_JWT_SECRET: "jwt_secret_placeholder",
    PORT: "8787",
    APP_ORIGIN: "https://app.invalid",
    ...overrides,
  };
}

function goodConfig(overrides = {}) {
  const result = readConfig(goodEnv(overrides));
  assert.equal(result.ok, true, `fixture config should be valid: ${result.message}`);
  return result.config;
}

/** A subscription, with the modern item-level billing period. */
function subscription(overrides = {}) {
  const {
    status = "active",
    periodEnd = NOW + 30 * DAY,
    trialEnd = null,
    price = MONTHLY,
    customer = CUSTOMER,
    id = SUB,
  } = overrides;
  const sub = {
    id,
    status,
    customer,
    items: { data: [{ price: { id: price }, current_period_end: Math.floor(periodEnd / S) }] },
  };
  if (trialEnd !== null) sub.trial_end = Math.floor(trialEnd / S);
  return sub;
}

let sequence = 0;
/** A Stripe event around an object. */
function event(type, object, { id, created = Math.floor(NOW / S) } = {}) {
  sequence += 1;
  return { id: id ?? `evt_test_${sequence}`, type, created, data: { object } };
}

/** A store with the reader already linked to the customer, as checkout leaves it. */
function linkedStore(extra = {}) {
  return memoryStore({ customers: [{ userId: USER, customerId: CUSTOMER }], ...extra });
}

/** The Stripe double: records what it was asked, answers from fixtures. */
function fakeStripe({ subscription: sub = subscription() } = {}) {
  const calls = { customers: [], checkout: [], portal: [], subscriptions: [] };
  return {
    calls,
    async createCustomer({ userId }) {
      calls.customers.push(userId);
      return CUSTOMER;
    },
    async createCheckoutSession(params) {
      calls.checkout.push(params);
      return { id: "cs_test_1", url: "https://checkout.invalid/cs_test_1" };
    },
    async createPortalSession(params) {
      calls.portal.push(params);
      return { id: "bps_test_1", url: "https://portal.invalid/bps_test_1" };
    },
    async retrieveSubscription(id) {
      calls.subscriptions.push(id);
      return sub;
    },
  };
}

/** A verified identity, standing in for the JWT check. */
const auth = { userId: async (token) => (token === "good_token" ? USER : null) };

/** Posts one signed event through the real webhook route. */
async function deliver({ store, stripe, event: payload, config, at = NOW }) {
  const raw = Buffer.from(JSON.stringify(payload));
  const signature = signWebhookPayload(raw, config.webhookSecret, Math.floor(at / S));
  return webhookRoute({ raw, signature, config, store, stripe, now: () => at });
}

/* --------------------------------------------------------------------------
 * 1. Configuration: refused by name, never echoed
 * ----------------------------------------------------------------------- */

test("config names every missing setting in one message", () => {
  const result = readConfig({});
  assert.equal(result.ok, false);
  assert.equal(result.config, null);
  assert.deepEqual(result.missing, REQUIRED);
  for (const name of REQUIRED) {
    assert.ok(result.message.includes(name), `message should name ${name}`);
  }
  assert.equal(result.missing.length, REQUIRED.length);
});

test("config refuses a partial environment and names only what is absent", () => {
  const env = goodEnv();
  delete env.STRIPE_WEBHOOK_SECRET;
  env.SUPABASE_SERVICE_KEY = "   ";
  const result = readConfig(env);
  assert.equal(result.ok, false);
  assert.deepEqual(result.missing, ["STRIPE_WEBHOOK_SECRET", "SUPABASE_SERVICE_KEY"]);
  assert.ok(result.message.includes("STRIPE_WEBHOOK_SECRET"));
  assert.ok(result.message.includes("SUPABASE_SERVICE_KEY"));
});

test("config accepts a complete environment and normalises the origin", () => {
  const result = readConfig(goodEnv({ APP_ORIGIN: "https://app.invalid/" }));
  assert.equal(result.ok, true);
  assert.equal(result.config.appOrigin, "https://app.invalid");
  assert.equal(result.config.prices.monthly, MONTHLY);
  assert.equal(result.config.graceMs, GRACE_MS);
});

test("config rejects a port that is not a port, and an origin with a path", () => {
  const result = readConfig(goodEnv({ PORT: "eighty", APP_ORIGIN: "https://app.invalid/deep" }));
  assert.equal(result.ok, false);
  assert.equal(result.missing.length, 0);
  assert.equal(result.problems.length, 2);
});

/* --------------------------------------------------------------------------
 * 2. Checkout: the price comes from the environment, never from the body
 * ----------------------------------------------------------------------- */

test("checkout uses the configured price and ignores a price id in the body", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const stripe = fakeStripe();

  const result = await checkoutRoute({
    token: "good_token",
    body: { plan: "monthly", priceId: "price_attacker", price: "price_attacker", amount: 1 },
    config,
    store,
    stripe,
    auth,
    now: () => NOW,
  });

  assert.equal(result.status, 200);
  assert.equal(stripe.calls.checkout.length, 1);
  assert.equal(stripe.calls.checkout[0].priceId, config.prices.monthly);
  assert.notEqual(stripe.calls.checkout[0].priceId, "price_attacker");
  // Only the URL crosses the wire; the price and the customer do not.
  assert.deepEqual(Object.keys(result.body), ["url"]);
});

test("checkout maps the yearly plan to the yearly price, and refuses a plan it does not sell", async () => {
  const config = goodConfig();
  const stripe = fakeStripe();

  const yearly = await checkoutRoute({
    token: "good_token",
    body: { plan: "yearly" },
    config,
    store: linkedStore(),
    stripe,
    auth,
    now: () => NOW,
  });
  assert.equal(yearly.status, 200);
  assert.equal(stripe.calls.checkout[0].priceId, YEARLY);

  const bogus = await checkoutRoute({
    token: "good_token",
    body: { plan: "lifetime", priceId: MONTHLY },
    config,
    store: linkedStore(),
    stripe,
    auth,
    now: () => NOW,
  });
  assert.equal(bogus.status, 400);
  assert.equal(bogus.body.error, "unknown_plan");
  assert.equal(stripe.calls.checkout.length, 1, "no session for an unknown plan");
});

test("checkout refuses a request with no identity, and writes no link for one", async () => {
  const store = linkedStore();
  const result = await checkoutRoute({
    token: null,
    body: { plan: "monthly" },
    config: goodConfig(),
    store,
    stripe: fakeStripe(),
    auth,
    now: () => NOW,
  });
  assert.equal(result.status, 401);
  assert.equal(store.snapshot().writes, 0);
});

test("checkout links the reader to a customer before the session exists", async () => {
  const store = memoryStore();
  const stripe = fakeStripe();
  const result = await checkoutRoute({
    token: "good_token",
    body: { plan: "monthly" },
    config: goodConfig(),
    store,
    stripe,
    auth,
    now: () => NOW,
  });
  assert.equal(result.status, 200);
  assert.deepEqual(stripe.calls.customers, [USER]);
  assert.equal(await store.customerFor(USER), CUSTOMER);
  assert.equal(await store.userForCustomer(CUSTOMER), USER);
});

test("the portal comes from the link table, so a reader without one is told so", async () => {
  const config = goodConfig();
  const stripe = fakeStripe();

  const linked = await portalRoute({ token: "good_token", config, store: linkedStore(), stripe, auth, now: () => NOW });
  assert.equal(linked.status, 200);
  assert.equal(stripe.calls.portal[0].customerId, CUSTOMER);

  const unlinked = await portalRoute({ token: "good_token", config, store: memoryStore(), stripe, auth, now: () => NOW });
  assert.equal(unlinked.status, 404);
  assert.equal(unlinked.body.error, "no_customer");
});

/* --------------------------------------------------------------------------
 * 3. Identity: a Supabase JWT, checked here because the secret is here
 * ----------------------------------------------------------------------- */

function mintToken(claims, secret, algorithm = "HS256") {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${signature}`;
}

test("a token signed with the project secret names its reader; a tampered one names nobody", () => {
  const secret = "jwt_secret_placeholder";
  const good = mintToken({ sub: USER, exp: Math.floor(NOW / S) + 600 }, secret);
  const verified = verifyAccessToken(good, secret, { nowMs: NOW });
  assert.equal(verified.ok, true);
  assert.equal(verified.userId, USER);

  assert.equal(verifyAccessToken(good, "some_other_secret", { nowMs: NOW }).ok, false);
  assert.equal(verifyAccessToken(`${good}x`, secret, { nowMs: NOW }).ok, false);
  assert.equal(verifyAccessToken(mintToken({ sub: USER, exp: Math.floor(NOW / S) - 1 }, secret), secret, { nowMs: NOW }).reason, "expired");

  // `alg: none` is the attack this line exists for.
  const unsigned = `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(
    JSON.stringify({ sub: USER }),
  ).toString("base64url")}.`;
  assert.equal(verifyAccessToken(unsigned, secret, { nowMs: NOW }).ok, false);
});

/* --------------------------------------------------------------------------
 * 4. The webhook signature: computed with node:crypto, checked by the service
 * ----------------------------------------------------------------------- */

test("a signature computed over the raw body is accepted, and a wrong secret is not", () => {
  const secret = "whsec_placeholder";
  const raw = Buffer.from(JSON.stringify(event("invoice.paid", { id: "in_test" })));
  const at = Math.floor(NOW / S);

  // Built here, by hand, from the rule: sha256 over "<t>.<raw bytes>".
  const digest = createHmac("sha256", secret).update(`${at}.`).update(raw).digest("hex");
  const header = `t=${at},v1=${digest}`;

  assert.deepEqual(verifyWebhookSignature(raw, header, secret, { nowSeconds: at }), { ok: true });
  assert.equal(verifyWebhookSignature(raw, header, "whsec_someone_else", { nowSeconds: at }).ok, false);
  assert.equal(verifyWebhookSignature(raw, `t=${at},v1=${"0".repeat(64)}`, secret, { nowSeconds: at }).ok, false);
  assert.equal(verifyWebhookSignature(raw, null, secret, { nowSeconds: at }).reason, "missing_header");
});

test("a re-encoded body fails even when it parses to the same JSON", () => {
  const secret = "whsec_placeholder";
  const at = Math.floor(NOW / S);
  const original = Buffer.from('{"id":"evt_1","type":"invoice.paid","created":1}');
  const header = signWebhookPayload(original, secret, at);

  const reordered = Buffer.from(JSON.stringify(JSON.parse(original.toString()), null, 2));
  assert.equal(verifyWebhookSignature(reordered, header, secret, { nowSeconds: at }).ok, false);
});

test("a stale timestamp is refused even with a correct signature", () => {
  const secret = "whsec_placeholder";
  const raw = Buffer.from("{}");
  const at = Math.floor(NOW / S);
  const header = signWebhookPayload(raw, secret, at);

  assert.equal(verifyWebhookSignature(raw, header, secret, { nowSeconds: at + 299 }).ok, true);
  assert.equal(verifyWebhookSignature(raw, header, secret, { nowSeconds: at + 301 }).reason, "stale_timestamp");
});

test("the webhook route refuses an unsigned body and writes nothing", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const raw = Buffer.from(JSON.stringify(event("customer.subscription.updated", subscription())));
  const signature = signWebhookPayload(raw, "whsec_someone_else", Math.floor(NOW / S));

  const result = await webhookRoute({ raw, signature, config, store, stripe: fakeStripe(), now: () => NOW });

  assert.equal(result.status, 400);
  assert.equal(result.body.error, "bad_signature");
  assert.equal(store.snapshot().writes, 0);
  assert.equal(store.snapshot().events.size, 0);
});

/* --------------------------------------------------------------------------
 * 5. Dedupe: an event id is applied once
 * ----------------------------------------------------------------------- */

test("a duplicate event id is applied once", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const stripe = fakeStripe();
  const payload = event("customer.subscription.updated", subscription({ periodEnd: NOW + 30 * DAY }));

  const first = await deliver({ store, stripe, event: payload, config });
  const second = await deliver({ store, stripe, event: payload, config });

  assert.equal(first.status, 200);
  assert.equal(first.body.outcome, "applied");
  assert.equal(second.status, 200);
  assert.equal(second.body.outcome, "duplicate");
  assert.equal(store.snapshot().writes, 1, "one write for two deliveries");
  assert.equal(store.snapshot().events.size, 1);
  assert.equal((await store.getByUser(USER)).cloudSync, true);
});

test("the state machine itself refuses an event id it has already seen", () => {
  const payload = event("customer.subscription.updated", subscription());
  const result = applyStripeEvent(emptyEntitlement(), payload, {
    nowMs: NOW,
    prices: { monthly: MONTHLY, yearly: YEARLY },
    seenEventIds: new Set([payload.id]),
  });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, "duplicate");
  assert.equal(result.state.cloudSync, false, "a refusal never writes");
});

/* --------------------------------------------------------------------------
 * 6. Out of order: a late delivery does not win
 * ----------------------------------------------------------------------- */

test("an event older than the newest applied one is ignored", async () => {
  const config = goodConfig();
  const newest = event("customer.subscription.deleted", subscription({ periodEnd: NOW + 30 * DAY }), {
    created: Math.floor(NOW / S),
  });
  const store = linkedStore({
    entitlements: [{ userId: USER, state: { cloudSync: false, source: "stripe", expiresAt: null } }],
    events: [{ eventId: newest.id, subscriptionId: SUB, created: newest.created }],
  });

  const late = event("customer.subscription.updated", subscription(), {
    created: newest.created - 60,
  });
  const result = await deliver({ store, stripe: fakeStripe(), event: late, config });

  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, "stale");
  assert.equal(store.snapshot().writes, 0, "a stale event writes nothing");
  assert.equal((await store.getByUser(USER)).cloudSync, false);
});

test("two events in the same second both apply, because Stripe's clock has one-second resolution", () => {
  const at = Math.floor(NOW / S);
  const result = applyStripeEvent(
    emptyEntitlement(),
    event("customer.subscription.updated", subscription(), { created: at }),
    { nowMs: NOW, prices: { monthly: MONTHLY, yearly: YEARLY }, lastEventCreated: at },
  );
  assert.equal(result.ok, true);
});

/* --------------------------------------------------------------------------
 * 7. Cancelling is not revoking
 * ----------------------------------------------------------------------- */

test("subscription.deleted before the period end keeps cloud_sync, then the date flips it", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const periodEnd = NOW + 10 * DAY;

  const deleted = await deliver({
    store,
    stripe: fakeStripe(),
    event: event("customer.subscription.deleted", subscription({ status: "canceled", periodEnd })),
    config,
  });
  assert.equal(deleted.body.outcome, "applied");

  const row = await store.getByUser(USER);
  assert.equal(row.cloudSync, true, "cancelled today, paid until the period ends");
  assert.equal(row.expiresAt, periodEnd);

  // Nothing runs at midnight: the read path applies the date, so the same row
  // answers false the moment the period it paid for is over.
  assert.equal(effectiveEntitlement(row, periodEnd - 1).cloudSync, true);
  assert.equal(effectiveEntitlement(row, periodEnd + 1).cloudSync, false);

  const late = await entitlementRoute({
    token: "good_token",
    config,
    store: readOnlyStore(store),
    auth,
    now: () => periodEnd + 1,
  });
  assert.equal(late.body.cloudSync, false);
});

test("subscription.deleted after the period end revokes on arrival", () => {
  const periodEnd = NOW - DAY;
  const result = applyStripeEvent(
    { cloudSync: true, source: "stripe", expiresAt: periodEnd },
    event("customer.subscription.deleted", subscription({ status: "canceled", periodEnd })),
    { nowMs: NOW, prices: { monthly: MONTHLY, yearly: YEARLY } },
  );
  assert.equal(result.ok, true);
  assert.equal(result.state.cloudSync, false);
  assert.equal(result.state.expiresAt, periodEnd);
});

test("a cancelled subscription that is still paid up grants; an unpaid one that never paid does not", () => {
  const prices = { monthly: MONTHLY, yearly: YEARLY };
  const cancelled = applyStripeEvent(
    emptyEntitlement(),
    event("customer.subscription.updated", subscription({ status: "canceled", periodEnd: NOW + 5 * DAY })),
    { nowMs: NOW, prices },
  );
  assert.equal(cancelled.state.cloudSync, true);

  const incomplete = applyStripeEvent(
    emptyEntitlement(),
    event("customer.subscription.updated", subscription({ status: "incomplete", periodEnd: NOW + 5 * DAY })),
    { nowMs: NOW, prices },
  );
  assert.equal(incomplete.state.cloudSync, false, "nothing was bought");

  const paused = applyStripeEvent(
    { cloudSync: true, source: "stripe", expiresAt: NOW + 5 * DAY },
    event("customer.subscription.updated", subscription({ status: "paused" })),
    { nowMs: NOW, prices },
  );
  assert.equal(paused.state.cloudSync, false);
});

/* --------------------------------------------------------------------------
 * 8. Grace: a failed payment, and the payment that clears it
 * ----------------------------------------------------------------------- */

test("invoice.payment_failed starts grace, and a later successful invoice clears it", () => {
  const prices = { monthly: MONTHLY, yearly: YEARLY };
  const periodEnd = NOW + 2 * DAY;

  const failed = applyStripeEvent(
    { cloudSync: true, source: "stripe", expiresAt: periodEnd },
    event("invoice.payment_failed", { id: "in_test_1", customer: CUSTOMER, subscription: SUB }),
    { nowMs: NOW, prices, subscription: subscription({ status: "past_due", periodEnd }) },
  );
  assert.equal(failed.ok, true);
  assert.equal(failed.state.cloudSync, true, "the card failed; the reader is not cut off");
  assert.equal(failed.state.expiresAt, periodEnd + GRACE_MS, "the window runs from the period end");
  assert.equal(effectiveEntitlement(failed.state, periodEnd + GRACE_MS - 1).cloudSync, true);
  assert.equal(effectiveEntitlement(failed.state, periodEnd + GRACE_MS + 1).cloudSync, false);

  const paid = applyStripeEvent(
    failed.state,
    event("invoice.paid", { id: "in_test_2", customer: CUSTOMER, subscription: SUB }, { created: Math.floor(NOW / S) + 60 }),
    { nowMs: NOW + DAY, prices, subscription: subscription({ status: "active", periodEnd: NOW + 30 * DAY }) },
  );
  assert.equal(paid.ok, true);
  assert.equal(paid.state.cloudSync, true);
  assert.equal(paid.state.expiresAt, NOW + 30 * DAY, "expires_at goes back to the period the money bought");
  assert.notEqual(paid.state.expiresAt, failed.state.expiresAt, "the grace date is gone");
});

test("the grace window is configurable", () => {
  const prices = { monthly: MONTHLY, yearly: YEARLY };
  const result = applyStripeEvent(
    emptyEntitlement(),
    event("invoice.payment_failed", { id: "in_test_3", customer: CUSTOMER, subscription: SUB }),
    {
      nowMs: NOW,
      prices,
      graceMs: DAY,
      subscription: subscription({ status: "past_due", periodEnd: NOW }),
    },
  );
  assert.equal(result.state.expiresAt, NOW + DAY);
});

test("a failed payment for a card that failed on the due date still gets the whole window", () => {
  const prices = { monthly: MONTHLY, yearly: YEARLY };
  const periodEnd = NOW - 2 * DAY;
  const result = applyStripeEvent(
    emptyEntitlement(),
    event("invoice.payment_failed", { id: "in_test_4", customer: CUSTOMER, subscription: SUB }),
    { nowMs: NOW, prices, subscription: subscription({ status: "past_due", periodEnd }) },
  );
  assert.equal(result.state.expiresAt, NOW + GRACE_MS, "counted from now, not from the lapsed period");
});

/* --------------------------------------------------------------------------
 * 9. What the webhook is not allowed to believe
 * ----------------------------------------------------------------------- */

test("a user id in the payload grants that user nothing; the link table decides", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const payload = event("customer.subscription.created", {
    ...subscription(),
    metadata: { supabase_user_id: OTHER_USER },
    user_id: OTHER_USER,
    client_reference_id: OTHER_USER,
  });

  const result = await deliver({ store, stripe: fakeStripe(), event: payload, config });

  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, "applied");
  assert.equal((await store.getByUser(USER)).cloudSync, true, "the linked reader is granted");
  assert.equal(await store.getByUser(OTHER_USER), null, "the user id in the body is ignored");
});

test("an event for a customer nobody linked is acknowledged and grants nothing", async () => {
  const config = goodConfig();
  const store = memoryStore();
  const payload = event("customer.subscription.created", subscription({ customer: "cus_stranger" }));

  const result = await deliver({ store, stripe: fakeStripe(), event: payload, config });

  assert.equal(result.status, 200);
  assert.equal(result.body.outcome, "ignored");
  assert.equal(result.body.reason, "unknown_customer");
  assert.equal(store.snapshot().writes, 0);
});

test("a subscription on a price this shop does not sell grants nothing", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const payload = event("customer.subscription.created", subscription({ price: "price_penny" }));

  const result = await deliver({ store, stripe: fakeStripe(), event: payload, config });

  assert.equal(result.status, 200);
  assert.equal(result.body.reason, "price_not_sold");
  assert.equal(store.snapshot().writes, 0);
  assert.equal(planOf(subscription({ price: "price_penny" }), config.prices), null);
});

test("a one-off checkout is not a subscription and grants nothing", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const payload = event("checkout.session.completed", { id: "cs_test_1", mode: "payment", customer: CUSTOMER });

  const result = await deliver({ store, stripe: fakeStripe(), event: payload, config });
  assert.equal(result.body.reason, "not_a_subscription");
  assert.equal(store.snapshot().writes, 0);
});

test("checkout.session.completed asks Stripe what the subscription is now", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const stripe = fakeStripe({ subscription: subscription({ periodEnd: NOW + 365 * DAY }) });
  const payload = event("checkout.session.completed", {
    id: "cs_test_1",
    mode: "subscription",
    customer: CUSTOMER,
    subscription: SUB,
  });

  const result = await deliver({ store, stripe, event: payload, config });

  assert.equal(result.body.outcome, "applied");
  assert.deepEqual(stripe.calls.subscriptions, [SUB]);
  assert.equal((await store.getByUser(USER)).expiresAt, NOW + 365 * DAY);
});

test("an event type nobody handles is acknowledged and dropped", async () => {
  const config = goodConfig();
  const store = linkedStore();
  const result = await deliver({
    store,
    stripe: fakeStripe(),
    event: event("customer.discount.created", { id: "di_test" }),
    config,
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.reason, "event_not_handled");
  assert.equal(store.snapshot().writes, 0);
});

test("a trial that ends after the period is honoured to the trial end", () => {
  const prices = { monthly: MONTHLY, yearly: YEARLY };
  const sub = subscription({ status: "trialing", periodEnd: NOW + 7 * DAY, trialEnd: NOW + 21 * DAY });
  assert.equal(paidUntilMs(sub), NOW + 21 * DAY);

  const result = applyStripeEvent(emptyEntitlement(), event("customer.subscription.created", sub), {
    nowMs: NOW,
    prices,
  });
  assert.equal(result.state.cloudSync, true);
  assert.equal(result.state.expiresAt, NOW + 21 * DAY);
});

/* --------------------------------------------------------------------------
 * 10. The read path cannot write
 * ----------------------------------------------------------------------- */

test("the read-only view used by GET /entitlement refuses every write", async () => {
  const store = memoryStore();
  await store.upsert(USER, { cloudSync: true, source: "stripe", expiresAt: null });

  const reader = readOnlyStore(store);
  assert.equal((await reader.getByUser(USER)).cloudSync, true);

  assert.throws(() => reader.upsert(USER, { cloudSync: true, source: "stripe", expiresAt: null }), StoreError);
  assert.throws(() => reader.linkCustomer(USER, "cus_self_served"), StoreError);
  assert.throws(() => reader.rememberEvent({ eventId: "evt_forged" }), StoreError);

  // And the store behind it is unchanged.
  assert.equal(store.snapshot().writes, 1);
  assert.equal(await store.customerFor(USER), null);
  assert.equal(store.snapshot().events.size, 0);
});

test("GET /entitlement answers with the row, already expired where the date says so", async () => {
  const config = goodConfig();
  const store = linkedStore({
    entitlements: [{ userId: USER, state: { cloudSync: true, source: "stripe", expiresAt: NOW - DAY } }],
  });

  const result = await entitlementRoute({
    token: "good_token",
    config,
    store: readOnlyStore(store),
    auth,
    now: () => NOW,
  });

  assert.equal(result.status, 200);
  assert.equal(result.body.cloudSync, false);
  assert.equal(result.body.expiresAt, new Date(NOW - DAY).toISOString());
  assert.equal(result.body.source, "stripe");
  assert.equal(store.snapshot().writes, 0, "reading is not writing");
});

test("GET /entitlement refuses a caller with no identity", async () => {
  const result = await entitlementRoute({
    token: null,
    config: goodConfig(),
    store: readOnlyStore(memoryStore()),
    auth,
    now: () => NOW,
  });
  assert.equal(result.status, 401);
});

/* --------------------------------------------------------------------------
 * 11. The Supabase store holds the only key that can write
 * ----------------------------------------------------------------------- */

test("the Supabase store cannot be constructed without a service key", () => {
  assert.throws(() => new SupabaseStore({ url: "https://project.invalid" }), StoreError);
  assert.throws(() => new SupabaseStore({ url: "https://project.invalid", serviceKey: "" }), StoreError);
  assert.throws(() => new SupabaseStore({ url: "", serviceKey: "k" }), StoreError);
  const store = new SupabaseStore({ url: "https://project.invalid", serviceKey: "service_role_placeholder" });
  assert.equal(store.url, "https://project.invalid");
});

test("the Supabase store translates the row shape both ways, over an injected fetch", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, method: init.method, headers: init.headers, body: init.body });
    if (init.method === "GET") {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            { cloud_sync: true, source: "stripe", expires_at: new Date(NOW + DAY).toISOString() },
          ]),
      };
    }
    return { ok: true, status: 201, text: async () => "" };
  };

  const store = new SupabaseStore({ url: "https://project.invalid", serviceKey: "service_role_placeholder", fetch: fetchImpl });
  const row = await store.getByUser(USER);
  assert.equal(row.cloudSync, true);
  assert.equal(row.expiresAt, NOW + DAY, "a timestamptz comes back as milliseconds");

  await store.upsert(USER, { cloudSync: true, source: "stripe", expiresAt: NOW + DAY });
  const write = seen[1];
  assert.equal(write.method, "POST");
  assert.equal(write.headers.apikey, "service_role_placeholder");
  assert.equal(write.headers["Prefer"], "resolution=merge-duplicates,return=minimal");
  assert.deepEqual(JSON.parse(write.body), [
    { user_id: USER, cloud_sync: true, source: "stripe", expires_at: new Date(NOW + DAY).toISOString() },
  ]);
});
