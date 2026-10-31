<script lang="ts">
  /**
   * Migrate a title to another source.
   *
   * Three steps, in the order the decision is actually made: **which source**, **which series on it**,
   * **what moves**. The third step is the one that matters — it is drawn from
   * `library.previewMigration`, the same plan the write uses, so the panel cannot promise a number the
   * migration does not deliver. A refusal is shown in the panel with the entry untouched, because a
   * migration that half-succeeded would be worse than one that did not start.
   *
   * Nothing is deleted before the Migrate button: the preview only reads.
   */
  import type { Series, Source } from "../api/source";
  import { providerLabel } from "../api/source";
  import { library, type MigrationPreview } from "../state/library.svelte";
  import { sourceKeyOf, sourceKeyOfMapping } from "../lib/marks";
  import { mappingFromId, type MigrationTarget } from "../lib/migrate";
  import { seriesLabel } from "../lib/titles";
  import Cover from "./Cover.svelte";
  import Sheet from "./Sheet.svelte";

  interface Props {
    /** The title to move; `null` closes the sheet. */
    series: Series | null;
    onclose: () => void;
    /** The title now reads from another source: the page behind the sheet has to reload. */
    onmigrated?: () => void;
  }
  let { series, onclose, onmigrated }: Props = $props();

  /** How many sources and results are drawn at once — a 2 351-source repo is a list, not a wall. */
  const SOURCE_LIMIT = 120;
  const RESULT_LIMIT = 12;

  let step = $state<"source" | "series" | "confirm">("source");
  let sourceQuery = $state("");
  let target = $state<Source | null>(null);
  let query = $state("");
  let results = $state<Series[]>([]);
  let searching = $state(false);
  let picked = $state<Series | null>(null);
  let preview = $state<MigrationPreview | null>(null);
  let previewing = $state(false);
  let busy = $state(false);
  let notice = $state("");

  /** The source this title is on now, so it is not offered as its own destination. */
  let currentKey = $state<string | undefined>(undefined);

  // A new title resets the sheet: the last one's source must not leak into this one.
  $effect(() => {
    const wanted = series;
    step = "source";
    sourceQuery = "";
    target = null;
    picked = null;
    preview = null;
    notice = "";
    results = [];
    query = "";
    currentKey = undefined;
    if (wanted === null) return;
    query = wanted.title;
    void (async () => {
      const store = library.profile?.store;
      if (store === undefined) return;
      const mapping = await store.getMapping(wanted.id);
      currentKey = mapping === undefined ? sourceKeyOf(wanted.id) : sourceKeyOfMapping(mapping.provider, mapping.sourceId);
      // Sources arrive in the background at boot; opening this sheet before they do must not show an
      // empty list, so ask once more.
      if (library.sources.length === 0) await library.loadSources();
    })();
  });

  /**
   * Installed sources, minus the one the title is already on, narrowed by the search box.
   *
   * Sorted by name, because the list is drawn from two hosts and the order they arrive in is the
   * order their extensions were installed — which changes and means nothing to a reader. The search
   * box is the way through sixty sources; the list is what makes the next tap obvious.
   */
  const offered = $derived.by(() => {
    const words = sourceQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return library.sources
      .filter((source) => source.id !== currentKey)
      .filter((source) => {
        if (words.length === 0) return true;
        const haystack = `${source.name} ${providerLabel(source.provider)} ${source.lang ?? ""}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
  });

  function chooseSource(source: Source): void {
    target = source;
    step = "series";
    notice = "";
    void search();
  }

  async function search(): Promise<void> {
    if (target === null) return;
    const text = query.trim();
    if (text === "") {
      results = [];
      return;
    }
    searching = true;
    notice = "";
    try {
      // The title being moved is never its own destination: a source's own search can list it (the
      // device source lists everything the device holds), and picking it would only be refused.
      results = (await library.searchSource(target.id, text)).filter((result) => result.id !== series?.id);
      if (results.length === 0) notice = `No results for “${text}” on ${target.name}.`;
    } catch (error) {
      results = [];
      notice = `${target.name} did not answer: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      searching = false;
    }
  }

  async function chooseSeries(candidate: Series): Promise<void> {
    if (series === null || target === null) return;
    picked = candidate;
    step = "confirm";
    previewing = true;
    preview = null;
    try {
      preview = await library.previewMigration(series.id, targetOf(candidate));
    } finally {
      previewing = false;
    }
  }

  function targetOf(candidate: Series): MigrationTarget {
    const source = target;
    return {
      provider: candidate.provider,
      // The same derivation a mapping row uses, so the source this title lands on is named the way
      // every other mapping names it.
      sourceId: source === null ? "" : (mappingFromId(source.id)?.sourceId ?? ""),
      seriesId: candidate.id,
      title: candidate.title,
      sourceName: source?.name ?? providerLabel(candidate.provider),
      ...(candidate.cover === undefined ? {} : { cover: candidate.cover }),
    };
  }

  async function migrate(): Promise<void> {
    if (series === null || picked === null || preview === null || !preview.ok || busy) return;
    busy = true;
    try {
      const result = await library.migrate(series.id, targetOf(picked));
      if (!result.ok) {
        notice = result.message;
        return;
      }
      onclose();
      onmigrated?.();
    } finally {
      busy = false;
    }
  }

  const title = $derived(
    step === "source" ? "Migrate to another source" : step === "series" ? (target?.name ?? "Pick the series") : "What moves",
  );
</script>

<Sheet open={series !== null} {title} onclose={onclose}>
  {#if series !== null}
    {#if step === "source"}
      <p class="lead">
        {seriesLabel(series.title)} keeps its id, its categories and its history. Only the source it
        reads from changes.
      </p>
      <input
        class="field"
        bind:value={sourceQuery}
        placeholder="Search sources"
        enterkeyhint="search"
        aria-label="Search sources"
      />
      <div class="list">
        {#each offered.slice(0, SOURCE_LIMIT) as source (source.id)}
          <button class="row" onclick={() => chooseSource(source)}>
            <span class="name">{source.name}</span>
            <span class="meta">{providerLabel(source.provider)}{source.lang === undefined ? "" : ` · ${source.lang}`}</span>
          </button>
        {/each}
      </div>
      {#if offered.length === 0}
        <p class="hint">No source matches. Installed extensions and servers appear here once they load.</p>
      {:else if offered.length > SOURCE_LIMIT}
        <p class="hint">{offered.length - SOURCE_LIMIT} more — search to narrow.</p>
      {/if}
    {:else if step === "series"}
      <div class="find">
        <input
          class="field"
          bind:value={query}
          placeholder="Search this source"
          enterkeyhint="search"
          onkeydown={(event) => {
            if (event.key === "Enter") void search();
          }}
        />
        <button class="btn" disabled={searching} onclick={() => void search()}>{searching ? "…" : "Search"}</button>
      </div>

      <div class="list">
        {#each results.slice(0, RESULT_LIMIT) as result (result.id)}
          <button class="row pick" onclick={() => void chooseSeries(result)}>
            <span class="thumb"><Cover series={result} size="row" /></span>
            <span class="words">
              <span class="name">{seriesLabel(result.title)}</span>
              <span class="meta">{result.author ?? "Unknown author"}</span>
            </span>
          </button>
        {/each}
      </div>

      {#if notice !== ""}<p class="notice" role="status">{notice}</p>{/if}

      <div class="foot">
        <button class="btn ghost" onclick={() => (step = "source")}>Back</button>
      </div>
    {:else}
      {#if picked !== null}
        <div class="who">
          <span class="thumb"><Cover series={picked} size="row" /></span>
          <span class="words">
            <strong>{seriesLabel(picked.title)}</strong>
            <em>on {target?.name ?? "the new source"}</em>
          </span>
        </div>
      {/if}

      {#if previewing}
        <p class="hint">Reading both chapter lists…</p>
      {:else if preview === null}
        <p class="hint">Nothing to show.</p>
      {:else if !preview.ok}
        <p class="refusal" role="alert">{preview.message}</p>
        <p class="hint">Nothing was changed — the title stays on {target === null ? "its source" : "the source it is on"}.</p>
      {:else}
        <dl class="facts">
          {#each preview.rows as row (row.label)}
            <div>
              <dt>{row.label}</dt>
              <dd>{row.value}{#if row.note !== undefined}<span class="note">{row.note}</span>{/if}</dd>
            </div>
          {/each}
        </dl>
      {/if}

      {#if notice !== ""}<p class="notice" role="alert">{notice}</p>{/if}

      <div class="foot">
        <button class="btn ghost" disabled={busy} onclick={() => (step = "series")}>Back</button>
        <button class="btn primary" disabled={busy || previewing || preview === null || !preview.ok} onclick={() => void migrate()}>
          {busy ? "Migrating…" : "Migrate"}
        </button>
      </div>
    {/if}
  {/if}
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
    margin-bottom: var(--s3);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-height: 46vh;
    overflow-y: auto;
    margin-top: var(--s2);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--s3);
    width: 100%;
    min-height: 44px;
    padding: var(--s2) var(--s3);
    border: 0;
    border-radius: var(--r2);
    background: transparent;
    color: var(--text-1);
    text-align: left;
    cursor: pointer;
  }
  .row:hover {
    background: var(--surface-2);
  }

  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t-md);
  }
  .meta {
    flex: 0 0 auto;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .pick .words,
  .who .words {
    display: flex;
    flex-direction: column;
    min-width: 0;
    flex: 1;
  }
  .pick .name {
    flex: none;
  }
  .words em {
    font-style: normal;
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .thumb {
    width: 44px;
    flex: 0 0 44px;
    aspect-ratio: 2 / 3;
    border-radius: var(--r1);
    overflow: hidden;
    background: var(--surface-2);
  }

  .who {
    display: flex;
    align-items: center;
    gap: var(--s3);
    margin-bottom: var(--s3);
  }

  .facts {
    display: grid;
    gap: var(--s2);
    margin: 0;
    font-size: var(--t-sm);
  }
  .facts > div {
    display: flex;
    justify-content: space-between;
    gap: var(--s3);
    padding: var(--s1) 0;
    border-bottom: 1px solid var(--edge);
  }
  .facts > div:last-child {
    border-bottom: 0;
  }
  .facts dt {
    color: var(--text-3);
  }
  .facts dd {
    margin: 0;
    text-align: right;
    color: var(--text-1);
  }
  .note {
    display: block;
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .refusal {
    margin: 0 0 var(--s2);
    padding: var(--s3);
    border-radius: var(--r2);
    background: color-mix(in srgb, var(--warning) 16%, transparent);
    color: var(--text-1);
    font-size: var(--t-sm);
  }

  .notice {
    margin: var(--s3) 0 0;
    padding: var(--s2) var(--s3);
    border-radius: var(--r2);
    background: color-mix(in srgb, var(--accent) 16%, transparent);
    color: var(--text-1);
    font-size: var(--t-xs);
  }

  .hint {
    margin: var(--s2) 2px;
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .foot {
    display: flex;
    justify-content: space-between;
    gap: var(--s2);
    margin-top: var(--s4);
  }

  /* 44px on a phone: the app's own button is 36, and the one that moves a title is worth a finger. */
  .foot .btn {
    min-height: 44px;
  }
</style>
