/**
 * What a Stripe event does to one entitlement row, as a pure function.
 *
 * This module is the whole policy of the paid capability, and it imports
 * nothing on purpose: the webhook is allowed to be wrong about plumbing, but it
 * must not be allowed to be wrong about money. Everything it needs — the clock,
 * the grace window, the two price ids, the watermark of the last applied event —
 * arrives as an argument, which is also why the suite can stand at any moment of
 * a subscription's life without waiting months for one to get there.
 *
 * Two facts shape the code below:
 *
 * 1. The row is `cloud_sync` plus `expires_at`; there is no third state column.
 *    Grace is therefore not stored as a flag: a failed payment is written as
 *    cloud_sync=true with expires_at moved out to the end of the grace window,
 *    and the read path stops honouring it when that date passes. Nothing has to
 *    run at midnight for a lapsed card to stop syncing.
 * 2. Cancelling is not revoking. A subscription cancelled today is paid up to
 *    the end of the period, so `customer.subscription.deleted` keeps the grant
 *    while `expires_at` is still in the future.
 *
 * The two guards that are not about money live here as well, because they are
 * decisions rather than storage: an event id applied once, and an event older
 * than the newest one already applied for that subscription ignored. Stripe
 * delivers at least once and out of order; a replayed `subscription.deleted` is
 * exactly how a cancelled row comes back to life.
 */

/**
 * How long a failed payment keeps the feature on, by default.
 *
 * Three days: long enough for a reissued card and a reader who is away for a
 * weekend, short enough that the row turns itself off without anybody pressing
 * anything. Stripe retries inside that window and sends an invoice event when it
 * succeeds, which clears the window again.
 */
export const GRACE_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The events this shop acts on. Anything else is acknowledged and dropped.
 *
 * `invoice.paid` and `invoice.payment_succeeded` are both listed because Stripe
 * sends both for a successful renewal depending on the API version and the
 * subscription's history; the shop cares about the money, not the name.
 */
export const HANDLED_EVENTS = Object.freeze([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.paid",
  "invoice.payment_succeeded",
]);

/**
 * A row for a reader who has never bought anything.
 *
 * @returns {{ cloudSync: boolean, source: string | null, expiresAt: number | null }}
 */
export function emptyEntitlement() {
  return { cloudSync: false, source: null, expiresAt: null };
}

/**
 * What the app is actually allowed to do, as of `nowMs`.
 *
 * The row stores the grant and the date separately, so the date has to be
 * applied somewhere. It is applied here, on the server, rather than handed to
 * the client: a client that decides its own entitlement from a date is a client
 * that can be edited into deciding yes.
 *
 * @param {{ cloudSync?: boolean, source?: string | null, expiresAt?: number | null } | null} state
 * @param {number} [nowMs]
 * @returns {{ cloudSync: boolean, expiresAt: number | null, source: string | null }}
 */
export function effectiveEntitlement(state, nowMs = Date.now()) {
  const row = normalise(state);
  const live = row.cloudSync && (row.expiresAt === null || row.expiresAt > nowMs);
  return { cloudSync: live, expiresAt: row.expiresAt, source: row.source };
}

/**
 * One event, applied to one row.
 *
 * `state` is the row as stored (or `emptyEntitlement()`), `event` is the parsed
 * webhook body, and `options` carries everything the decision needs:
 *
 * - `nowMs`            the clock, injected so the suite can move it;
 * - `graceMs`          the grace window, from configuration;
 * - `prices`           `{ monthly, yearly }` price ids from the environment;
 * - `subscription`     the subscription as Stripe reports it now. Required for
 *                      the events whose body is not a subscription (checkout
 *                      completion, invoices); the caller fetches it. For
 *                      `customer.subscription.*` it defaults to the body.
 * - `lastEventCreated` Stripe's `created` for the newest event already applied
 *                      to this subscription, or null;
 * - `seenEventIds`     event ids already applied, as a Set, Map or array. The
 *                      store is the real memory; this is the same guard for a
 *                      caller that has one in hand.
 *
 * Returns `{ ok, outcome, reason, plan, customerId, state }`. `ok` is false for
 * every refusal, and `state` is then the state that came in, unchanged — a
 * refusal never writes.
 *
 * @param {object | null} state
 * @param {object} event
 * @param {object} [options]
 */
export function applyStripeEvent(state, event, options = {}) {
  const current = normalise(state);
  const now = numberOr(options.nowMs, Date.now());
  const graceMs = numberOr(options.graceMs, GRACE_MS);
  const prices = options.prices ?? { monthly: null, yearly: null };

  const type = typeof event?.type === "string" ? event.type : "";
  const eventId = typeof event?.id === "string" ? event.id : "";
  const created = numberOrNull(event?.created);

  if (eventId === "" || type === "") return refuse(current, "invalid", "bad_event");
  if (!HANDLED_EVENTS.includes(type)) return refuse(current, "ignored", "event_not_handled");

  if (options.seenEventIds !== undefined && wasSeen(options.seenEventIds, eventId)) {
    return refuse(current, "duplicate", "event_id_already_applied");
  }

  const watermark = numberOrNull(options.lastEventCreated);
  if (watermark !== null && created !== null && created < watermark) {
    // Strictly older, not equal: Stripe's `created` has one-second resolution, so
    // a subscription's created and updated events routinely share a timestamp,
    // and refusing equal ones would drop legitimate updates.
    return refuse(current, "stale", "older_than_last_applied_event");
  }

  const subscription =
    options.subscription ?? (type.startsWith("customer.subscription.") ? event?.data?.object : null);
  if (!isRecord(subscription)) return refuse(current, "incomplete", "no_subscription");

  const customerId = customerIdOf(subscription) ?? customerIdOf(event?.data?.object);
  if (customerId === null) return refuse(current, "ignored", "no_customer");

  const plan = planOf(subscription, prices);
  if (plan === null) {
    // Stripe says this subscription is active; it does not say it is active on
    // something this shop sells. Without this check a price created in the
    // dashboard for a penny would unlock the feature. Acknowledged, so Stripe
    // stops retrying, and never granted.
    return refuse(current, "ignored", "price_not_sold", { customerId });
  }

  const decision = decide(type, subscription, event, now, graceMs);
  if (decision === null) return refuse(current, "ignored", "not_a_subscription", { customerId, plan });

  return {
    ok: true,
    outcome: "applied",
    reason: decision.why,
    plan,
    customerId,
    state: { cloudSync: decision.cloudSync, source: "stripe", expiresAt: decision.expiresAt },
  };
}

/* --------------------------------- the policy -------------------------------- */

/**
 * The event's meaning for the two columns.
 *
 * Every status Stripe can report is answered by name, so a status nobody thought
 * about lands on "no grant, with a reason" instead of on `true`.
 *
 * @param {string} type
 * @param {Record<string, any>} subscription
 * @param {Record<string, any>} event
 * @param {number} now
 * @param {number} graceMs
 * @returns {{ cloudSync: boolean, expiresAt: number | null, why: string } | null}
 */
function decide(type, subscription, event, now, graceMs) {
  switch (type) {
    case "checkout.session.completed": {
      const mode = asRecord(event?.data?.object).mode;
      // A one-off payment is not a subscription and buys nothing recurring.
      if (mode !== undefined && mode !== "subscription") return null;
      return fromStatus(subscription, now, graceMs);
    }

    case "customer.subscription.created":
    case "customer.subscription.updated":
      return fromStatus(subscription, now, graceMs);

    case "customer.subscription.deleted": {
      // Cancelled, and honoured to the end of the period that was paid for.
      // Revoking on the day somebody cancels takes back something they bought;
      // the read path is what turns it off at `expires_at`.
      const end = paidUntilMs(subscription);
      const live = end !== null && end > now;
      return {
        cloudSync: live,
        expiresAt: end ?? now,
        why: live ? "cancelled; the paid period is honoured to its end" : "cancelled and the paid period is over",
      };
    }

    case "invoice.payment_failed": {
      // The card failed and Stripe is still retrying. The reader keeps syncing
      // for the grace window, counted from whichever is later: the period end
      // they already paid for, or now — so a card that fails on the due date
      // still gets the whole window rather than a truncated one.
      const end = paidUntilMs(subscription);
      const base = Math.max(end ?? now, now);
      return { cloudSync: true, expiresAt: base + graceMs, why: "the last payment failed; in grace" };
    }

    case "invoice.paid":
    case "invoice.payment_succeeded": {
      // A successful payment clears the grace window: `expires_at` goes back to
      // the period end the money actually bought, which is what "cleared" means
      // in a table that has no grace column.
      const end = paidUntilMs(subscription);
      return { cloudSync: end === null || end > now, expiresAt: end, why: "paid" };
    }

    default:
      return null;
  }
}

/**
 * A subscription, read as a grant or a refusal.
 *
 * @param {Record<string, any>} subscription
 * @param {number} now
 * @param {number} graceMs
 * @returns {{ cloudSync: boolean, expiresAt: number | null, why: string }}
 */
function fromStatus(subscription, now, graceMs) {
  const status = typeof subscription.status === "string" ? subscription.status : "unknown";
  const end = paidUntilMs(subscription);

  switch (status) {
    case "active":
    case "trialing": {
      // `cancel_at_period_end` needs no arm of its own: the subscription is paid
      // up to the period end, which is exactly what this says.
      const live = end === null || end > now;
      return {
        cloudSync: live,
        expiresAt: end,
        why: live ? "paid up until the end of the period" : "the period has ended",
      };
    }

    case "past_due": {
      const base = Math.max(end ?? now, now);
      return { cloudSync: true, expiresAt: base + graceMs, why: "past due and being retried; in grace" };
    }

    case "canceled":
    case "unpaid": {
      // Dunning has given up, or the reader cancelled. Either way the period was
      // paid for, so it is honoured to its end and not one second further.
      const live = end !== null && end > now;
      return {
        cloudSync: live,
        expiresAt: end,
        why: live ? "ended; still inside the paid period" : "ended and the paid period is over",
      };
    }

    case "incomplete":
    case "incomplete_expired":
      // Checkout was opened and the first invoice was never paid. Nothing was
      // bought, so nothing is granted — not even "for a little while".
      return { cloudSync: false, expiresAt: end, why: "the first payment never completed" };

    case "paused":
      return { cloudSync: false, expiresAt: end, why: "the subscription is paused" };

    default:
      return {
        cloudSync: false,
        expiresAt: end,
        why: `status "${status}" is not one this shop grants`,
      };
  }
}

/* ------------------------------- reading shape ------------------------------- */

/**
 * The plan a subscription is on, by price id, or null when it is on none of ours.
 *
 * @param {unknown} subscription
 * @param {{ monthly: string | null, yearly: string | null }} prices
 * @returns {"monthly" | "yearly" | null}
 */
export function planOf(subscription, prices) {
  for (const id of priceIdsOf(subscription)) {
    if (prices?.monthly && id === prices.monthly) return "monthly";
    if (prices?.yearly && id === prices.yearly) return "yearly";
  }
  return null;
}

/**
 * Every price id on the subscription, whichever shape the API version uses.
 *
 * `items.data[].price.id` is the modern shape; `plan.id` is what an old pinned
 * API version puts on the subscription. Both are read, because a webhook
 * endpoint pinned to an older version is a configuration fact, not a bug report.
 *
 * @param {unknown} subscription
 * @returns {string[]}
 */
export function priceIdsOf(subscription) {
  const sub = asRecord(subscription);
  const items = asRecord(sub.items);
  const data = Array.isArray(items.data) ? items.data : [];
  /** @type {string[]} */
  const ids = [];
  for (const item of data) {
    const price = asRecord(asRecord(item).price);
    const id = text(price.id) ?? text(asRecord(asRecord(item).plan).id);
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  const legacy = text(asRecord(sub.plan).id);
  if (legacy !== null && !ids.includes(legacy)) ids.push(legacy);
  return ids;
}

/**
 * When the paid period ends, in milliseconds, or null when Stripe does not say.
 *
 * Since API version 2025-03-31 the period lives on each subscription *item*
 * rather than on the subscription, so both places are read and the earliest wins:
 * a subscription with a monthly and a yearly item is paid up only as far as the
 * shorter one, and an expiry that is too generous is money given away.
 *
 * @param {unknown} subscription
 * @returns {number | null}
 */
export function periodEndMs(subscription) {
  const sub = asRecord(subscription);
  /** @type {number[]} */
  const candidates = [];
  pushSeconds(candidates, sub.current_period_end);
  const items = asRecord(sub.items);
  const data = Array.isArray(items.data) ? items.data : [];
  for (const item of data) pushSeconds(candidates, asRecord(item).current_period_end);
  if (candidates.length === 0) return null;
  return Math.min(...candidates) * 1000;
}

/**
 * When a trial ends, in milliseconds, or null for a subscription without one.
 *
 * @param {unknown} subscription
 * @returns {number | null}
 */
export function trialEndMs(subscription) {
  const end = seconds(asRecord(subscription).trial_end);
  return end === null ? null : end * 1000;
}

/**
 * The later of the period end and the trial end: the last moment that is paid
 * for. A trial that runs past the first period is still a paid-for window.
 *
 * @param {unknown} subscription
 * @returns {number | null}
 */
export function paidUntilMs(subscription) {
  const period = periodEndMs(subscription);
  const trial = trialEndMs(subscription);
  if (period === null) return trial;
  if (trial === null) return period;
  return Math.max(period, trial);
}

/* ---------------------------------- helpers --------------------------------- */

/**
 * The customer id an event is about, from a subscription, a checkout session, an
 * invoice, or an expanded customer object.
 *
 * This is the only identifier the webhook is allowed to act on. A `user`,
 * `metadata.supabase_user_id` or `client_reference_id` in the body is a claim
 * written by whoever made the request; the customer id is resolved through the
 * link table this service wrote at checkout, and nothing else. There is
 * deliberately no fallback to `.id`: on a subscription that would quietly turn a
 * subscription id into a customer lookup that could never succeed.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function customerIdOf(value) {
  if (typeof value === "string" && value !== "") return value;
  const record = asRecord(value);
  const direct = record.customer;
  if (typeof direct === "string" && direct !== "") return direct;
  const expanded = asRecord(direct).id;
  if (typeof expanded === "string" && expanded !== "") return expanded;
  return null;
}

/**
 * @param {object} state
 * @param {"invalid" | "ignored" | "duplicate" | "stale" | "incomplete"} outcome
 * @param {string} reason
 * @param {{ customerId?: string, plan?: string }} [extra]
 */
function refuse(state, outcome, reason, extra = {}) {
  return {
    ok: false,
    outcome,
    reason,
    plan: extra.plan ?? null,
    customerId: extra.customerId ?? null,
    state,
  };
}

/**
 * @param {unknown} state
 * @returns {{ cloudSync: boolean, source: string | null, expiresAt: number | null }}
 */
function normalise(state) {
  const record = asRecord(state);
  return {
    cloudSync: record.cloudSync === true,
    source: typeof record.source === "string" ? record.source : null,
    expiresAt: numberOrNull(record.expiresAt),
  };
}

/**
 * @param {unknown} seen
 * @param {string} eventId
 */
function wasSeen(seen, eventId) {
  if (seen instanceof Set || seen instanceof Map) return seen.has(eventId);
  if (Array.isArray(seen)) return seen.includes(eventId);
  return false;
}

/** @returns {Record<string, any>} */
function asRecord(value) {
  return typeof value === "object" && value !== null ? value : {};
}

/** Whether a value is an object worth reading fields from. */
function isRecord(value) {
  return typeof value === "object" && value !== null;
}

/** @returns {string | null} */
function text(value) {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * A Stripe timestamp is seconds since the epoch; 0 and null both mean "unset",
 * and 0 is 1970 rather than a date anything should be granted until.
 *
 * @returns {number | null}
 */
function seconds(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** @returns {void} */
function pushSeconds(into, value) {
  const found = seconds(value);
  if (found !== null) into.push(found);
}

/** @returns {number | null} */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** @returns {number} */
function numberOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
