<script lang="ts">
  /**
   * Reading sync, and the one catalogue tracker that can be connected today.
   *
   * Komga and Suwayomi are servers this app talks to directly. Kitsu is the first *tracker*: a list
   * that lives on someone else's service. It is connectable with a token from the reader's own
   * Kitsu account, which is the only credential this app can ask for without an app registration.
   *
   * The other services are listed with the reason they are not here, not a vague "unavailable":
   * a control that explains itself is worth more than one that only says no.
   */
  import { onMount } from "svelte";
  import { library } from "../state/library.svelte";
  import KomgaLogin from "./KomgaLogin.svelte";
  import SuwayomiLogin from "./SuwayomiLogin.svelte";
  import { login, registerKitsu } from "../lib/trackers/kitsu";
  import { syncTrackersNow, unregisterTracker } from "../lib/trackers/sync";

  const catalogueTrackers = ["MyAnimeList", "AniList", "Shikimori", "Bangumi", "MangaUpdates"];

  /** The Kitsu account, as far as this device knows: an id, never the token. */
  let connected = $state<{ id: string } | null>(null);
  let email = $state("");
  let password = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  onMount(() => {
    void (async () => {
      const store = library.profile?.store;
      if (store === undefined) return;
      const account = await store.getTrackerAccount("kitsu");
      if (account !== undefined && account.accessToken !== "") {
        connected = { id: account.username ?? "" };
      }
    })();
  });

  async function connect(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    busy = true;
    error = null;
    notice = null;
    try {
      // Kitsu has no personal API tokens — its only self-service grant is the reader's own email
      // and password, which it exchanges here for a 30-day token pair. Nothing is stored until it
      // names a real account: an ignored token answers 200 with no rows, and saving that would look
      // connected while every push failed.
      const session = await login(email.trim(), password);
      await store.putTrackerAccount({
        service: "kitsu",
        accessToken: session.accessToken,
        username: session.userId,
        ...(session.refreshToken === undefined ? {} : { refreshToken: session.refreshToken }),
        ...(session.expiresAt === undefined ? {} : { expiresAt: session.expiresAt }),
      });
      await registerKitsu(store);
      connected = { id: session.userId };
      email = "";
      password = "";
      notice = session.name === undefined ? "Kitsu connected." : `Kitsu connected as ${session.name}.`;
    } catch (problem) {
      error = problem instanceof Error ? problem.message : String(problem);
    } finally {
      busy = false;
    }
  }

  async function disconnect(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    busy = true;
    error = null;
    notice = null;
    try {
      await store.removeTrackerAccount("kitsu");
      unregisterTracker("kitsu");
      connected = null;
      notice = "Kitsu disconnected. Your reading marks here are untouched.";
    } catch (problem) {
      // The account is still stored, so the card must keep saying Connected — and say why the
      // button did not take it away, instead of looking like a tap that was ignored.
      error = problem instanceof Error ? problem.message : String(problem);
    } finally {
      busy = false;
    }
  }

  async function syncNow(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    busy = true;
    error = null;
    notice = null;
    try {
      const result = await syncTrackersNow(store);
      notice =
        result.failed === 0
          ? `Synced ${result.flushed} ${result.flushed === 1 ? "title" : "titles"}.`
          : `Synced ${result.flushed}, ${result.failed} failed — they will be retried.`;
    } catch (problem) {
      error = problem instanceof Error ? problem.message : String(problem);
    } finally {
      busy = false;
    }
  }
</script>

<section class="trackers" aria-label="Trackers and reading sync">
  <h2>Reading sync</h2>
  <p class="intro">Connect your own server to keep reading progress and read marks in sync. Komga and Suwayomi are built in; no extension installation is needed.</p>
  <article>
    <h3>Komga</h3>
    <p>Two-way read-state sync for books from your Komga server.</p>
    <KomgaLogin onchange={() => library.refreshKomga()} />
  </article>
  <article>
    <h3>Suwayomi</h3>
    <p>Two-way read-state sync for titles from your Suwayomi server.</p>
    <SuwayomiLogin onchange={() => library.refreshSuwayomi()} />
  </article>

  <h2>Catalogue trackers</h2>
  <p class="intro">Your own list on someone else's service. Progress is still read here first: a chapter read while the service is down is read, and the push waits.</p>

  <article>
    <h3>Kitsu</h3>
    {#if connected}
      <p>Connected{#if connected.id} · account {connected.id}{/if}. Finished chapters are queued for Kitsu as you read them.</p>
      <div class="row">
        <button class="btn" onclick={() => void syncNow()} disabled={busy}>Sync now</button>
        <button class="btn ghost" onclick={() => void disconnect()} disabled={busy}>Disconnect</button>
      </div>
    {:else}
      <p>
        Sign in with your Kitsu account. It is exchanged directly with kitsu.io, and only the token
        Kitsu returns is kept — on this device, never sent anywhere else.
      </p>
      <form
        class="row"
        onsubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <input
          class="field"
          type="email"
          bind:value={email}
          placeholder="Kitsu email"
          aria-label="Kitsu email"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          disabled={busy}
        />
        <input
          class="field"
          type="password"
          bind:value={password}
          placeholder="Kitsu password"
          aria-label="Kitsu password"
          autocomplete="current-password"
          disabled={busy}
        />
        <button class="btn" type="submit" disabled={busy || email.trim() === "" || password === ""}>
          {busy ? "Signing in…" : "Connect"}
        </button>
      </form>
    {/if}
    {#if error}<p class="bad" role="alert">{error}</p>{/if}
    {#if notice}<p class="good">{notice}</p>{/if}
  </article>

  <p class="intro">These need an app registration this build does not ship, so signing in is not offered rather than offered and broken:</p>
  <ul>
    {#each catalogueTrackers as name}
      <li><span>{name}</span><span class="unavailable">Needs an app registration</span></li>
    {/each}
  </ul>
</section>

<style>
  .trackers { min-width: 0; }
  h2 { font-size: var(--t-sm); color: var(--text-2); margin: var(--s4) 0 var(--s2); }
  h3 { font-size: var(--t-lg); margin: 0 0 var(--s1); }
  .intro, article p { color: var(--text-2); font-size: var(--t-sm); line-height: 1.6; margin: 0; overflow-wrap: anywhere; }
  article { margin-top: var(--s3); padding: var(--s4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r3); min-width: 0; }
  .row { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s3); align-items: center; }
  .row .field { flex: 1 1 14rem; min-width: 0; }
  .bad { color: var(--bad, #c0392b); margin-top: var(--s2); }
  .good { color: var(--good, #1e8449); margin-top: var(--s2); }
  ul { margin: var(--s2) 0 0; padding: 0; list-style: none; }
  li { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: var(--s2); padding: var(--s3) 0; border-bottom: 1px solid var(--line); font-size: var(--t-md); }
  .unavailable { color: var(--text-2); font-size: var(--t-sm); }
</style>