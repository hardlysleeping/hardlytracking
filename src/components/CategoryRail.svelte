<script lang="ts">
  /**
   * The category rail: the eye, the pin, and one row per category.
   *
   * This is HardlyReader's look, ported: the band above the list (eye on the left,
   * pin on the right), rows that wear the pin's ring and underlight when pinned,
   * a stroke-only pin glyph in the pinned tone, and the fixed words
   * Pinned / Pin / Unpin. The behaviour behind it is `lib/categories`.
   */
  import { privacy } from "../state/privacy.svelte";
  import { categories } from "../state/categories.svelte";
  import { EYE_PATHS, MARKER_PATH, PIN_WORDS, visibleCategories, viewSummary } from "../lib/categories";

  interface Props {
    selected: string | null;
    onselect: (id: string | null) => void;
  }
  let { selected, onselect }: Props = $props();

  let name = $state("");
  let creating = $state(false);

  const shown = $derived(visibleCategories(categories.items, categories.hiddenView));

  async function submit(): Promise<void> {
    const created = await categories.create(name);
    name = "";
    creating = false;
    if (created !== null) onselect(created.id);
  }
</script>

<aside class="rail">
  {#if !privacy.locked}
  <div class="band">
    <button
      class="seat eye"
      aria-label={`Hidden categories: ${categories.hiddenLabel}`}
      title={`Hidden categories: ${categories.hiddenLabel}`}
      onclick={() => categories.cycleHiddenView()}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={EYE_PATHS[categories.hiddenView]} /></svg>
      <span class="word">{categories.hiddenLabel}</span>
    </button>

    <button
      class="seat pin-seat"
      class:pinned={categories.pinView !== "all"}
      aria-label={`Pinned: ${categories.pinLabel}`}
      title={`Pinned: ${categories.pinLabel}`}
      onclick={() => categories.cyclePinView()}
    >
      <svg class="pin" viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>
      <span class="word">{categories.pinLabel}</span>
    </button>
  </div>
  {/if}

  <ul class="rows">
    {#each shown as category (category.id)}
      <li class="row" class:pinned={category.pinned} class:active={selected === category.id}>
        <button class="label" onclick={() => onselect(selected === category.id ? null : category.id)}>
          {category.name}
        </button>

        <button
          disabled={privacy.locked}
          class="eye small"
          class:hidden={category.hidden}
          aria-label={category.hidden ? `Show ${category.name}` : `Hide ${category.name}`}
          title={category.hidden ? `Show ${category.name}` : `Hide ${category.name}`}
          onclick={() => categories.setHidden(category.id, !category.hidden)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d={category.hidden ? EYE_PATHS.only : EYE_PATHS.hidden} />
          </svg>
        </button>

        <button
          disabled={privacy.locked}
          class="pin-seat small"
          class:pinned={category.pinned}
          aria-label={`${category.pinned ? PIN_WORDS.remove : PIN_WORDS.add} ${category.name}`}
          title={`${category.pinned ? PIN_WORDS.remove : PIN_WORDS.add} ${category.name}`}
          onclick={() => categories.togglePin(category.id)}
        >
          <svg class="pin" viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>
        </button>
      </li>
    {/each}
  </ul>

  {#if creating && !privacy.locked}
    <form class="new" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <input bind:value={name} placeholder="Category name" aria-label="New category name" />
      <button class="ghost" type="submit">Add</button>
    </form>
  {:else}
    <button disabled={privacy.locked} class="ghost add" onclick={() => (creating = true)}>New category</button>
  {/if}

  <p class="status">{viewSummary(categories.hiddenView, categories.pinView, categories.hiddenCount, categories.pinnedCount)}</p>
</aside>

<style>
  .rail {
    display: flex;
    flex-direction: column;
    gap: 10px;
    min-width: 190px;
  }

  /* Three seats on one line: the eye, its word, the pin and its word. */
  /* The band spans the rail: the eye takes the left seat, the pin the right, so
     the two marks read as a header for the rows rather than a legend. */
  .band {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding: 4px 2px 8px;
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
    color: var(--muted);
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
  }

  .eye svg path {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  /* The pin is a stroke, so it takes the tone without a fill of its own. */
  .pin path {
    fill: none;
    stroke: var(--tone-pinned);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .pin-seat:not(.pinned) .pin path {
    stroke: var(--muted);
  }

  .pin-seat.pinned {
    color: color-mix(in srgb, var(--tone-pinned) 70%, var(--fg));
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 2px;
  }

  .row {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 1px 2px 1px 0;
    border-radius: 5px;
  }

  .row .label {
    all: unset;
    cursor: pointer;
    flex: 1;
    min-width: 0;
    padding: 5px 7px;
    font-size: 12.5px;
    color: #c9c9d4;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .row .label:hover {
    color: #fff;
  }

  .row.active {
    background: var(--accent-soft, #23232e);
    outline: 1px solid color-mix(in srgb, var(--tone-pinned) 30%, transparent);
    outline-offset: -1px;
  }

  /* Pinned: the label takes the pinned tone, the row keeps a ring, a soft outer
     glow and an underlight along the bottom edge — three quiet cues rather than
     one loud one, exactly as in HardlyReader. */
  .row.pinned {
    outline: 1px solid color-mix(in srgb, var(--tone-pinned) 45%, transparent);
    outline-offset: -1px;
    border-radius: 5px;
    box-shadow:
      inset 0 -2px 0 color-mix(in srgb, var(--tone-pinned) 60%, transparent),
      0 0 9px color-mix(in srgb, var(--tone-pinned) 18%, transparent);
  }

  .row.pinned .label {
    color: color-mix(in srgb, var(--tone-pinned) 70%, var(--fg));
  }

  /* Both marks on one row: the pin's ring is the stronger claim, so a selected
     pinned row keeps it. */
  .row.pinned.active {
    outline-color: color-mix(in srgb, var(--tone-pinned) 45%, transparent);
  }

  .small {
    all: unset;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    padding: 4px;
    border-radius: 5px;
    color: #6f6f7c;
  }

  .small:hover {
    background: #1c1c22;
    color: #c9c9d4;
  }

  .small svg {
    width: 13px;
    height: 13px;
  }

  .eye.hidden {
    color: color-mix(in srgb, var(--tone-pinned) 60%, var(--muted));
  }

  .new {
    display: flex;
    gap: 6px;
  }

  .new input {
    flex: 1;
    min-width: 0;
    background: #16161c;
    border: 1px solid #2a2a34;
    border-radius: 7px;
    padding: 5px 8px;
    color: var(--fg);
    font: inherit;
    font-size: 12.5px;
  }

  .add {
    align-self: flex-start;
    font-size: 12px;
  }

  .status {
    margin: 2px 0 0;
    padding-top: 7px;
    border-top: 1px solid var(--line);
    font-size: 11px;
    color: var(--muted);
  }
</style>
