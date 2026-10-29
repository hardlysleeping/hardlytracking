/**
 * The billing service's settings, read once, refused loudly.
 *
 * This process holds the Stripe secret key and the Supabase service key, which
 * bypasses row-level security. Neither is ever echoed: the boot line says which
 * names are set, never what they are, because a log line is the easiest place to
 * leak a key that nobody thinks of as code.
 *
 * A missing setting is a refusal to start, not a service that runs and rejects
 * every event: a webhook that is up but unconfigured looks healthy on a
 * dashboard while quietly failing every payment. And the refusal names every
 * missing variable at once, because a boot that reports one name per attempt is
 * a boot somebody fixes nine times.
 *
 * `readConfig` never throws and never exits. The caller decides what a refusal
 * means — `server.mjs` prints one line and stops the process.
 */

/**
 * Everything the service needs, by name.
 *
 * `PORT` is on this list rather than defaulted: a default port is how you find
 * out in production that something else already took 8787.
 */
export const REQUIRED = Object.freeze([
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_MONTHLY",
  "STRIPE_PRICE_YEARLY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_KEY",
  "SUPABASE_JWT_SECRET",
  "PORT",
  "APP_ORIGIN",
]);

/** How long a failed payment keeps the feature on, unless GRACE_DAYS says otherwise. */
const DEFAULT_GRACE_DAYS = 3;

/**
 * Reads the environment into the shape the rest of the service wants.
 *
 * Returns `{ ok, config, missing, problems, message }`:
 * - `missing` lists required names that were absent or blank, in REQUIRED order;
 * - `problems` lists names that were present but unusable (a port that is not a
 *   number, an origin with a path);
 * - `message` is the one line to log, and it names every one of them.
 *
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ ok: boolean, config: object | null, missing: string[], problems: string[], message: string }}
 */
export function readConfig(env = process.env) {
  const missing = [];
  for (const name of REQUIRED) {
    const value = env[name];
    if (typeof value !== "string" || value.trim() === "") missing.push(name);
  }
  if (missing.length > 0) {
    return {
      ok: false,
      config: null,
      missing,
      problems: [],
      message: `missing required setting(s): ${missing.join(", ")}`,
    };
  }

  const problems = [];

  const port = Number.parseInt(env.PORT.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push("PORT must be an integer between 1 and 65535");
  }

  // A bare origin, not a URL with a path: it is compared character for
  // character against the browser's `Origin` header, which never carries a path.
  const appOrigin = stripTrailingSlashes(env.APP_ORIGIN.trim());
  if (!isOrigin(appOrigin)) {
    problems.push("APP_ORIGIN must be a bare http(s) origin, e.g. https://app.example");
  }

  const supabaseUrl = stripTrailingSlashes(env.SUPABASE_URL.trim());
  if (!isOrigin(supabaseUrl)) problems.push("SUPABASE_URL must be a bare http(s) origin");

  const graceDays =
    env.GRACE_DAYS === undefined || env.GRACE_DAYS.trim() === ""
      ? DEFAULT_GRACE_DAYS
      : Number(env.GRACE_DAYS);
  if (!Number.isFinite(graceDays) || graceDays <= 0) {
    problems.push("GRACE_DAYS must be a positive number of days");
  }

  if (problems.length > 0) {
    return { ok: false, config: null, missing: [], problems, message: problems.join("; ") };
  }

  const config = {
    port,
    // Loopback by default: a service holding a service-role key should be
    // reachable through whatever terminates TLS in front of it, not by default
    // on every interface the host has.
    host: (env.HOST ?? "127.0.0.1").trim() || "127.0.0.1",
    appOrigin,
    // The only origin a browser tab may call from. One value, because there is
    // one app; an empty or absent origin means no browser is allowed at all.
    stripeSecretKey: env.STRIPE_SECRET_KEY.trim(),
    webhookSecret: env.STRIPE_WEBHOOK_SECRET.trim(),
    // The two prices this shop sells. Read here and nowhere else: a price id
    // that arrives in a request body is a claim about what something costs.
    prices: Object.freeze({
      monthly: env.STRIPE_PRICE_MONTHLY.trim(),
      yearly: env.STRIPE_PRICE_YEARLY.trim(),
    }),
    supabase: Object.freeze({
      url: supabaseUrl,
      serviceKey: env.SUPABASE_SERVICE_KEY.trim(),
      jwtSecret: env.SUPABASE_JWT_SECRET.trim(),
    }),
    graceMs: Math.round(graceDays * 24 * 60 * 60 * 1000),
    // Only so a local run or a suite can point the client at a stub. Unset in
    // production, where the client talks to the real API.
    stripeApiBase: (env.STRIPE_API_BASE ?? "").trim() || "https://api.stripe.com",
  };

  return { ok: true, config, missing: [], problems: [], message: "ok" };
}

/**
 * One line for the log: the shape of the configuration, never its contents.
 *
 * The counts and booleans are deliberate — "which of these is set" answers the
 * question an operator actually has, and "what is it" is the answer that turns a
 * log file into a credential leak.
 *
 * @param {object} config
 */
export function describeConfig(config) {
  return {
    listen: `${config.host}:${config.port}`,
    appOrigin: config.appOrigin,
    supabase: config.supabase.url,
    prices: {
      monthly: config.prices.monthly === "" ? "unset" : "set",
      yearly: config.prices.yearly === "" ? "unset" : "set",
    },
    graceDays: Math.round(config.graceMs / (24 * 60 * 60 * 1000)),
    stripeApiBase: config.stripeApiBase,
  };
}

/** @param {string} value */
function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}

/** @param {string} value */
function isOrigin(value) {
  return /^https?:\/\/[^/\s]+$/.test(value);
}
