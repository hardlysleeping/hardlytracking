<script lang="ts">
  /**
   * The tracking card: what the service says about this title, and the two controls that change it.
   *
   * It is deliberately small. Everything that decides *whether* a push happens lives in
   * `host.ts`/`types.ts`; this file reads a row and offers bind, refresh and unlink. The card sits on
   * the series page below the description, which is where the plan put it: the card is about this
   * title, not a second settings screen.
   */
  import TrackerBindSheet from "./TrackerBindSheet.svelte";
  import { go } from "../lib/nav";
  import { library } from "../state/library.svelte";
  import { trackerLabel } from "../lib/trackers/labels";
  import { ensureTracker, trackers } from "../lib/trackers/sync";
  import { pullSeries, unbindSeries } from "../lib/trackers/host";
  import { STATUS_LABEL, type TrackerAccountRow, type TrackerRow, type TrackerService } from "../lib/trackers/types";

  interface Props {
    seriesId: string;
    /** What the series is called, for the search that starts a bind. */
    title: string;
    /** The highest chapter read here — a bound service is owed at least this much. */
    localChapter: number;
    /** A bind or unlink changed the library's own facts; the shelf may want to recount. */
    onchange?: () => void;
  }
  let { seriesId, title, localChapter, onchange }: Props = $props();

  let accounts = $state<TrackerAccountRow[]>([]);
  let rows = $state<TrackerRow[]>([]);
  let loading = $state(true);
  let busy = $state<string | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let binding = $state<TrackerService | null>(null);

  async function refresh(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) {
      loading = false;
      return;
    }
    const [stored, bound] = await Promise.all([store.listTrackerAccounts(), store.listTrackersForSeries(seriesId)]);
    // A stored account is not a working adapter: the launch path registers them, and this page can
    // be opened before that finishes.
    const ready: TrackerAccountRow[] = [];
    for (const account of stored) {
      if (await ensureTracker(store, account.service)) ready.push(account);
    }
    accounts = ready;
    rows = bound;
    loading = false;
  }

  $effect(() => {
    // One load per series: `seriesId` is the only input this card has.
    const wanted = seriesId;
    void wanted;
    loading = true;
    error = null;
    notice = null;
    void refresh();
  });

  const connected = $derived(accounts.map((account) => account.service));
  const unbound = $derived(connected.filter((service) => !rows.some((row) => row.service === service)));

  function ago(at: number | undefined): string {
    if (at === undefined) return "never synced";
    const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
    if (seconds < 60) return "synced just now";
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `synced ${minutes}m ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `synced ${hours}h ago`;
    return `synced ${Math.round(hours / 24)}d ago`;
  }

  async function sync(service: TrackerService): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined || busy !== null) return;
    busy = service;
    error = null;
    notice = null;
    try {
      const results = await pullSeries({ store, trackers }, seriesId);
      const mine = results.find((result) => result.row.service === service);
      rows = await store.listTrackersForSeries(seriesId);
      if (mine?.disagreement === true) {
        notice = `${trackerLabel(service)} is behind this device. The next finished chapter pushes the gap.`;
      }
    } catch (problem) {
      error = problem instanceof Error ? problem.message : String(problem);
    } finally {
      busy = null;
    }
  }

  async function unlink(service: TrackerService, remoteTitle: string | undefined): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined || busy !== null) return;
    busy = service;
    error = null;
    notice = null;
    try {
      await unbindSeries(store, service, seriesId);
      rows = await store.listTrackersForSeries(seriesId);
      notice = `Unlinked from ${remoteTitle ?? trackerLabel(service)}. Nothing here was changed.`;
      onchange?.();
    } catch (problem) {
      error = problem instanceof Error ? problem.message : String(problem);
    } finally {
      busy = null;
    }
  }

  async function bound(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    rows = await store.listTrackersForSeries(seriesId);
    notice = "Bound. Progress pushes as you read.";
    onchange?.();
    // The bound row is only useful with the service's own numbers on it, and the first pull is
    // cheap because the entry was just read during the bind.
    void sync(rows[rows.length - 1]?.service ?? "kitsu");
  }
</script>

<section class="tracking" aria-label="Tracking">
  <header>
    <h2>Tracking</h2>
    {#if loading}
      <span class="sub">Checking…</span>
    {:else if accounts.length > 0}
      <span class="sub">{connected.map(trackerLabel).join(" · ")}</span>
    {/if}
  </header>

  {#if !loading && accounts.length === 0}
    <p class="line">
      No tracker connected. Connect Kitsu in Settings → Reading sync, and this title can move its
      progress there as you read.
    </p>
    <button class="btn ghost small" onclick={() => go("/settings")}>Open settings</button>
  {:else if !loading}
    {#each connected as service (service)}
      {@const row = rows.find((candidate) => candidate.service === service)}
      {#if row === undefined}
        <div class="offer">
          <span class="who">
            <strong>{trackerLabel(service)}</strong>
            <em>not bound</em>
          </span>
          <button class="btn small" onclick={() => (binding = service)}>Bind</button>
        </div>
      {:else}
        <div class="entry">
          <span class="who">
            <strong>{row.remoteTitle ?? `${trackerLabel(service)} #${row.remoteId}`}</strong>
            <em>
              {[
                row.status === undefined ? null : STATUS_LABEL[row.status],
                row.lastChapter === undefined || row.lastChapter === 0 ? null : `chapter ${row.lastChapter}`,
                ago(row.syncedAt),
              ]
                .filter((part) => part !== null)
                .join(" · ")}
            </em>
            {#if row.pending !== undefined}
              <em class="waiting">
                Chapter {row.pending.chapter} waiting to push{#if row.pending.error !== undefined} — {row.pending.error}{/if}
              </em>
            {/if}
          </span>
          <div class="acts">
            <button class="btn ghost small" disabled={busy !== null} onclick={() => void sync(service)}>
              {busy === service ? "…" : "Refresh"}
            </button>
            <button class="btn ghost small" disabled={busy !== null} onclick={() => void unlink(service, row.remoteTitle)}>
              Unlink
            </button>
          </div>
        </div>
      {/if}
    {/each}
    {#if unbound.length > 0 && rows.length > 0}
      <p class="line">One series can be bound to more than one list. Unbound: {unbound.map(trackerLabel).join(", ")}.</p>
    {/if}
  {/if}

  {#if error !== null}<p class="bad" role="alert">{error}</p>{/if}
  {#if notice !== null}<p class="good" role="status">{notice}</p>{/if}
</section>

{#if binding !== null}
  <TrackerBindSheet
    open={binding !== null}
    service={binding}
    {seriesId}
    {title}
    {localChapter}
    onclose={() => (binding = null)}
    onbound={() => void bound()}
  />
{/if}

<style>
  .tracking {
    margin: var(--s4) 0 var(--s3);
    padding: var(--s3) var(--s4);
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    min-width: 0;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s2);
    flex-wrap: wrap;
  }
  h2 {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin: 0;
  }
  .sub {
    font-size: var(--t-xs);
    color: var(--text-3);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .line {
    margin: var(--s2) 0 0;
    font-size: var(--t-sm);
    color: var(--text-2);
    line-height: 1.5;
  }
  .offer,
  .entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    margin-top: var(--s2);
    min-width: 0;
  }
  .who {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .who strong {
    font-size: var(--t-md);
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .who em {
    font-style: normal;
    font-size: var(--t-xs);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .who em.waiting {
    color: var(--warning, #b7791f);
  }
  .acts {
    display: flex;
    gap: var(--s2);
    flex: 0 0 auto;
  }
  .bad {
    margin: var(--s2) 0 0;
    font-size: var(--t-xs);
    color: var(--bad, #c0392b);
  }
  .good {
    margin: var(--s2) 0 0;
    font-size: var(--t-xs);
    color: var(--good, #1e8449);
  }
</style>