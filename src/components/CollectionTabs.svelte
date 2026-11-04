<script lang="ts">
  /**
   * The collection row: `All | Reading | Favorites | Manhwa | +7`.
   *
   * Five one-tap collections is the point — not a scroller you hunt through. `+N` opens the list
   * with a tick per collection, and the tick is the *tab* pin: which five stay in the row. The rail
   * pin is a different mark, in a different place, and neither moves the other.
   *
   * `Categories…` stays at the end of the row, because that is where the owner reaches for the
   * eye, the pin and renaming.
   */
  import { privacy } from "../state/privacy.svelte";
  import Sheet from "./Sheet.svelte";
  import type { Category } from "../lib/categories";
  import { MAX_TABS, isTabPinned, tabRow } from "../lib/library/collections";
  import { categories as categoriesState } from "../state/categories.svelte";

  interface Props {
    /** Every collection, in the user's order. */
    categories: Category[];
    /** The ones the eye shows; a hidden collection is never a tab. */
    visible: Category[];
    selected: string | null;
    onselect: (id: string | null) => void;
    onedit: () => void;
  }
  let { categories, visible, selected, onselect, onedit }: Props = $props();

  const safeVisible = $derived(visible.filter((c) => !privacy.locked || !c.hidden));
  const row = $derived(tabRow(categories.filter((c) => !privacy.locked || !c.hidden), safeVisible));

  /** The sheet lists collections in the user's own order — the rail's pin does not reorder it. */
  const listed = $derived([...safeVisible].sort((a, b) => a.order - b.order));

  /** A collection picked from `+N` still has to read as current, even if it is not in the row. */
  const current = $derived(selected === null ? null : safeVisible.find((category) => category.id === selected) ?? null);

  let sheetOpen = $state(false);
</script>

<div class="chips" role="tablist" aria-label="Categories">
  <button class="chip" class:on={selected === null} role="tab" aria-selected={selected === null} onclick={() => onselect(null)}>
    All
  </button>
  {#each row.tabs as category (category.id)}
    <button
      class="chip"
      class:on={selected === category.id}
      class:pinned={category.pinned}
      role="tab"
      aria-selected={selected === category.id}
      onclick={() => onselect(category.id)}
    >
      {category.name}
    </button>
  {/each}
  {#if current !== null && !row.tabs.some((category) => category.id === current.id)}
    <button class="chip on" class:pinned={current.pinned} role="tab" aria-selected="true" onclick={() => onselect(current.id)}>
      {current.name}
    </button>
  {/if}
  {#if row.overflow.length > 0}
    <button class="chip" aria-label={`${row.overflow.length} more collections`} onclick={() => (sheetOpen = true)}>
      +{row.overflow.length}
    </button>
  {/if}
  <button class="chip" onclick={onedit}>Categories…</button>
</div>

<Sheet open={sheetOpen} title="Collections" onclose={() => (sheetOpen = false)}>
  <p class="muted">Tick up to {MAX_TABS} to keep them in the row.</p>
  <div class="list">
    {#each listed as category (category.id)}
      <button
        class="row"
        class:on={selected === category.id}
        onclick={() => {
          onselect(category.id);
          sheetOpen = false;
        }}
      >
        <span class="name">{category.name}</span>
        <span
          class="tick"
          role="checkbox"
          aria-checked={isTabPinned(category)}
          aria-label={`Keep ${category.name} in the row`}
          tabindex="0"
          onclick={(event) => {
            // The tick pins; the row itself selects. Two jobs, one row, no hidden gesture.
            event.stopPropagation();
            void categoriesState.toggleTabPin(category.id);
          }}
          onkeydown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            event.stopPropagation();
            void categoriesState.toggleTabPin(category.id);
          }}
        >
          {isTabPinned(category) ? "✓" : ""}
        </span>
      </button>
    {/each}
  </div>
  <button
    class="menu-item"
    onclick={() => {
      sheetOpen = false;
      onedit();
    }}
  >
    <span>Edit collections…</span>
  </button>
</Sheet>

<style>
  .chips {
    display: flex;
    gap: var(--s2);
    overflow-x: auto;
    padding-bottom: var(--s1);
    margin-bottom: var(--s3);
    scrollbar-width: none;
  }

  .chips::-webkit-scrollbar {
    display: none;
  }

  .chip {
    flex: none;
  }

  .chip.pinned {
    border-color: color-mix(in srgb, var(--tone-pinned) 55%, var(--line));
    color: var(--text-1);
  }

  .list {
    display: grid;
    gap: 2px;
  }

  .row {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding: var(--s2) var(--s3);
    border-radius: var(--r2);
    min-height: 44px;
    box-sizing: border-box;
    font-size: var(--t-md);
  }

  .row:hover,
  .row.on {
    background: var(--surface-2);
  }

  .tick {
    width: 28px;
    height: 28px;
    display: grid;
    place-items: center;
    border: 1px solid var(--line);
    border-radius: var(--r1);
    color: var(--accent);
  }

  .tick:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
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

  .menu-item:hover {
    background: var(--surface-2);
  }
</style>
