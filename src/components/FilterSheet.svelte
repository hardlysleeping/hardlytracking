<script lang="ts">
  /**
   * The filter sheet: §17's questions, as data.
   *
   * Unread is a radio group, not a checkbox, because "has unread" and "fully read" are two
   * different questions and a checkbox can only ask one. The statuses and sources offered are the
   * ones the library actually contains — a filter that can select nothing is a trap.
   *
   * Everything is a draft until Apply, except Clear, which resets and applies at once: a Clear
   * that left the grid narrowed would be a lie.
   */
  import Sheet from "./Sheet.svelte";
  import { EMPTY_FILTER, type LibraryFilter } from "../lib/library/filter";

  interface Props {
    open: boolean;
    filter: LibraryFilter;
    /** Statuses present in the library, in the order they should be offered. */
    statuses: string[];
    /** Providers present in the library: the id the filter matches and the name it shows. */
    sources: Array<{ id: string; label: string }>;
    onclose: () => void;
    onapply: (filter: LibraryFilter) => void;
  }
  let { open, filter, statuses, sources, onclose, onapply }: Props = $props();

  let draft = $state<LibraryFilter>({ ...EMPTY_FILTER });

  // Opening copies the applied filter in; the sheet never edits the live one.
  $effect(() => {
    if (open) draft = { ...filter, statuses: [...filter.statuses], sources: [...filter.sources] };
  });

  function toggle(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((row) => row !== value) : [...list, value];
  }

  function clear(): void {
    draft = { ...EMPTY_FILTER, statuses: [], sources: [] };
    onapply({ ...EMPTY_FILTER, statuses: [], sources: [] });
    onclose();
  }

  function apply(): void {
    onapply({ ...draft, statuses: [...draft.statuses], sources: [...draft.sources] });
    onclose();
  }
</script>

<Sheet {open} title="Filter" {onclose}>
  <div class="group" role="radiogroup" aria-label="Reading state">
    {#each [
      { id: "any", label: "Any" },
      { id: "unread", label: "Has unread" },
      { id: "read", label: "Fully read" },
    ] as option (option.id)}
      <label class="row">
        <span>{option.label}</span>
        <input
          type="radio"
          name="unread"
          checked={draft.unread === option.id}
          onchange={() => (draft = { ...draft, unread: option.id as LibraryFilter["unread"] })}
        />
      </label>
    {/each}
  </div>

  <div class="group">
    <h3>Downloads</h3>
    <label class="row">
      <span>Downloaded</span>
      <input
        type="checkbox"
        checked={draft.downloaded}
        onchange={(event) => (draft = { ...draft, downloaded: event.currentTarget.checked })}
      />
    </label>
    <label class="row">
      <span>Not downloaded</span>
      <input
        type="checkbox"
        checked={draft.notDownloaded}
        onchange={(event) => (draft = { ...draft, notDownloaded: event.currentTarget.checked })}
      />
    </label>
  </div>

  <div class="group" role="radiogroup" aria-label="Tracking">
    <h3>Tracking</h3>
    {#each [
      { id: "any", label: "Any" },
      { id: "tracked", label: "Tracked" },
      { id: "untracked", label: "Not tracked" },
    ] as option (option.id)}
      <label class="row">
        <span>{option.label}</span>
        <input
          type="radio"
          name="tracked"
          checked={draft.tracked === option.id}
          onchange={() => (draft = { ...draft, tracked: option.id as LibraryFilter["tracked"] })}
        />
      </label>
    {/each}
  </div>

  {#if statuses.length > 0}
    <div class="group">
      <h3>Status</h3>
      {#each statuses as status (status)}
        <label class="row">
          <span>{status}</span>
          <input
            type="checkbox"
            checked={draft.statuses.includes(status)}
            onchange={() => (draft = { ...draft, statuses: toggle(draft.statuses, status) })}
          />
        </label>
      {/each}
    </div>
  {/if}

  {#if sources.length > 0}
    <div class="group">
      <h3>Source</h3>
      {#each sources as source (source.id)}
        <label class="row">
          <span>{source.label}</span>
          <input
            type="checkbox"
            checked={draft.sources.includes(source.id)}
            onchange={() => (draft = { ...draft, sources: toggle(draft.sources, source.id) })}
          />
        </label>
      {/each}
    </div>
  {/if}

  {#snippet footer()}
    <button class="btn ghost" onclick={clear}>Clear</button>
    <button class="btn primary" onclick={apply}>Apply</button>
  {/snippet}
</Sheet>

<style>
  .group {
    display: grid;
    gap: var(--s2);
  }

  h3 {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    font-size: var(--t-md);
    min-height: 36px;
  }

  input {
    width: 20px;
    height: 20px;
    accent-color: var(--accent);
  }
</style>
