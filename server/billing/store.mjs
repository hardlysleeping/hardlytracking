/**
 * Where the entitlement lives, and the three ways of asking it.
 *
 * There is one rule underneath everything here: the webhook never decides which
 * reader an event belongs to. It hands the *customer* to this store, and the
 * store looks up the reader that checkout creation linked there. A body that
 * names a user id is a body that could name any user id, so no method below
 * takes a user id from a webhook payload.
 *
 * Two implementations, one contract:
 *
 * - `memoryStore` is the suite's: the same semantics, no network, and a
 *   `snapshot()` so a test can assert on what was written rather than on what a
 *   function returned;
 * - `SupabaseStore` is the deployed one: PostgREST over `fetch` with the
 *   `service_role` key, which is the only key in this process that can write,
 *   because the schema grants no write to `authenticated`.
 *
 * Rows cross this boundary in the shape the state machine uses — `cloudSync`,
 * `expiresAt` as milliseconds — and are translated to and from the column names
 * and ISO timestamps in exactly one place, here. A timestamp string that leaked
 * into the policy module would be compared with a number and lose.
 */

/** An error with a code short enough to log and to branch on. */
export class StoreError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * The contract, as a class with nothing but refusals.
 *
 * JavaScript has no interface keyword, so the interface is a base class whose
 * methods throw: a method somebody forgot to implement fails on the first call
 * that needs it, by name, instead of answering `undefined` and being treated as
 * "this reader has no entitlement".
 *
 * `userForCustomer` is the webhook's only way in, and it exists because the
 * direction matters: the app asks "what does this user have", the webhook asks
 * "whose customer is this". Both questions are answered by the same link table,
 * which was written at checkout with a verified JWT.
 */
export class EntitlementStore {
  /** @param {string} userId */
  async getByUser(userId) {
    throw new StoreError("not_implemented", "getByUser is not implemented");
  }

  /** @param {string} userId @param {object} state */
  async upsert(userId, state) {
    throw new StoreError("not_implemented", "upsert is not implemented");
  }

  /** @param {string} userId */
  async customerFor(userId) {
    throw new StoreError("not_implemented", "customerFor is not implemented");
  }

  /** @param {string} customerId */
  async userForCustomer(customerId) {
    throw new StoreError("not_implemented", "userForCustomer is not implemented");
  }

  /** @param {string} userId @param {string} customerId */
  async linkCustomer(userId, customerId) {
    throw new StoreError("not_implemented", "linkCustomer is not implemented");
  }

  /** @param {string} eventId */
  async seenEvent(eventId) {
    throw new StoreError("not_implemented", "seenEvent is not implemented");
  }

  /** @param {object} record */
  async rememberEvent(record) {
    throw new StoreError("not_implemented", "rememberEvent is not implemented");
  }

  /** @param {string | null} subscriptionId */
  async lastEventAt(subscriptionId) {
    throw new StoreError("not_implemented", "lastEventAt is not implemented");
  }
}

/**
 * The suite's store: a handful of maps with the same rules.
 *
 * `seed` lets a test start from a state instead of applying events to reach one.
 *
 * @param {{ entitlements?: Array<{ userId: string, state: object }>, customers?: Array<{ userId: string, customerId: string }>, events?: object[] }} [seed]
 */
export function memoryStore(seed = {}) {
  /** @type {Map<string, { cloudSync: boolean, source: string | null, expiresAt: number | null }>} */
  const entitlements = new Map();
  /** @type {Map<string, string>} */
  const byUser = new Map();
  /** @type {Map<string, string>} */
  const byCustomer = new Map();
  /** @type {Map<string, object>} */
  const events = new Map();
  let writes = 0;

  for (const row of seed.entitlements ?? []) {
    entitlements.set(row.userId, {
      cloudSync: row.state?.cloudSync === true,
      source: row.state?.source ?? null,
      expiresAt: row.state?.expiresAt ?? null,
    });
  }
  for (const link of seed.customers ?? []) {
    byUser.set(link.userId, link.customerId);
    byCustomer.set(link.customerId, link.userId);
  }
  for (const record of seed.events ?? []) events.set(record.eventId, { ...record });

  return {
    async getByUser(userId) {
      const row = entitlements.get(userId);
      return row === undefined ? null : { ...row };
    },

    async upsert(userId, state) {
      writes += 1;
      entitlements.set(userId, {
        cloudSync: state?.cloudSync === true,
        source: state?.source ?? null,
        expiresAt: state?.expiresAt ?? null,
      });
    },

    async customerFor(userId) {
      return byUser.get(userId) ?? null;
    },

    async userForCustomer(customerId) {
      return byCustomer.get(customerId) ?? null;
    },

    async linkCustomer(userId, customerId) {
      // One customer per reader, mirroring the primary key on the table: a
      // second purchase reuses the customer rather than creating a second
      // identity at Stripe that no row would point at.
      const previous = byUser.get(userId);
      if (previous !== undefined && previous !== customerId) byCustomer.delete(previous);
      byUser.set(userId, customerId);
      byCustomer.set(customerId, userId);
    },

    async seenEvent(eventId) {
      return events.has(eventId);
    },

    async rememberEvent(record) {
      if (events.has(record.eventId)) return false;
      events.set(record.eventId, { ...record });
      return true;
    },

    async lastEventAt(subscriptionId) {
      if (typeof subscriptionId !== "string" || subscriptionId === "") return null;
      let newest = null;
      for (const record of events.values()) {
        if (record.subscriptionId !== subscriptionId) continue;
        const created = Number(record.created);
        if (!Number.isFinite(created)) continue;
        if (newest === null || created > newest) newest = created;
      }
      return newest;
    },

    /** For assertions: what was written, and how many times. */
    snapshot() {
      return {
        writes,
        entitlements: new Map(entitlements),
        customers: new Map(byUser),
        events: new Map(events),
      };
    },
  };
}

/**
 * The deployed store: Supabase's REST API, service key, no SDK.
 *
 * The service key is not a convenience. Every write below bypasses row-level
 * security, so a store built without one is a store that must not exist — it is
 * refused at construction rather than at the first request, because the first
 * request is a payment.
 */
export class SupabaseStore extends EntitlementStore {
  /**
   * @param {{ url: string, serviceKey: string, fetch?: typeof fetch, timeoutMs?: number }} options
   */
  constructor({ url, serviceKey, fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000 } = {}) {
    super();
    if (typeof url !== "string" || url === "") throw new StoreError("config", "SUPABASE_URL is not set");
    if (typeof serviceKey !== "string" || serviceKey === "") {
      throw new StoreError("config", "SUPABASE_SERVICE_KEY is not set");
    }
    if (typeof fetchImpl !== "function") throw new StoreError("config", "no fetch implementation");
    this.url = url.replace(/\/+$/, "");
    this.serviceKey = serviceKey;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async getByUser(userId) {
    const rows = await this.request(
      "GET",
      `/rest/v1/entitlements?user_id=eq.${encodeURIComponent(userId)}&select=cloud_sync,source,expires_at&limit=1`,
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    if (row === undefined || row === null) return null;
    return {
      cloudSync: row.cloud_sync === true,
      source: typeof row.source === "string" ? row.source : null,
      expiresAt: parseTimestamp(row.expires_at),
    };
  }

  async upsert(userId, state) {
    await this.request("POST", "/rest/v1/entitlements", {
      body: [
        {
          user_id: userId,
          cloud_sync: state?.cloudSync === true,
          source: state?.source ?? null,
          expires_at: state?.expiresAt === null || state?.expiresAt === undefined
            ? null
            : new Date(state.expiresAt).toISOString(),
        },
      ],
      // Merge on the primary key, so a second event about the same reader
      // updates the row instead of failing on a duplicate key. `updated_at` is
      // set by the table's trigger, not by this process's clock.
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });
  }

  async customerFor(userId) {
    const rows = await this.request(
      "GET",
      `/rest/v1/stripe_customers?user_id=eq.${encodeURIComponent(userId)}&select=stripe_customer_id&limit=1`,
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return typeof row?.stripe_customer_id === "string" ? row.stripe_customer_id : null;
  }

  async userForCustomer(customerId) {
    const rows = await this.request(
      "GET",
      `/rest/v1/stripe_customers?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=user_id&limit=1`,
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    return typeof row?.user_id === "string" ? row.user_id : null;
  }

  async linkCustomer(userId, customerId) {
    await this.request("POST", "/rest/v1/stripe_customers", {
      body: [{ user_id: userId, stripe_customer_id: customerId }],
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
    });
  }

  async seenEvent(eventId) {
    const rows = await this.request(
      "GET",
      `/rest/v1/stripe_events?event_id=eq.${encodeURIComponent(eventId)}&select=event_id&limit=1`,
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async rememberEvent(record) {
    // `ignore-duplicates` plus `return=representation`: the insert that wins
    // returns a row, the one that loses on the primary key returns nothing. That
    // is the dedupe, decided by the database rather than by a read-then-write
    // that two concurrent deliveries can both pass.
    const rows = await this.request("POST", "/rest/v1/stripe_events", {
      body: [
        {
          event_id: record.eventId,
          subscription_id: record.subscriptionId ?? null,
          created_at: Number(record.created ?? 0),
        },
      ],
      headers: { Prefer: "resolution=ignore-duplicates,return=representation" },
    });
    return Array.isArray(rows) && rows.length > 0;
  }

  async lastEventAt(subscriptionId) {
    if (typeof subscriptionId !== "string" || subscriptionId === "") return null;
    const rows = await this.request(
      "GET",
      `/rest/v1/stripe_events?subscription_id=eq.${encodeURIComponent(subscriptionId)}&select=created_at&order=created_at.desc&limit=1`,
    );
    const row = Array.isArray(rows) ? rows[0] : null;
    const created = Number(row?.created_at);
    return Number.isFinite(created) ? created : null;
  }

  async request(method, path, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetch(`${this.url}${path}`, {
        method,
        headers: {
          apikey: this.serviceKey,
          Authorization: `Bearer ${this.serviceKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(options.headers ?? {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (!response.ok) {
        // The status and PostgREST's own message; never the headers, which carry
        // the service key.
        throw new StoreError("http", `${method} ${path} answered ${response.status}: ${text.slice(0, 300)}`);
      }
      if (text === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("network", `${method} ${path} failed: ${String(cause?.message ?? cause)}`, cause);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * A view of a store that can read and cannot write.
 *
 * This is what `GET /entitlement` is given, and the reason it is a separate
 * object rather than a convention: the read path and the write path are then
 * different values, so a mistake in a read handler — a stray `upsert` behind a
 * query parameter, say — fails loudly instead of granting the feature the shop
 * sells. The webhook is handed the full store; nothing else is.
 *
 * The refusals throw synchronously on purpose: a read handler that reaches for a
 * write should fail at the call, not in a promise nobody awaited.
 *
 * @param {object} store
 */
export function readOnlyStore(store) {
  /** @param {string} name */
  const refuse = (name) => () => {
    throw new StoreError("read_only", `${name} is not available on the read path`);
  };
  return {
    getByUser: (userId) => store.getByUser(userId),
    customerFor: (userId) => store.customerFor(userId),
    userForCustomer: (customerId) => store.userForCustomer(customerId),
    seenEvent: (eventId) => store.seenEvent(eventId),
    lastEventAt: (subscriptionId) => store.lastEventAt(subscriptionId),
    upsert: refuse("upsert"),
    linkCustomer: refuse("linkCustomer"),
    rememberEvent: refuse("rememberEvent"),
  };
}

/**
 * A PostgREST timestamp as milliseconds, or null.
 *
 * `expires_at` is a `timestamptz` and arrives as an ISO string; the policy module
 * compares it with `Date.now()`, so the conversion happens here and nowhere else.
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function parseTimestamp(value) {
  if (typeof value !== "string" || value === "") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
