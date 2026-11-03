<script lang="ts">
  import { settings } from "../state/settings.svelte";
  import { viewport } from "../lib/layout.svelte";
  import { browseMode, columnsFor, maxColumns } from "../lib/browse-display";
  const mode = $derived(browseMode(settings.libraryView));
  const columns = $derived(columnsFor(settings.browseColumns, viewport.width));
</script>
<div class="display" aria-label="Browse display">
  <div class="modes" role="group" aria-label="Layout">
    {#each ["row", "grid", "card"] as view}
      <button class="chip" class:on={mode === view} aria-pressed={mode === view}
        onclick={() => settings.set("libraryView", view as "row" | "grid" | "card")}>{view === "row" ? "Row" : view === "grid" ? "Grid" : "Card"}</button>
    {/each}
  </div>
  {#if mode === "grid"}
    <label>Density <select aria-label="Grid density" value={settings.browseDensity}
      onchange={(e) => settings.set("browseDensity", e.currentTarget.value as "compact" | "larger")}>
      <option value="compact">Compact</option><option value="larger">Larger</option>
    </select></label>
    <label class="columns">Columns <output>{columns}×{columns}</output>
      <input aria-label="Grid columns" type="range" min="2" max={maxColumns(viewport.width)} step="1" value={columns}
        oninput={(e) => settings.set("browseColumns", Number(e.currentTarget.value))} />
    </label>
    <small>Columns, not a result limit</small>
  {/if}
  <label><input type="checkbox" checked={settings.browseHorizontal}
    onchange={(e) => settings.set("browseHorizontal", e.currentTarget.checked)} /> Horizontal browsing</label>
</div>
<style>
  .display { display:flex; flex-wrap:wrap; align-items:center; gap:10px; min-width:0; max-width:100%; margin:0 0 var(--s3); }
  .modes { display:flex; flex-wrap:wrap; gap:4px; }
  label { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:var(--t-sm); min-width:0; }
  select { max-width:100%; color:var(--text-1); background:var(--surface); border:1px solid var(--line); padding:6px; border-radius:var(--r1); }
  .columns input { width:110px; min-width:0; }
  small { color:var(--text-3); font-size:var(--t-xs); }
</style>
