<script lang="ts">
  /**
   * Sort: ten keys, and an explicit direction.
   *
   * The direction is a pair of buttons rather than a second menu, because "Unread chapters,
   * descending" is one decision and should be one glance. Applying writes only the current
   * collection's spec — the whole point of per-collection memory is that changing All does not
   * change Reading.
   */
  import Sheet from "./Sheet.svelte";
  import { SORT_OPTIONS, type SortSpec } from "../lib/library/sort";

  interface Props {
    open: boolean;
    spec: SortSpec;
    /** The collection the spec belongs to, for the sheet's title. */
    collection: string;
    onclose: () => void;
    onapply: (spec: SortSpec) => void;
  }
  let { open, spec, collection, onclose, onapply }: Props = $props();

  let draft = $state<SortSpec>({ key: "title", dir: "asc" });

  $effect(() => {
    if (open) draft = { ...spec };
  });

  function choose(key: SortSpec["key"]): void {
    // Tapping the key that is already chosen flips the direction: one control, no hunting.
    const next: SortSpec = draft.key === key ? { key, dir: draft.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" };
    draft = next;
    onapply(next);
    onclose();
  }
</script>

<Sheet {open} title={`Sort ${collection}`} {onclose}>
  <div class="dirs" role="group" aria-label="Direction">
    <button class="chip" class:on={draft.dir === "asc"} aria-pressed={draft.dir === "asc"} onclick={() => (draft = { ...draft, dir: "asc" })}>
      Ascending
    </button>
    <button class="chip" class:on={draft.dir === "desc"} aria-pressed={draft.dir === "desc"} onclick={() => (draft = { ...draft, dir: "desc" })}>
      Descending
    </button>
  </div>

  <div class="menu-list">
    {#each SORT_OPTIONS as option (option.key)}
      <button class="menu-item" class:on={draft.key === option.key} onclick={() => choose(option.key)}>
        <span>{option.label}</span>
        {#if draft.key === option.key}
          <span class="mark" aria-hidden="true">{draft.dir === "asc" ? "↑" : "↓"}</span>
        {/if}
      </button>
    {/each}
  </div>

  {#snippet footer()}
    <button class="btn ghost" onclick={() => (draft = { key: "title", dir: "asc" })}>Reset</button>
    <button
      class="btn primary"
      onclick={() => {
        onapply(draft);
        onclose();
      }}
    >Apply</button>
  {/snippet}
</Sheet>

<style>
  .dirs {
    display: flex;
    gap: var(--s2);
  }

  .menu-list {
    display: grid;
    gap: 2px;
  }

  .menu-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding: var(--s3);
    border-radius: var(--r2);
    min-height: 44px;
    box-sizing: border-box;
    font-size: var(--t-md);
  }

  .menu-item:hover,
  .menu-item.on {
    background: var(--surface-2);
  }

  .mark {
    color: var(--accent);
  }
</style>
