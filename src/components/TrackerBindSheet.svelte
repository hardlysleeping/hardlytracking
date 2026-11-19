<script lang="ts">
  /**
   * Bind a series to a tracker entry.
   *
   * The search is the service's own — this app does not guess a match, because a wrong match on a
   * reading list is worse than an unbound title. The card and the sheet share one write path
   * (`bindSeries` in `host.ts`), so the row the panel shows and the row the reader lives with are
   * the same row.
   */
  import Sheet from "./Sheet.svelte";
  import { library } from "../state/library.svelte";
  import { trackers } from "../lib/trackers/sync";
  import { trackerLabel } from "../lib/trackers/labels";
  import { bindSeries } from "../lib/trackers/host";
  import type { TrackerSearchResult, TrackerService } from "../lib/trackers/types";

  interface Props {
    open: boolean;
    service: TrackerService;
    seriesId: string;
    title: string;
    /** The highest chapter read here, so the first sync has something to push. */
    localChapter: number;
    onclose: () => void;
    onbound: () => void;
  }
  let { open, service, seriesId, title, localChapter, onclose, onbound }: Props = $props();

  let query = $state("");
  let results = $state<TrackerSearchResult[]>([]);
  let searching = $state(false);
  let binding = $state<string | null>(null);
  let notice = $state<string | null>(null);

  // A new series (or a new service) starts from that title, never from the last one's search.
  $effect(() => {
    const wanted = `${service}:${seriesId}`;
    void wanted;
    query = title;
    results = [];
    notice = null;
    binding = null;
  });

  async function search(): Promise<void> {
    const text = query.trim();
    if (text === "") return;
    const adapter = trackers[service];
    if (adapter === undefined) {
      notice = `${trackerLabel(service)} is not connected. Connect it in Settings → Reading sync.`;
      return;
    }
    searching = true;
    notice = null;
    try {
      results = await adapter.search(text);
      if (results.length === 0) notice = `No ${trackerLabel(service)} entry matches “${text}”.`;
    } catch (error) {
      results = [];
      notice = error instanceof Error ? error.message : String(error);
    } finally {
      searching = false;
    }
  }

  async function bind(result: TrackerSearchResult): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined || binding !== null) return;
    binding = result.remoteId;
    notice = null;
    try {
      await bindSeries(
        { store, trackers },
        {
          seriesId,
          service,
          remoteId: result.remoteId,
          remoteTitle: result.title,
          localChapter,
        },
      );
      onbound();
      onclose();
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
    } finally {
      binding = null;
    }
  }
</script>

<Sheet {open} title={`Bind to ${trackerLabel(service)}`} {onclose}>
  <p class="lead">
    Pick the entry on {trackerLabel(service)} that is this title. Nothing is guessed from
    the name — a wrong match on a reading list is worse than an unbound series.
  </p>
  <form
    class="find"
    onsubmit={(event) => {
      event.preventDefault();
      void search();
    }}
  >
    <input
      class="field"
      bind:value={query}
      placeholder="Search the service"
      aria-label={`Search ${trackerLabel(service)}`}
      enterkeyhint="search"
      disabled={searching}
    />
    <button class="btn" type="submit" disabled={searching || query.trim() === ""}>
      {searching ? "…" : "Search"}
    </button>
  </form>

  {#if notice !== null}<p class="notice" role="status">{notice}</p>{/if}

  <div class="list">
    {#each results as result (result.remoteId)}
      <button class="row" disabled={binding !== null} onclick={() => void bind(result)}>
        <span class="thumb">
          {#if result.cover}
            <img src={result.cover} alt="" loading="lazy" />
          {/if}
        </span>
        <span class="words">
          <span class="name">{result.title}</span>
          <span class="meta">
            {[
              result.year === undefined ? null : String(result.year),
              result.totalChapters === undefined || result.totalChapters === 0 ? null : `${result.totalChapters} chapters`,
            ]
              .filter((part) => part !== null)
              .join(" · ") || "No details"}
          </span>
        </span>
        {#if binding === result.remoteId}<span class="spin" aria-hidden="true"></span>{/if}
      </button>
    {/each}
  </div>
</Sheet>

<style>
  .lead {
    margin: 0 0 var(--s3);
    font-size: var(--t-sm);
    color: var(--text-2);
  }
  .field {
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: var(--r2);
    border: 1px solid var(--edge);
    background: var(--surface-2);
    color: var(--text-1);
    /* 16px stops iOS zooming the whole app when the field is focused. */
    font-size: 16px;
  }
  .find {
    display: flex;
    gap: var(--s2);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 46vh;
    overflow-y: auto;
    margin-top: var(--s3);
  }
  .row {
    display: flex;
    align-items: center;
    gap: var(--s3);
    width: 100%;
    min-height: 52px;
    padding: var(--s2) var(--s3);
    border: 0;
    border-radius: var(--r2);
    background: transparent;
    color: var(--text-1);
    text-align: left;
    cursor: pointer;
  }
  .row:hover:not(:disabled) {
    background: var(--surface-2);
  }
  .row:disabled {
    opacity: 0.6;
  }
  .thumb {
    width: 40px;
    flex: 0 0 40px;
    aspect-ratio: 2 / 3;
    border-radius: var(--r1);
    overflow: hidden;
    background: var(--surface-2);
  }
  .thumb img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .words {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
  }
  .name {
    font-size: var(--t-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    font-size: var(--t-xs);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .notice {
    margin: var(--s3) 0 0;
    padding: var(--s2) var(--s3);
    border-radius: var(--r2);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--text-1);
    font-size: var(--t-xs);
  }
  .spin {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
    border-radius: 50%;
    border: 2px solid var(--edge);
    border-top-color: var(--accent);
    animation: turn 0.8s linear infinite;
  }
  @keyframes turn {
    to {
      transform: rotate(360deg);
    }
  }
</style>