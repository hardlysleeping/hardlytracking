/**
 * Stripe, as five requests over `fetch`, and the signature check that goes with
 * them.
 *
 * No SDK. The one thing an SDK is genuinely good for here — verifying a webhook
 * signature — is twenty lines of `node:crypto` at the bottom of this file, and
 * everything else is a form-encoded POST. A dependency on this path would be
 * updated by somebody else's release schedule, which is how a payment flow
 * breaks on a Tuesday.
 *
 * The secret key is held by the closure below and by nothing else: never in a
 * response, never in a log line, never in an error message. Stripe's own message
 * is passed through on failure because it is written for humans; the request is
 * not, because the request carries the key.
 *
 * `fetch` is injected for two reasons: the suite has no network, and a client
 * that reads a global at call time fails only in the one environment that
 * matters.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Where the live API is. Overridable only so a local stub can stand in. */
export const STRIPE_API_BASE = "https://api.stripe.com";

/** The header Stripe signs a webhook with. */
export const SIGNATURE_HEADER = "stripe-signature";

/** How far the signed timestamp may be from now, in seconds. Stripe's own default. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

/** An error with a code short enough to branch on and a message safe to log. */
export class StripeError extends Error {
  constructor(message, { status = 0, code = "stripe", cause } = {}) {
    super(message);
    this.name = "StripeError";
    this.status = status;
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The client.
 *
 * @param {{ secretKey: string, apiBase?: string, fetch?: typeof fetch, timeoutMs?: number }} options
 */
export function createStripeClient({
  secretKey,
  apiBase = STRIPE_API_BASE,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = 15_000,
} = {}) {
  if (typeof secretKey !== "string" || secretKey === "") {
    throw new StripeError("STRIPE_SECRET_KEY is not set", { code: "config" });
  }
  if (typeof fetchImpl !== "function") {
    throw new StripeError("no fetch implementation is available", { code: "config" });
  }
  const base = apiBase.replace(/\/+$/, "");

  /**
   * One request, with the key applied here and only here.
   *
   * @param {"GET" | "POST"} method
   * @param {string} path
   * @param {{ form?: URLSearchParams | null, idempotencyKey?: string | null }} [options]
   */
  async function request(method, path, { form = null, idempotencyKey = null } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      /** @type {Record<string, string>} */
      const headers = {
        Authorization: `Bearer ${secretKey}`,
        Accept: "application/json",
      };
      if (form !== null) headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey !== null) headers["Idempotency-Key"] = idempotencyKey;

      const response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: form === null ? undefined : form.toString(),
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed = null;
      try {
        parsed = text === "" ? null : JSON.parse(text);
      } catch {
        parsed = null;
      }

      if (!response.ok) {
        throw new StripeError(parsed?.error?.message ?? `stripe answered ${response.status} for ${path}`, {
          status: response.status,
          code: parsed?.error?.code ?? parsed?.error?.type ?? "http",
        });
      }
      if (parsed === null) throw new StripeError(`stripe answered ${path} with an empty body`);
      return parsed;
    } catch (cause) {
      if (cause instanceof StripeError) throw cause;
      throw new StripeError(`${method} ${path} failed: ${String(cause?.message ?? cause)}`, {
        code: "network",
        cause,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    /**
     * A Stripe customer for one reader, created before any money moves.
     *
     * This is what makes a payment attributable. The customer id is written to
     * the link table at checkout creation, and the webhook later reads that row
     * to decide which account an event belongs to. A customer that only came
     * into existence at the end of Checkout would leave the webhook holding a
     * customer id it had never seen, and the only remaining place to look for a
     * user would be the event body — which is a claim, not a fact.
     *
     * The idempotency key is the reader's id, so two presses of the same button
     * create one customer rather than two.
     */
    async createCustomer({ userId, email = null }) {
      const form = new URLSearchParams();
      form.set("metadata[supabase_user_id]", userId);
      if (email !== null) form.set("email", email);
      const customer = await request("POST", "/v1/customers", {
        form,
        idempotencyKey: `ht-customer-${userId}`,
      });
      if (typeof customer.id !== "string" || customer.id === "") {
        throw new StripeError("customer came back without an id", { code: "no_id" });
      }
      return customer.id;
    },

    /**
     * A Checkout Session for one of the two prices.
     *
     * `mode=subscription` means Stripe owns renewal, dunning and cancellation,
     * and no card data ever reaches this service or the app. `priceId` is passed
     * in by the caller from configuration, never from a request.
     */
    async createCheckoutSession({ customerId, priceId, userId, successUrl, cancelUrl }) {
      const form = new URLSearchParams();
      form.set("mode", "subscription");
      form.set("customer", customerId);
      form.set("client_reference_id", userId);
      form.set("line_items[0][price]", priceId);
      form.set("line_items[0][quantity]", "1");
      form.set("subscription_data[metadata][supabase_user_id]", userId);
      form.set("success_url", successUrl);
      form.set("cancel_url", cancelUrl);
      const session = await request("POST", "/v1/checkout/sessions", { form });
      return { id: String(session.id ?? ""), url: requireUrl(session.url, "checkout session") };
    },

    /**
     * A billing-portal session, so a reader can cancel what they bought.
     *
     * The portal is Stripe's page. Cancelling, changing the card and reading an
     * invoice all happen there, and this service only ever holds a URL. The
     * customer id comes from the link table, so a token can only open the portal
     * of the account it belongs to.
     */
    async createPortalSession({ customerId, returnUrl }) {
      const form = new URLSearchParams();
      form.set("customer", customerId);
      form.set("return_url", returnUrl);
      const session = await request("POST", "/v1/billing_portal/sessions", { form });
      return { id: String(session.id ?? ""), url: requireUrl(session.url, "portal session") };
    },

    /**
     * The subscription as it stands right now.
     *
     * The webhook calls this for the events whose body is not a subscription
     * (checkout completion, invoices). Stripe's own current view is the state of
     * record; the event body is a snapshot of the moment it was emitted, and a
     * retry delivered ten minutes later would otherwise apply a stale snapshot.
     */
    async retrieveSubscription(subscriptionId) {
      if (typeof subscriptionId !== "string" || subscriptionId === "") {
        throw new StripeError("retrieveSubscription needs an id", { code: "no_id" });
      }
      return request("GET", `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
    },
  };
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function requireUrl(value, what) {
  if (typeof value !== "string" || !/^https:\/\//.test(value)) {
    throw new StripeError(`${what} came back without an https url`, { code: "no_url" });
  }
  return value;
}

/**
 * Whether a webhook body was signed by `secret`, and is recent.
 *
 * The header is `t=<unix seconds>,v1=<hex hmac>[,v1=<hex hmac>...]` and the HMAC
 * is SHA-256 over `<t>.<raw body>`. The raw bytes matter: re-serialising the JSON
 * before hashing is the classic way to reject every real delivery, which is why
 * the caller reads the body as bytes and never as a parsed object.
 *
 * Two `v1` values can be present while a secret is being rolled, so any one of
 * them matching is a pass. A stale timestamp fails even when the signature is
 * right: that is the replay window, and without it a captured delivery can be
 * posted again for as long as the secret lives.
 *
 * @param {Uint8Array | string} payload raw bytes, exactly as received
 * @param {string | null | undefined} header
 * @param {string} secret
 * @param {{ nowSeconds?: number, toleranceSeconds?: number }} [options]
 * @returns {{ ok: true } | { ok: false, reason: "missing_header" | "malformed_header" | "no_signature" | "stale_timestamp" | "mismatch" }}
 */
export function verifyWebhookSignature(payload, header, secret, options = {}) {
  if (typeof header !== "string" || header.trim() === "") return { ok: false, reason: "missing_header" };
  if (typeof secret !== "string" || secret === "") return { ok: false, reason: "mismatch" };

  /** @type {number | null} */
  let timestamp = null;
  /** @type {string[]} */
  const signatures = [];
  for (const part of header.split(",")) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === "t") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed)) timestamp = parsed;
    } else if (key === "v1" && value !== "") {
      signatures.push(value);
    }
  }
  if (timestamp === null) return { ok: false, reason: "malformed_header" };
  if (signatures.length === 0) return { ok: false, reason: "no_signature" };

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = options.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(now - timestamp) > tolerance) return { ok: false, reason: "stale_timestamp" };

  const expected = createHmac("sha256", secret)
    .update(`${timestamp}.`)
    .update(payload)
    .digest();

  for (const signature of signatures) {
    const given = Buffer.from(signature, "hex");
    if (given.length !== expected.length) continue;
    // Constant time: a comparison that returns early leaks how much of a guess
    // was right, and a webhook endpoint is reachable by anyone.
    if (timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "mismatch" };
}

/**
 * The header a sender would produce. For the suite, and for a local `curl`.
 *
 * It lives beside the verifier rather than in the test so that the two can be
 * read together: the signing rule and the checking rule are one rule.
 *
 * @param {Uint8Array | string} payload
 * @param {string} secret
 * @param {number} [timestampSeconds]
 */
export function signWebhookPayload(payload, secret, timestampSeconds = Math.floor(Date.now() / 1000)) {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.`)
    .update(payload)
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}
