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
   * - **signed out** — an email and a code. The code rather than a link because a
   *   link has to come back into the app through a URL scheme, and a six-digit code
   *   is typed into the screen that asked for it.
   * - **signed in** — what the row says, with the date it runs to, and the way out.
   *
   * Nothing here caches a grant: every mount asks, because a cached "yes" that
   * outlives a lapsed card is the one bug this must never have.
   */
  import {
    entitlement,
    envOfBuild,
    ownOrigin,
    readSession,
    requestCode,
    signOut,
    startCheckout,
    syncConfig,
    verifyCode,
    type SyncSession,
    type SyncState,
  } from "../api/sync-account";

  const config = syncConfig(envOfBuild());

  let session = $state<SyncSession | null>(config === null ? null : readSession());
  let account = $state<SyncState | null>(null);
  let email = $state("");
  let code = $state("");
  let stage = $state<"email" | "code">("email");
  let busy = $state(false);
  let note = $state("");

  /** What the server says about this account, every time the section is shown. */
  async function check(): Promise<void> {
    if (config === null || session === null) return;
    account = await entitlement({ config, session });
  }

  $effect(() => {
    if (session !== null) void check();
  });

  async function sendCode(): Promise<void> {
    if (config === null || busy) return;
    busy = true;
    note = "";
    const answer = await requestCode({ config, email });
    busy = false;
    if (answer === "sent") {
      stage = "code";
      note = `A code is on its way to ${email.trim()}.`;
      return;
    }
    note = answer === "refused" ? "That address was refused. Check it and try again." : "Could not reach the server.";
  }

  async function useCode(): Promise<void> {
    if (config === null || busy) return;
    busy = true;
    note = "";
    const signed = await verifyCode({ config, email, code });
    busy = false;
    if (signed === null) {
      note = "That code was not accepted. Ask for a new one.";
      return;
    }
    session = signed;
    code = "";
    stage = "email";
    note = "";
  }

  async function buy(plan: "monthly" | "yearly"): Promise<void> {
    if (session === null) return;
    busy = true;
    note = "";
    const url = await startCheckout({ config: config!, session, plan, origin: ownOrigin() });
    busy = false;
    note = url === null ? "Could not open Checkout." : "Checkout is open in your browser. Come back when it is done.";
  }

  async function leave(): Promise<void> {
    if (config === null || session === null) return;
    await signOut({ config, session });
    session = null;
    account = null;
    note = "";
  }

  const until = (at: number | null): string => (at === null ? "" : new Date(at).toLocaleDateString());
</script>

{#if config !== null}
  <section class="group">
    <h2>HardlySyncing</h2>
    <p class="hint">
      One subscription, for this app and the reader: what it carries is your own state between your
      devices, and it is bought once. Manual backup above is free and always will be.
    </p>

    {#if session === null}
      {#if stage === "email"}
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
          <button class="chip" disabled={busy || email.trim() === ""} onclick={() => void sendCode()}>
            {busy ? "Sending…" : "Email me a code"}
          </button>
        </div>
      {:else}
        <label class="row">
          <span>Code<em class="sub">Six digits, from the email sent to {email.trim()}.</em></span>
          <input
            class="field num"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            value={code}
            maxlength="6"
            spellcheck="false"
            onchange={(event) => (code = event.currentTarget.value)}
          />
        </label>
        <div class="chips">
          <button class="chip on" disabled={busy || code.trim() === ""} onclick={() => void useCode()}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button class="chip" disabled={busy} onclick={() => void sendCode()}>Send another</button>
        </div>
      {/if}
    {:else}
      <div class="row">
        <span>
          {#if account === null}
            Checking…
          {:else if account.state === "active"}
            Active{#if account.expiresAt !== null}<em class="sub">Paid to {until(account.expiresAt)}</em>{/if}
          {:else if account.state === "none"}
            Not subscribed<em class="sub">{account.reason}</em>
          {:else}
            Could not check<em class="sub">{account.reason}</em>
          {/if}
        </span>
        <button class="chip" disabled={busy} onclick={() => void check()}>Check</button>
      </div>
      {#if account !== null && account.state !== "active"}
        <div class="chips">
          <button class="chip on" disabled={busy} onclick={() => void buy("monthly")}>$1 / month</button>
          <button class="chip on" disabled={busy} onclick={() => void buy("yearly")}>$10 / year</button>
        </div>
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

  .field.num {
    width: 96px;
  }
</style>