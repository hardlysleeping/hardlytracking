<script lang="ts">
  /**
   * HardlySyncing, on the screen where a reader looks for it.
   *
   * The subscription is one row per account, shared with the other apps that read
   * the same project — so this screen never sells a second one, and never asks for
   * a licence key. It asks the server what the row says and shows that.
   *
   * Three states, and each says a true thing:
   *
   * - **no Supabase in this build** — the whole section is absent. A build that
   *   cannot check is not a build that should draw a paid switch.
   * - **no shop in this build** — an app-store build (iOS, Android) draws no
   *   price and calls no Checkout: Apple's 3.1.1 forbids sending someone to an
   *   outside checkout for a subscription, and there is no StoreKit product to
   *   sell instead. The dedicated Sync page still allows account sign-in so an existing
   *   subscription is accessible; an inline panel stays hidden until signed in. Neither
   *   invites a sale or exposes checkout on native builds.
   * - **signed out** — an email and a link, which is exactly the reader's sign-in:
   *   the same SDK, the same `signInWithOtp`, the same email template. Nothing to
   *   type back in, and nothing to configure on the project.
   * - **signed in** — what the row says, with the date it runs to, and the way out.
   *
   * Nothing here caches a grant: every mount asks, because a cached "yes" that
   * outlives a lapsed card is the one bug this must never have.
   */
  import {
    CHECKOUT_OPENED,
    LINK_SENT,
    NOT_SOLD_HERE,
    createSyncAccount,
    syncConfig,
  } from "../api/sync-account";

  /** A dedicated Sync page stays useful even when its backend is absent. */
  let { standalone = false }: { standalone?: boolean } = $props();
  const account = createSyncAccount(syncConfig());

  /**
   * Whether this build sells at all. An app-store build does not: no price, no
   * Checkout, and nothing on this screen pointing anywhere to buy one. The row
   * is still read, so a subscription bought on the web is visible here.
   */
  const canBuy = account !== null && account.shop === "stripe";

  let session = $state<{ userId: string; email: string } | null>(null);
  let entitlementState = $state<Awaited<ReturnType<NonNullable<typeof account>["entitlement"]>> | null>(null);
  let email = $state("");
  let busy = $state(false);
  let sent = $state(false);
  let note = $state("");
  /** False until the first look at this device's session has finished. */
  let ready = $state(false);

  /** Who this device is, and what the server says about them. No cache. */
  async function refresh(): Promise<void> {
    if (account === null) return;
    const found = await account.session();
    session = found === null ? null : { userId: found.userId, email: found.email };
    entitlementState = found === null ? null : await account.entitlement();
    ready = true;
  }

  $effect(() => {
    void refresh();
  });

  async function send(): Promise<void> {
    if (account === null || busy) return;
    busy = true;
    note = "";
    try {
      await account.sendLink(email);
      sent = true;
      note = LINK_SENT;
    } catch (cause) {
      note = cause instanceof Error ? cause.message : "the sign-in link could not be sent";
    } finally {
      busy = false;
    }
  }

  async function buy(plan: "monthly" | "yearly"): Promise<void> {
    if (account === null || !canBuy) return;
    busy = true;
    note = "";
    try {
      await account.checkout(plan);
      note = CHECKOUT_OPENED;
    } catch (cause) {
      note = cause instanceof Error ? cause.message : "Checkout could not be opened";
    } finally {
      busy = false;
    }
  }

  async function leave(): Promise<void> {
    if (account === null) return;
    await account.signOut();
    sent = false;
    note = "";
    await refresh();
  }

  const until = (at: number | null): string => (at === null ? "" : new Date(at).toLocaleDateString());
</script>

{#if account === null && standalone}
  <p class="hint" role="status">Cloud sync is not configured in this build. Local reading and manual backup are still available.</p>
{:else if account !== null && (standalone || canBuy || (ready && session !== null))}
  <section class="group">
    <h2>HardlySyncing</h2>
    <p class="hint">
      One subscription, for this app and the reader: what it carries is your own state between your
      devices, and it is bought once. Manual backup is free and always will be.
    </p>

    {#if session === null}
      <label class="row">
        <span>Email<em class="sub">The same address you use in the reader, so it is the same account.</em></span>
        <input
          class="field"
          type="email"
          value={email}
          placeholder="you@example.com"
          autocomplete="email"
          spellcheck="false"
          onchange={(event) => (email = event.currentTarget.value)}
        />
      </label>
      <div class="chips">
        <button class="chip" disabled={busy || email.trim() === ""} onclick={() => void send()}>
          {busy ? "Sending…" : sent ? "Send another link" : "Email me a link"}
        </button>
        {#if sent}
          <button class="chip" disabled={busy} onclick={() => void refresh()}>I've opened it</button>
        {/if}
      </div>
    {:else}
      <div class="row">
        <span>
          {#if entitlementState === null}
            Checking…
          {:else if entitlementState.state === "active"}
            Active{#if entitlementState.expiresAt !== null}<em class="sub">Paid to {until(entitlementState.expiresAt)}</em>{/if}
          {:else if entitlementState.state === "none"}
            Not subscribed<em class="sub">{entitlementState.reason}</em>
          {:else}
            Could not check<em class="sub">{entitlementState.reason}</em>
          {/if}
          {#if session.email !== ""}<em class="sub">{session.email}</em>{/if}
        </span>
        <button class="chip" disabled={busy} onclick={() => void refresh()}>Check</button>
      </div>
      {#if entitlementState !== null && entitlementState.state !== "active"}
        {#if canBuy}
          <div class="chips">
            <button class="chip on" disabled={busy} onclick={() => void buy("monthly")}>$1 / month</button>
            <button class="chip on" disabled={busy} onclick={() => void buy("yearly")}>$10 / year</button>
          </div>
        {:else}
          <p class="hint">{NOT_SOLD_HERE}</p>
        {/if}
      {/if}
      <div class="chips">
        <button class="chip" disabled={busy} onclick={() => void leave()}>Sign out</button>
      </div>
    {/if}

    {#if note !== ""}
      <p class="hint">{note}</p>
    {/if}
  </section>
{/if}

<style>
  .row {
    flex-wrap: wrap;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    min-height: 44px;
    font-size: var(--t-md);
  }

  .sub {
    display: block;
    margin-top: 2px;
    font-size: var(--t-xs);
    font-style: normal;
    color: var(--text-3);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    margin-top: var(--s2);
  }

  .hint {
    margin: var(--s2) 0 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.6;
  }
</style>