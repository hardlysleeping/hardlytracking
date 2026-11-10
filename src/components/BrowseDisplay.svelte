<script lang="ts">
  import { settings } from "../state/settings.svelte";
  import { viewport } from "../lib/layout.svelte";
  import { browseMode, columnsFor, maxColumns } from "../lib/browse-display";
  const mode = $derived(browseMode(settings.libraryView));
  const columns = $derived(columnsFor(settings.browseColumns, viewport.width, viewport.height));
  const ceiling = $derived(maxColumns(viewport.width, viewport.height));
</script>

<!-- Every control here is a chip in the same row grammar as the layout buttons. A <select> and a
     checkbox drew two unrelated boxes beside those chips and read as three different kinds of
     control for one setting; a chip that stays pressed says the same thing and looks like its
     neighbours. The helper sentence went with them — the slider and its "N across" output are the
     explanation. Nothing is behind a menu: the three layouts are always visible side by side, and
     the options that belong to the chosen one sit beside them. -->
<div class="display" aria-label="Browse display">
  <div class="modes" role="group" aria-label="Layout">
    {#each ["row", "grid", "card"] as view}
      <button class="chip" class:on={mode === view} aria-pressed={mode === view}
        onclick={() => settings.set("libraryView", view as "row" | "grid" | "card")}>{view === "row" ? "Row" : view === "grid" ? "Grid" : "Card"}</button>
    {/each}
    {#if mode === "grid"}
      <!--
        Where the title goes is the one grid choice that changes how much book a phone shows: under
        the cover is readable, on it is compact, and the reader picks per shelf rather than having
        one opinion imposed on every screen.
      -->
      {#each [["below", "Title below"], ["overlay", "Title on cover"]] as pair}
        <button class="chip" class:on={settings.browseTitle === pair[0]} aria-pressed={settings.browseTitle === pair[0]}
          onclick={() => settings.set("browseTitle", pair[0] as "below" | "overlay")}>{pair[1]}</button>
      {/each}
      {#each [["compact", "Compact"], ["large", "Larger"]] as pair}
        <button class="chip" class:on={settings.libraryDensity === pair[0]} aria-pressed={settings.libraryDensity === pair[0]}
          onclick={() => settings.set("libraryDensity", pair[0] as "compact" | "large")}>{pair[1]}</button>
      {/each}
    {/if}
  </div>
  {#if mode === "grid"}
    <label class="columns">
      <output>{columns} across</output>
      <input aria-label="Grid columns" type="range" min="2" max={ceiling} step="1" value={columns}
        oninput={(e) => settings.set("browseColumns", Number(e.currentTarget.value))} />
    </label>
  {/if}
</div>

<style>
  .display {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2);
    min-width: 0;
    max-width: 100%;
    margin: 0 0 var(--s3);
  }
  .modes { display: flex; flex-wrap: wrap; gap: var(--s1); min-width: 0; }
  .columns {
    display: flex;
    align-items: center;
    gap: var(--s2);
    min-width: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
  }
  .columns output { min-width: 5.5ch; font-variant-numeric: tabular-nums; }
  .columns input { width: 116px; min-width: 0; margin: 0; }
</style>