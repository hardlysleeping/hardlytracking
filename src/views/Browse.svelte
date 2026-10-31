<script lang="ts">
  /**
   * Browse: where sources live.
   *
   * Three doors, in the order a reader needs them: a source (browse it), every source at once
   * (global search), and the extension manager (get more sources). Extensions are a first-class
   * door rather than an advanced setting, because extension compatibility is what this app is.
   */
  import { library } from "../state/library.svelte";
  import { go, pathTo } from "../lib/nav";
  import { settings } from "../state/settings.svelte";
  import { togglePin } from "../lib/pinned";
  import { sourceMarks } from "../state/source-marks.svelte";
  import { EYE_PATHS, MARKER_PATH, PIN_WORDS } from "../lib/categories";
  import { visibleSources } from "../lib/marks";

  let { current = null }: { current?: string | null } = $props();

  let query = $state("");

  /** The pin mark with the search-scoped pins folded in: one glyph, both consequences. */
  const marks = $derived(sourceMarks.withSearchPins(settings.pinnedSources));

  const sources = $derived.by(() => {
    const needle = query.trim().toLowerCase();
    const found = library.sources.filter(
      (source) => needle === "" || `${source.name} ${source.lang ?? ""}`.toLowerCase().includes(needle),
    );
    // The eye and the pin, exactly as the category rail does them: hidden sources leave the list
    // (and, through the same rule, take their comics out of the library and history).
    const list = visibleSources(found, marks, { hiddenView: sourceMarks.hiddenView, pinView: sourceMarks.pinView });
    // Grouped by provider, then by name, so a 60-source extension is a block and not a wall.
    return [...list].sort((a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name) || (a.lang ?? "").localeCompare(b.lang ?? ""));
  });

  const byProvider = $derived(
    [...new Set(sources.map((source) => source.provider))].map((provider) => ({
      provider,
      rows: sources.filter((source) => source.provider === provider),
    })),
  );

  const installed = $derived(library.extensions.length);
  const hostDown = $derived(library.sources.length === 0 && (library.profile?.warnings.length ?? 0) > 0);
</script>

<section class="view">
  <header class="top">
    <h1>Browse</h1>
    <div class="acts">
      <button class="btn ghost" onclick={() => go("/search")}>Search all</button>
      <button class="btn" onclick={() => go("/extensions")}>Extensions{installed > 0 ? ` · ${installed}` : ""}</button>
    </div>
  </header>

  {#if hostDown}
    <p class="note warn">No extension host answered, so there is nothing to browse yet. Check the runtime, then reload.</p>
  {/if}

  {#if library.sources.length === 0}
    <div class="blank">
      <p class="blankline">No sources yet.</p>
      <p class="blanksub">Add a repository and install an extension — its sources appear here, one row each.</p>
      <div class="blankacts">
        <button class="btn primary" onclick={() => go("/extensions")}>Add a repository</button>
      </div>
    </div>
  {:else}
    <div class="band">
      <button
        class="seat"
        aria-label={`Hidden sources: ${sourceMarks.hiddenLabel}`}
        title={`Hidden sources: ${sourceMarks.hiddenLabel}`}
        onclick={() => void sourceMarks.cycleHiddenView()}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={EYE_PATHS[sourceMarks.hiddenView]} /></svg>
        <span class="word">{sourceMarks.hiddenLabel}</span>
      </button>

      <button
        class="seat"
        class:pinned={sourceMarks.pinView !== "all"}
        aria-label={`Pinned: ${sourceMarks.pinLabel}`}
        title={`Pinned: ${sourceMarks.pinLabel}`}
        onclick={() => void sourceMarks.cyclePinView()}
      >
        <svg class="pin" viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>
        <span class="word">{sourceMarks.pinLabel}</span>
      </button>
    </div>

    <input class="field search" type="search" placeholder="Find a source" bind:value={query} aria-label="Find a source" />

    {#each byProvider as group (group.provider)}
      <section class="group">
        <h2>{group.provider}<span>{group.rows.length}</span></h2>
        <div class="rows">
          {#each group.rows as source (source.id)}
            <div class="rowwrap" class:current={current === source.id}>
              <button class="row" onclick={() => go(pathTo("source", source.id))}>
                <span class="name">{source.name}</span>
                {#if source.lang}<span class="lang">{source.lang}</span>{/if}
                {#if source.nsfw}<span class="nsfw">18+</span>{/if}
              </button>
              <button
                class="eyebtn"
                class:hidden={sourceMarks.markOf(source.id).hidden}
                aria-label={`${sourceMarks.markOf(source.id).hidden ? "Show" : "Hide"} ${source.name}`}
                aria-pressed={sourceMarks.markOf(source.id).hidden}
                title={`${sourceMarks.markOf(source.id).hidden ? "Show" : "Hide"} ${source.name} — its comics leave the library and history`}
                onclick={() => void sourceMarks.toggleHidden(source.id)}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={sourceMarks.markOf(source.id).hidden ? EYE_PATHS.only : EYE_PATHS.hidden} />
                </svg>
              </button>
              <button
                class="pinbtn"
                class:pinned={marks.some((mark) => mark.id === source.id && mark.pinned)}
                aria-label={`${marks.some((mark) => mark.id === source.id && mark.pinned) ? PIN_WORDS.remove : PIN_WORDS.add} ${source.name}`}
                aria-pressed={marks.some((mark) => mark.id === source.id && mark.pinned)}
                title={`${marks.some((mark) => mark.id === source.id && mark.pinned) ? "Unpin — search stops starting here" : "Pin — floats to the top, and search starts here"}`}
                onclick={() => {
                  void sourceMarks.togglePin(source.id);
                  settings.set("pinnedSources", togglePin(settings.pinnedSources, source.id));
                }}
              >
                <svg viewBox="0 0 24 24"><path d={MARKER_PATH} /></svg>
              </button>
              <span class="chev" aria-hidden="true">›</span>
            </div>
          {/each}
        </div>
      </section>
    {/each}

    {#if sources.length === 0}
      <p class="empty">No source matches “{query}”.</p>
    {/if}
  {/if}
</section>

<style>
  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 900px;
  }

  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    margin-bottom: var(--s4);
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
  }

  .acts {
    display: flex;
    gap: var(--s2);
  }

  .search {
    width: 100%;
    min-height: 38px;
    margin-bottom: var(--s4);
  }

  .group {
    margin-bottom: var(--s4);
  }

  .group h2 {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin-bottom: var(--s1);
  }

  .group h2 span {
    font-weight: 400;
    letter-spacing: 0;
  }

  .rowwrap {
    display: flex;
    align-items: center;
    gap: var(--s1);
  }

  .rowwrap .row {
    flex: 1;
    min-width: 0;
  }

  /* The band: the eye on the left, the pin on the right — the category rail's header, on sources. */
  .band {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 4px 2px 8px;
    margin-bottom: var(--s2);
    border-bottom: 1px solid var(--line);
  }

  .seat {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 7px;
    border-radius: 6px;
    color: var(--text-3);
    font-size: 11.5px;
  }

  .seat:hover {
    background: #1c1c22;
    color: #d6d6de;
  }

  .seat svg {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
  }

  .seat .pin {
    stroke-linejoin: round;
  }

  .seat.pinned {
    color: var(--accent);
  }

  .eyebtn {
    all: unset;
    cursor: pointer;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 999px;
    color: var(--text-3);
    flex: none;
  }

  .eyebtn svg {
    width: 15px;
    height: 15px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
  }

  .eyebtn.hidden {
    color: var(--accent);
  }

  .pinbtn {
    all: unset;
    cursor: pointer;
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 999px;
    color: var(--text-3);
    flex: none;
  }

  .pinbtn svg {
    width: 14px;
    height: 14px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linejoin: round;
  }

  .pinbtn.pinned {
    color: var(--accent);
  }

  .pinbtn.pinned svg {
    fill: color-mix(in srgb, var(--accent) 30%, transparent);
  }

  .rows {
    display: grid;
  }

  .row {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s3) var(--s2);
    border-radius: var(--r1);
    min-height: 44px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--line);
  }

  .row:hover {
    background: var(--surface-2);
  }

  .row.current {
    background: var(--surface-2);
  }

  .name {
    flex: 1;
    font-size: var(--t-md);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .lang {
    font-size: var(--t-xs);
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--text-3);
  }

  .nsfw {
    font-size: var(--t-xs);
    color: var(--danger);
  }

  .chev {
    color: var(--text-3);
    font-size: var(--t-lg);
  }

  .blank {
    display: grid;
    gap: var(--s2);
    padding-top: var(--s6);
    max-width: 48ch;
  }

  .blankline {
    margin: 0;
    font-size: var(--t-lg);
  }

  .blanksub {
    margin: 0;
    font-size: var(--t-sm);
    line-height: 1.6;
    color: var(--text-2);
  }

  .blankacts {
    margin-top: var(--s2);
  }
</style>
