/**
 * The billing service: five routes on `node:http`, no dependencies.
 *
 *   POST /checkout        verified JWT in, Checkout URL out
 *   POST /portal          verified JWT in, billing-portal URL out
 *   GET  /entitlement     verified JWT in, the caller's own row out
 *   POST /stripe/webhook  signed event in, `cloud_sync` written
 *   GET  /health          is this process up, and is it configured
 *
 * The split of responsibility is the whole design, and every line below is a
 * consequence of one of these:
 *
 * - the app sends a **plan name** and a **JWT**, and never a price id, a customer
 *   id or a user id. A price id from a body would be a client deciding what
 *   something costs;
 * - checkout writes the **customer-to-reader link** from the verified JWT, before
 *   any money moves. That link is the only thing that makes a payment
 *   attributable;
 * - `GET /entitlement` is given a store that cannot write (see `readOnlyStore`),
 *   so the route the app calls most is structurally incapable of granting
 *   anything;
 * - the webhook never reads a user id from the body. It reads a customer id,
 *   looks the reader up in the link table, and refuses to guess;
 * - no card data passes through here at all: Checkout and the portal are pages on
 *   Stripe's domain, and this service only ever sees URLs and events.
 *
 * The HTTP layer is deliberately thin: each route is an exported function that
 * takes plain values and returns `{ status, body }`, so the suite can drive a
 * route without a socket and the adapter has nothing to get wrong except bytes.
 */
import { createServer } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import { describeConfig, readConfig } from "./config.mjs";
import { applyStripeEvent, effectiveEntitlement, emptyEntitlement, HANDLED_EVENTS } from "./entitlements.mjs";
import { createStripeClient, SIGNATURE_HEADER, verifyWebhookSignature } from "./stripe.mjs";
import { readOnlyStore, StoreError, SupabaseStore } from "./store.mjs";

/** The largest body any route will read, in bytes. */
export const MAX_BODY_BYTES = 256 * 1024;

/** A logger with the same shape as `console`, and no output. */
export const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

/** The two things a reader can buy. A name, never a price. */
const PLANS = Object.freeze(["monthly", "yearly"]);

/* --------------------------------- the routes -------------------------------- */

/**
 * A Checkout Session for the plan the reader named.
 *
 * The body is read for exactly one field, `plan`, and validated against the two
 * names this shop knows. Anything else in the body — `priceId`, `price`,
 * `line_items`, `customer`, `amount` — is ignored, because the price comes from
 * `config.prices`, which came from the environment. A test asserts that a body
 * carrying a price id still produces a session for the configured price.
 *
 * @param {object} args
 */
export async function checkoutRoute({ token, body, config, store, stripe, auth = null, now = () => Date.now(), log = silentLog }) {
  const userId = await resolveUser(token, config, auth, now);
  if (userId === null) return { status: 401, body: { error: "not_signed_in" } };

  const plan = body?.plan;
  if (!PLANS.includes(plan)) return { status: 400, body: { error: "unknown_plan" } };

  // Read from configuration, keyed by the plan *name*. There is no code path
  // that reads a price id out of `body`, which is why there is nothing here to
  // get wrong later.
  const priceId = config.prices[plan];
  if (typeof priceId !== "string" || priceId === "") {
    return { status: 400, body: { error: "plan_not_offered", plan } };
  }

  try {
    let customerId = await store.customerFor(userId);
    if (customerId === null) {
      // Written before the session exists: if the purchase completes, the
      // webhook has a link to follow. If it does not, an unused customer sits in
      // Stripe, which costs nothing.
      const created = await stripe.createCustomer({ userId });
      await store.linkCustomer(userId, created);
      customerId = created;
    }

    const session = await stripe.createCheckoutSession({
      customerId,
      priceId,
      userId,
      successUrl: `${config.appOrigin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: `${config.appOrigin}/?checkout=cancelled`,
    });

    log.info("checkout_created", { plan, customer: customerId, session: session.id });
    // Only the URL crosses the wire. No price, no customer, no secret.
    return { status: 200, body: { url: session.url } };
  } catch (cause) {
    // Stripe or the database did not answer. 502, because the request was
    // well-formed and the reader did nothing wrong, and the message is ours
    // rather than Stripe's so nothing about the account reaches a browser.
    log.error("checkout_failed", { plan, error: String(cause?.message ?? cause) });
    return { status: 502, body: { error: "billing_unavailable" } };
  }
}

/**
 * Where a reader cancels, changes their card, or reads an invoice.
 *
 * No body is read. The customer comes from the link table, keyed by the verified
 * JWT, so a token can only ever open the portal of the account it belongs to. A
 * reader who has never bought anything has no customer and is told so, rather
 * than being handed a portal for a customer this service would have had to
 * invent.
 *
 * @param {object} args
 */
export async function portalRoute({ token, config, store, stripe, auth = null, now = () => Date.now(), log = silentLog }) {
  const userId = await resolveUser(token, config, auth, now);
  if (userId === null) return { status: 401, body: { error: "not_signed_in" } };

  let customerId;
  try {
    customerId = await store.customerFor(userId);
  } catch (cause) {
    log.error("portal_failed", { step: "customer", error: String(cause?.message ?? cause) });
    return { status: 502, body: { error: "billing_unavailable" } };
  }
  if (customerId === null) return { status: 404, body: { error: "no_customer" } };

  try {
    const session = await stripe.createPortalSession({
      customerId,
      returnUrl: `${config.appOrigin}/?portal=done`,
    });
    log.info("portal_created", { customer: customerId, session: session.id });
    return { status: 200, body: { url: session.url } };
  } catch (cause) {
    log.error("portal_failed", { step: "session", error: String(cause?.message ?? cause) });
    return { status: 502, body: { error: "billing_unavailable" } };
  }
}

/**
 * The caller's own entitlement.
 *
 * `store` here is the read-only view, and it has no `upsert` to call. The
 * response carries the *effective* answer — `cloud_sync` with `expires_at`
 * already applied — so a client cannot decide its own entitlement by comparing a
 * date, and a lapsed row reads as false without anything having to run.
 *
 * @param {object} args
 */
export async function entitlementRoute({ token, config, store, auth = null, now = () => Date.now(), log = silentLog }) {
  const userId = await resolveUser(token, config, auth, now);
  if (userId === null) return { status: 401, body: { error: "not_signed_in" } };

  let state;
  try {
    state = await store.getByUser(userId);
  } catch (cause) {
    log.error("entitlement_failed", { error: String(cause?.message ?? cause) });
    return { status: 502, body: { error: "billing_unavailable" } };
  }

  const view = effectiveEntitlement(state ?? emptyEntitlement(), now());
  return {
    status: 200,
    body: {
      cloudSync: view.cloudSync,
      expiresAt: view.expiresAt === null ? null : new Date(view.expiresAt).toISOString(),
      source: view.source,
    },
  };
}

/**
 * Stripe's events, as the only thing that writes a grant.
 *
 * The order of the steps is the security model, so it is worth reading in order:
 *
 * 1. the signature is checked over the raw bytes, before anything is parsed;
 * 2. the event id is checked against what has already been applied;
 * 3. the subscription is read from Stripe (not just from the body) for the
 *    events whose body is not one;
 * 4. the customer is resolved to a reader through the link table — never through
 *    a user id in the payload;
 * 5. the pure state machine decides, and only then is anything written.
 *
 * A refusal is a 200. Stripe retries a 5xx and gives up on a 4xx, so a duplicate
 * or an unsold price must be acknowledged: retrying it a hundred times would
 * change nothing, and a 4xx would look like an outage in Stripe's dashboard.
 *
 * @param {object} args
 */
export async function webhookRoute({ raw, signature, config, store, stripe, now = () => Date.now(), log = silentLog }) {
  const bytes = raw instanceof Uint8Array ? raw : Buffer.from(raw ?? "");
  if (bytes.byteLength > MAX_BODY_BYTES) return { status: 413, body: { error: "too_large" } };

  const verified = verifyWebhookSignature(bytes, signature, config.webhookSecret, {
    nowSeconds: Math.floor(now() / 1000),
  });
  if (!verified.ok) {
    log.warn("webhook_unsigned", { reason: verified.reason });
    return { status: 400, body: { error: "bad_signature", reason: verified.reason } };
  }

  let event;
  try {
    event = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { status: 400, body: { error: "bad_json" } };
  }

  const type = typeof event?.type === "string" ? event.type : "";
  const eventId = typeof event?.id === "string" ? event.id : "";
  if (eventId === "" || type === "") return { status: 400, body: { error: "bad_event" } };

  if (!HANDLED_EVENTS.includes(type)) return ack("event_not_handled");

  try {
    if (await store.seenEvent(eventId)) return ack("duplicate", "duplicate");

    const subject = await subjectOfEvent(event, stripe);
    if (!subject.ok) return ack(subject.reason);

    const userId = await store.userForCustomer(subject.customerId);
    if (userId === null) {
      // A customer this service did not link at checkout belongs to nobody here.
      // Guessing from the body would be letting the payload choose the account.
      log.warn("webhook_unlinked_customer", { id: eventId, type });
      return ack("unknown_customer");
    }

    const state = await store.getByUser(userId);
    const result = applyStripeEvent(state ?? emptyEntitlement(), event, {
      nowMs: now(),
      graceMs: config.graceMs,
      prices: config.prices,
      subscription: subject.subscription,
      lastEventCreated: await store.lastEventAt(subject.subscriptionId),
    });

    if (!result.ok) {
      // "incomplete" means Stripe could not be asked what the subscription is
      // now, which is a retryable condition rather than a decision: the event id
      // has not been spent, so the retry does the whole thing.
      if (result.outcome === "incomplete") {
        log.error("webhook_incomplete", { id: eventId, type, reason: result.reason });
        return { status: 502, body: { error: "stripe_unavailable" } };
      }
      return ack(result.reason, result.outcome);
    }

    // Claim the id, then write. The order is deliberate: the state machine is
    // deterministic, so a crash between the two leaves an event that is replayed
    // into the same value, while the reverse order can lose a grant. Two
    // concurrent deliveries of the same id are decided by the primary key on
    // `stripe_events`, and the worst case is a redundant write of the same row.
    const claimed = await store.rememberEvent({
      eventId,
      type,
      subscriptionId: subject.subscriptionId,
      created: typeof event.created === "number" ? event.created : Math.floor(now() / 1000),
      userId,
      outcome: "applied",
    });
    if (!claimed) return ack("duplicate", "duplicate");

    await store.upsert(userId, result.state);
    log.info("webhook_applied", {
      id: eventId,
      type,
      plan: result.plan,
      cloud_sync: result.state.cloudSync,
    });
    return { status: 200, body: { received: true, outcome: "applied" } };
  } catch (cause) {
    if (cause instanceof StoreError) {
      log.error("webhook_store_failed", { id: eventId, type, error: cause.message });
      return { status: 500, body: { error: "db_unavailable" } };
    }
    throw cause;
  }
}

/**
 * The subscription an event is about, and the customer it belongs to.
 *
 * Three of the events carry the subscription itself, which is the state as of
 * the event. The rest carry an id, so Stripe is asked: its current view is the
 * state of record, and a body replayed an hour later would otherwise apply an
 * hour-old snapshot.
 *
 * @param {Record<string, any>} event
 * @param {object} stripe
 */
async function subjectOfEvent(event, stripe) {
  const object = event?.data?.object ?? {};
  const type = event.type;

  if (type.startsWith("customer.subscription.")) {
    // `.customer` and not `.id`: on a subscription, `.id` is the subscription,
    // and resolving a subscription id as a customer would always miss.
    const customerId = idOf(object.customer);
    if (customerId === null) return { ok: false, reason: "no_customer" };
    return {
      ok: true,
      subscription: object,
      subscriptionId: typeof object.id === "string" ? object.id : null,
      customerId,
    };
  }

  if (type === "checkout.session.completed" && object.mode !== undefined && object.mode !== "subscription") {
    return { ok: false, reason: "not_a_subscription" };
  }

  // `invoice.subscription` is the field on older API versions; newer ones nest
  // it under `parent.subscription_details`. Both are read, because a webhook
  // pinned to an older version is a configuration fact.
  const subscriptionId =
    idOf(object.subscription) ?? idOf(object.parent?.subscription_details?.subscription);
  if (subscriptionId === null) return { ok: false, reason: "no_subscription" };

  const subscription = await stripe.retrieveSubscription(subscriptionId);
  return {
    ok: true,
    subscription,
    subscriptionId,
    customerId: idOf(subscription.customer) ?? idOf(object.customer),
  };
}

/* --------------------------------- the adapter ------------------------------- */

/**
 * Builds the `node:http` request listener.
 *
 * Everything that talks to the outside world is injected, so the suite can drive
 * the real routing, the real signature check and the real state machine against
 * doubles only for the two parties that need the internet.
 *
 * @param {{ config: object, store: object, stripe: object, auth?: object | null, now?: () => number, log?: object }} deps
 */
export function createRequestHandler({ config, store, stripe, auth = null, now = () => Date.now(), log = console }) {
  // Built once, at startup: `GET /entitlement` gets a store with no write
  // methods at all, and the webhook gets the real one.
  const reader = readOnlyStore(store);

  return async function handle(request, response) {
    const url = new URL(request.url ?? "/", "http://localhost");
    const method = (request.method ?? "GET").toUpperCase();

    if (method === "OPTIONS") return send(response, request, config, 204, null);

    try {
      if (method === "GET" && url.pathname === "/health") {
        // What the shop is set up to sell, never a key and never a price id.
        return send(response, request, config, 200, { ok: true, plans: PLANS.slice() });
      }

      if (method === "POST" && url.pathname === "/checkout") {
        const parsed = await readJson(request);
        if (!parsed.ok) return send(response, request, config, parsed.status, parsed.body);
        const result = await checkoutRoute({
          token: bearer(request.headers.authorization),
          body: parsed.body,
          config,
          store,
          stripe,
          auth,
          now,
          log,
        });
        return send(response, request, config, result.status, result.body);
      }

      if (method === "POST" && url.pathname === "/portal") {
        const result = await portalRoute({
          token: bearer(request.headers.authorization),
          config,
          store,
          stripe,
          auth,
          now,
          log,
        });
        return send(response, request, config, result.status, result.body);
      }

      if (method === "GET" && url.pathname === "/entitlement") {
        const result = await entitlementRoute({
          token: bearer(request.headers.authorization),
          config,
          store: reader,
          auth,
          now,
          log,
        });
        return send(response, request, config, result.status, result.body);
      }

      if (method === "POST" && url.pathname === "/stripe/webhook") {
        // No CORS on this one: Stripe is a server, and a browser has no business
        // posting here. The body is read as bytes because that is what was
        // signed.
        const body = await readBody(request);
        if (!body.ok) return send(response, request, config, body.status, body.body);
        const result = await webhookRoute({
          raw: body.bytes,
          signature: request.headers[SIGNATURE_HEADER],
          config,
          store,
          stripe,
          now,
          log,
        });
        return send(response, request, config, result.status, result.body);
      }

      return send(response, request, config, 404, { error: "not_found" });
    } catch (cause) {
      log.error("request_failed", { path: url.pathname, error: String(cause?.message ?? cause) });
      return send(response, request, config, 500, { error: "internal" });
    }
  };
}

/** The server, wired but not listening. */
export function createBillingServer(deps) {
  return createServer(createRequestHandler(deps));
}

/**
 * Reads the environment, refuses loudly, and listens.
 *
 * The refusal names every missing setting in one line and returns null; the
 * caller turns that into an exit code. Returning rather than calling
 * `process.exit` keeps this function usable from a test, which is the only way
 * the refusal itself gets exercised.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export async function main(env = process.env) {
  const result = readConfig(env);
  if (!result.ok) {
    console.error(`billing: refusing to start - ${result.message}`);
    return null;
  }
  const { config } = result;

  const store = new SupabaseStore({
    url: config.supabase.url,
    serviceKey: config.supabase.serviceKey,
  });
  const stripe = createStripeClient({
    secretKey: config.stripeSecretKey,
    apiBase: config.stripeApiBase,
  });

  const server = createBillingServer({ config, store, stripe });
  await new Promise((resolve) => server.listen(config.port, config.host, resolve));
  console.log(JSON.stringify({ event: "billing_listening", ...describeConfig(config) }));
  return server;
}

/* ---------------------------------- helpers --------------------------------- */

/**
 * Whether a Supabase access token is real, and who it belongs to.
 *
 * The signature is checked here rather than by asking the auth server, because
 * the project's signing secret is already in this process's environment and a
 * round trip per request would put the auth server in the path of every
 * entitlement read. HS256 only: `alg: "none"` must never verify, and a project
 * that signs asymmetrically fails closed with `bad_signature` rather than being
 * quietly trusted.
 *
 * Expiry is checked because a token signed an hour ago is still correctly signed
 * and worth nothing.
 *
 * @param {string | null} token
 * @param {string} secret
 * @param {{ nowMs?: number }} [options]
 * @returns {{ ok: true, userId: string, claims: object } | { ok: false, reason: string }}
 */
export function verifyAccessToken(token, secret, options = {}) {
  if (typeof token !== "string" || token === "") return { ok: false, reason: "no_token" };
  if (typeof secret !== "string" || secret === "") return { ok: false, reason: "no_secret" };

  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header;
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header?.alg !== "HS256") return { ok: false, reason: "unsupported_alg" };

  const expected = createHmac("sha256", secret).update(`${encodedHeader}.${encodedPayload}`).digest();
  const given = Buffer.from(encodedSignature, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims;
  try {
    claims = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  if (typeof claims?.exp === "number" && claims.exp <= nowSeconds) return { ok: false, reason: "expired" };
  if (typeof claims?.sub !== "string" || claims.sub === "") return { ok: false, reason: "no_subject" };

  return { ok: true, userId: claims.sub, claims };
}

/**
 * Who is asking: an injected verifier in a test, the real one everywhere else.
 *
 * @param {string | null} token
 * @param {object} config
 * @param {{ userId: (token: string | null) => Promise<string | null> } | null} auth
 * @param {() => number} now
 */
async function resolveUser(token, config, auth, now) {
  if (auth !== null && auth !== undefined) return await auth.userId(token);
  const result = verifyAccessToken(token, config.supabase.jwtSecret, { nowMs: now() });
  return result.ok ? result.userId : null;
}

/** @param {string} reason @param {string} [outcome] */
function ack(reason, outcome = "ignored") {
  return { status: 200, body: { received: true, outcome, reason } };
}

/** A Stripe field that is either an id or an expanded object's id. */
function idOf(value) {
  if (typeof value === "string" && value !== "") return value;
  if (typeof value === "object" && value !== null) {
    const id = value.id;
    if (typeof id === "string" && id !== "") return id;
  }
  return null;
}

/** @param {string | null | undefined} header */
function bearer(header) {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match === null ? null : match[1].trim();
}

/** The body, as bytes, up to a limit. */
function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        finish({ ok: false, status: 413, body: { error: "too_large" } });
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => finish({ ok: true, bytes: Buffer.concat(chunks) }));
    request.on("error", () => finish({ ok: false, status: 400, body: { error: "bad_body" } }));
  });
}

/** The body, as JSON. */
async function readJson(request) {
  const body = await readBody(request);
  if (!body.ok) return body;
  try {
    return { ok: true, body: JSON.parse(body.bytes.toString("utf8") || "{}") };
  } catch {
    return { ok: false, status: 400, body: { error: "bad_json" } };
  }
}

/**
 * Writes a JSON response.
 *
 * CORS is answered for one origin, compared character for character with
 * `config.appOrigin`. Not `*`: this endpoint takes an Authorization header and
 * returns a URL somebody can pay at, and an allow-list of one is a smaller thing
 * to get wrong than a list of headers.
 */
function send(response, request, config, status, body) {
  /** @type {Record<string, string | number>} */
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    Vary: "Origin",
  };

  const origin = request.headers.origin;
  if (typeof origin === "string" && origin === config.appOrigin) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Headers"] = "authorization, content-type";
    headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
    headers["Access-Control-Max-Age"] = "600";
  }

  if (body === null) {
    response.writeHead(status, headers);
    response.end();
    return;
  }

  const text = JSON.stringify(body);
  headers["Content-Type"] = "application/json; charset=utf-8";
  headers["Content-Length"] = Buffer.byteLength(text);
  response.writeHead(status, headers);
  response.end(text);
}

/* ------------------------------- process entry ------------------------------- */

/**
 * Boot only when this file *is* the process. Importing it — from a test, or from
 * anything that wants a route — must not start a listener or read the
 * environment, because a module with a side effect on import cannot be tested.
 */
const entry = process.argv[1] === undefined ? null : pathToFileURL(process.argv[1]).href;
if (entry !== null && entry === import.meta.url) {
  main()
    .then((server) => {
      if (server === null) process.exitCode = 1;
    })
    .catch((cause) => {
      console.error(`billing: failed to start - ${String(cause?.message ?? cause)}`);
      process.exitCode = 1;
    });
}
