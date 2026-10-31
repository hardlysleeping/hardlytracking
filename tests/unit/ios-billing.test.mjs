/**
 * The App Store billing gate: an app-store build has no shop at all.
 *
 * `docs/app-store-release-checklist.md` §9 is a decision, and this is the
 * decision written down where it can fail a test: paid sync is post-launch
 * (`README.md`, KANBAN "Post-launch — paid sync"), so no StoreKit product exists
 * to sell and nothing in an iOS build may reach the Stripe Checkout that the web
 * and desktop builds use. Apple 3.1.1 and Play's payments policy both treat a
 * link to an outside checkout for a digital subscription as the violation, so
 * hiding the button is not enough — the request must be impossible to make.
 *
 * What this refuses:
 *
 * - a shell answer that puts iOS on the Stripe side of `shopOf` (one line, and
 *   the app is selling outside the store again);
 * - a native shell that will not name its platform being read as "web" — the
 *   Capacitor default is the unsafe direction, so it is answered `ios`;
 * - `checkout()` on a store build doing anything at all: no session read, no
 *   `fetch`, nothing opened. The guard sits before the session on purpose;
 * - the price buttons existing outside `{#if canBuy}` in `SyncAccount.svelte`.
 *
 * The last one reads the component source, which is blunt, but the alternative
 * is a DOM harness this suite does not have and the invariant is a template
 * shape, not a behaviour: `$1 / month` may only exist inside that block.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

import {
  CheckoutError,
  NOT_SOLD_HERE,
  SyncAccount,
  createSyncAccount,
  shellOf,
  shopOf,
} from "../../src/api/sync-account.ts";

const CONFIG = { url: "https://project.supabase.co", anonKey: "anon-key" };
const USER = "11111111-1111-1111-1111-111111111111";
const SESSION = { access_token: "tok", user: { id: USER, email: "a@b.test" } };

const component = readFileSync(new URL("../../src/components/SyncAccount.svelte", import.meta.url), "utf8");

function fakeClient(session = SESSION) {
  return {
    auth: {
      getSession: async () => ({ data: { session }, error: null }),
      signInWithOtp: async () => ({ data: {}, error: null }),
      signOut: async () => ({ error: null }),
    },
  };
}

/** A fetch that answers a Checkout URL and records every call it was given. */
function stub() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ url: "https://checkout.stripe.test/session" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

/** Runs `fn` with a shell's globals in place, then puts the globals back. */
async function inShell(globals, fn) {
  const scope = globalThis;
  const saved = { Capacitor: scope.Capacitor, "__TAURI_INTERNALS__": scope.__TAURI_INTERNALS__ };
  Object.assign(scope, globals);
  try {
    return await fn();
  } finally {
    for (const key of ["Capacitor", "__TAURI_INTERNALS__"]) {
      if (saved[key] === undefined) delete scope[key];
      else scope[key] = saved[key];
    }
  }
}

const capacitor = (platform) => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => platform } });

/* ------------------------------- the decision ------------------------------ */

test("an app-store build has no shop; web and desktop keep the reader's", () => {
  assert.equal(shopOf("ios"), "none");
  assert.equal(shopOf("android"), "none");
  assert.equal(shopOf("web"), "stripe");
  assert.equal(shopOf("desktop"), "stripe");
});

test("the shell is read from the globals the shells set, and iOS is named", () => {
  assert.equal(shellOf({}), "web");
  assert.equal(shellOf({ __TAURI_INTERNALS__: {} }), "desktop");
  assert.equal(shellOf(capacitor("ios")), "ios");
  assert.equal(shellOf(capacitor("android")), "android");
  // Capacitor answers `web` for a browser build; that is not a native shell.
  assert.equal(shellOf({ Capacitor: { isNativePlatform: () => false, getPlatform: () => "web" } }), "web");
});

test("a native shell that will not name its platform is answered the no-shop side", () => {
  // The Capacitor default for an unregistered platform is the unsafe direction.
  assert.equal(shellOf({ Capacitor: { isNativePlatform: () => true } }), "ios");
  assert.equal(shopOf(shellOf({ Capacitor: { isNativePlatform: () => true } })), "none");
});

/* -------------------------------- the refusal ------------------------------ */

test("an iOS account, signed in, refuses Checkout before it reads anything", async () => {
  const { fetch, calls } = stub();
  const account = new SyncAccount({ config: CONFIG, client: fakeClient(), fetch, shell: "ios" });
  assert.equal(account.shop, "none");
  const opened = [];
  await assert.rejects(
    () => account.checkout("monthly", (url) => opened.push(url)),
    (error) => error instanceof CheckoutError && error.code === "purchase_unavailable",
  );
  // Not a disabled button: no request, nothing opened, and the sentence is a
  // statement of absence rather than a direction to go and buy elsewhere.
  assert.deepEqual(calls, []);
  assert.deepEqual(opened, []);
  assert.equal(NOT_SOLD_HERE, "Subscriptions are not sold in this build.");
  assert.doesNotMatch(NOT_SOLD_HERE, /web|browser|stripe|https?:/i);
});

test("the real constructor in an iOS shell has no shop, and reaches no network", async () => {
  const { fetch, calls } = stub();
  await inShell(capacitor("ios"), async () => {
    const account = createSyncAccount(CONFIG, fakeClient());
    assert.equal(account.shell, "ios");
    assert.equal(account.shop, "none");
    await assert.rejects(
      () => account.checkout("yearly"),
      (error) => error instanceof CheckoutError && error.code === "purchase_unavailable",
    );
  });
  assert.deepEqual(calls, []);
});

test("the same account on the web still sells, so the guard is scoped", async () => {
  const { fetch, calls } = stub();
  const account = new SyncAccount({ config: CONFIG, client: fakeClient(), fetch, shell: "web" });
  assert.equal(account.shop, "stripe");
  const opened = [];
  const url = await account.checkout("monthly", (target) => opened.push(target));
  assert.equal(url, "https://checkout.stripe.test/session");
  assert.equal(calls.length, 1);
  assert.deepEqual(opened, ["https://checkout.stripe.test/session"]);
});

test("a store build still reads the row, so a web purchase is visible on the phone", async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify([{ cloud_sync: true, expires_at: null }]), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const account = new SyncAccount({ config: CONFIG, client: fakeClient(), fetch, shell: "ios" });
  assert.equal((await account.entitlement()).state, "active");
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/rest\/v1\/entitlements\?/);
});

/* ------------------------------ the screen --------------------------------- */

test("the price buttons exist only inside the canBuy block", () => {
  const template = component.slice(component.indexOf("</script>"));
  const guard = template.indexOf("{#if canBuy}");
  assert.ok(guard !== -1, "the buy block must be guarded by canBuy");

  const buys = [...template.matchAll(/buy\("(monthly|yearly)"\)/g)].map((match) => match.index);
  assert.equal(buys.length, 2, "exactly two plans, and both inside the guard");
  for (const at of buys) assert.ok(at > guard, "a buy() call sits outside the canBuy block");

  for (const price of ["$1 / month", "$10 / year"]) {
    const at = template.indexOf(price);
    assert.ok(at !== -1, `${price} must still be there for the builds that sell`);
    assert.ok(at > guard, `${price} is drawn outside the canBuy block`);
  }

  // And the build with no shop says so, in the same place the buttons would be.
  assert.ok(component.includes("{NOT_SOLD_HERE}"), "the no-shop build prints the absence");
  assert.ok(component.includes('account.shop === "stripe"'), "canBuy is the shop, not a flag");
});

test("no source file links to the shop except the one that owns it", () => {
  // The iOS surface rule, one level up: only sync-account.ts may know the host,
  // and it is the file whose checkout() is guarded above.
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) return walk(path);
      return /\.(ts|svelte)$/.test(entry.name) ? [path] : [];
    });
  const src = new URL("../../src/", import.meta.url).pathname;
  const holders = walk(src).filter((path) =>
    readFileSync(path, "utf8").includes("billing.hardlysleep.ing"),
  );
  assert.deepEqual(
    holders.map((path) => path.slice(src.length).replace(/^\//, "")),
    ["api/sync-account.ts"],
  );
});
