<script lang="ts">
  /**
   * A source's own filter form, drawn from what the source itself declares.
   *
   * Nothing here is invented: the rows, their labels, their options and their starting values all
   * come from `provider.filters(sourceId)`, and an entry this build cannot draw is not rendered —
   * but it keeps its slot, so every choice is still sent under the index the source knows.
   *
   * The sheet edits a **draft**, and only Apply writes: a sheet that saved on every tap could not be
   * cancelled, and a half-explored form would already have changed the next search.
   */
  import Sheet from "./Sheet.svelte";
  import type { SourceFilter, SourceFilterSelection, TriState } from "../api/source";
  import { cleanSelection, describeSelection, stateOf } from "../lib/source-filters";

  interface Props {
    open: boolean;
    /** The source's own name, for the title. */
    sourceName: string;
    filters: SourceFilter[];
    selection: SourceFilterSelection;
    onclose: () => void;
    onapply: (selection: SourceFilterSelection) => void;
  }
  let { open, sourceName, filters, selection, onclose, onapply }: Props = $props();

  let draft = $state<SourceFilterSelection>({});
  let loaded = $state(false);

  $effect(() => {
    if (!open) return;
    draft = $state.snapshot(selection) as SourceFilterSelection;
    loaded = true;
  });

  /** What a row currently says, as the control it is drawn with. */
  function current(position: number): ReturnType<typeof stateOf> {
    const filter = filters[position];
    return filter === undefined ? null : stateOf(filter, position, draft);
  }

  function set(position: number, state: Exclude<ReturnType<typeof stateOf>, null>): void {
    draft = { ...draft, [String(position)]: state };
  }

  const changed = $derived(cleanSelection(filters, draft));
  const summary = $derived(describeSelection(filters, changed));

  const TRI_WORDS: Array<{ value: TriState; label: string }> = [
    { value: "IGNORE", label: "Ignore" },
    { value: "INCLUDE", label: "Include" },
    { value: "EXCLUDE", label: "Exclude" },
  ];
</script>

<Sheet {open} title={`Filters · ${sourceName}`} {onclose}>
  {#if filters.length === 0}
    <p class="note">This source declares no filters.</p>
  {:else}
    <div class="form">
      {#each filters as filter, position (position)}
        {#if filter.kind === "header"}
          <p class="head">{filter.name}</p>
        {:else if filter.kind === "separator"}
          <hr />
        {:else if filter.kind === "select"}
          {@const state = current(position)}
          <label class="row">
            <span class="name">{filter.name}</span>
            <select
              value={state !== null && "selectState" in state ? String(state.selectState) : "0"}
              onchange={(event) => set(position, { selectState: Number(event.currentTarget.value) })}
            >
              {#each filter.values as value, index (index)}
                <option value={String(index)}>{value}</option>
              {/each}
            </select>
          </label>
        {:else if filter.kind === "sort"}
          {@const state = current(position)}
          <div class="row">
            <label class="name" for={`sort-${position}`}>{filter.name}</label>
            <div class="pair">
              <select
                id={`sort-${position}`}
                value={state !== null && "sortState" in state ? String(state.sortState.index) : "0"}
                onchange={(event) => {
                  const index = Number(event.currentTarget.value);
                  const ascending = state !== null && "sortState" in state ? state.sortState.ascending : true;
                  set(position, { sortState: { index, ascending } });
                }}
              >
                {#each filter.values as value, index (index)}
                  <option value={String(index)}>{value}</option>
                {/each}
              </select>
              <div class="chips" role="group" aria-label={`${filter.name} direction`}>
                {#each [{ up: true, label: "Asc" }, { up: false, label: "Desc" }] as direction (direction.label)}
                  {@const active = state !== null && "sortState" in state && state.sortState.ascending === direction.up}
                  <button
                    class="chip"
                    class:on={active}
                    aria-pressed={active}
                    onclick={() => {
                      const index = state !== null && "sortState" in state ? state.sortState.index : 0;
                      set(position, { sortState: { index, ascending: direction.up } });
                    }}
                  >{direction.label}</button>
                {/each}
              </div>
            </div>
          </div>
        {:else if filter.kind === "checkbox"}
          {@const state = current(position)}
          <label class="row check">
            <input
              type="checkbox"
              checked={state !== null && "checkBoxState" in state ? state.checkBoxState : false}
              onchange={(event) => set(position, { checkBoxState: event.currentTarget.checked })}
            />
            <span class="name">{filter.name}</span>
          </label>
        {:else if filter.kind === "text"}
          {@const state = current(position)}
          <label class="row">
            <span class="name">{filter.name}</span>
            <input
              type="text"
              value={state !== null && "textState" in state ? state.textState : ""}
              placeholder="Any"
              oninput={(event) => set(position, { textState: event.currentTarget.value })}
            />
          </label>
        {:else if filter.kind === "tristate"}
          {@const state = current(position)}
          <div class="row">
            <span class="name">{filter.name}</span>
            <div class="chips" role="group" aria-label={filter.name}>
              {#each TRI_WORDS as word (word.value)}
                {@const active = state !== null && "triState" in state && state.triState === word.value}
                <button
                  class="chip"
                  class:on={active}
                  aria-pressed={active}
                  onclick={() => set(position, { triState: word.value })}
                >{word.label}</button>
              {/each}
            </div>
          </div>
        {:else}
          <!-- A filter this build cannot draw: not shown, but its position is kept, so the filters
               after it still answer under the index the source declared them at. -->
        {/if}
      {/each}
    </div>
    {#if Object.keys(changed).length > 0}
      <p class="summary">{summary}</p>
      <button class="btn ghost clear" onclick={() => (draft = {})}>Clear all</button>
    {:else}
      <p class="summary muted">Nothing changed — this source's own defaults apply.</p>
    {/if}
    {#if loaded && filters.some((filter) => filter.kind === "unknown")}
      <p class="summary muted">This source has a filter this build cannot draw yet; it is left alone rather than guessed.</p>
    {/if}
  {/if}

  {#snippet footer()}
    <button class="btn ghost" onclick={onclose}>Cancel</button>
    <button
      class="btn primary"
      onclick={() => {
        onapply(changed);
        onclose();
      }}>Apply</button>
  {/snippet}
</Sheet>

<style>
  .form {
    display: grid;
    gap: var(--s2);
  }

  .head {
    margin: var(--s2) 0 0;
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-3);
  }

  hr {
    border: 0;
    border-top: 1px solid var(--line);
    margin: var(--s1) 0;
    width: 100%;
  }

  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    min-height: 44px;
  }

  .row.check {
    justify-content: flex-start;
    gap: var(--s2);
  }

  .name {
    font-size: var(--t-md);
    min-width: 0;
  }

  select,
  input[type="text"] {
    flex: 1;
    max-width: 60%;
    min-height: 36px;
  }

  input[type="checkbox"] {
    width: 20px;
    height: 20px;
  }

  .pair {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex: 1;
    max-width: 70%;
    justify-content: flex-end;
  }

  .pair select {
    max-width: none;
    min-width: 0;
  }

  .chips {
    display: flex;
    gap: var(--s1);
  }

  .summary {
    margin: var(--s3) 0 0;
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  .summary.muted {
    color: var(--text-3);
  }

  .clear {
    margin-top: var(--s2);
  }

  .note {
    margin: 0;
    color: var(--text-2);
  }
</style>
