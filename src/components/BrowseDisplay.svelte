<script lang="ts">
  import { settings } from "../state/settings.svelte";
  import { viewport } from "../lib/layout.svelte";
  import { browseMode, columnsFor, maxColumns } from "../lib/browse-display";

  /**
   * One display menu, expanded in place.
   *
   * It is a menu — a single control with a frame, a label and its options inside — but it never
   * drops down: the options are laid out in the menu itself, so seeing what Rows looks like costs
   * nothing and changing to it costs one click. The options are icons with their names under them,
   * because a shelf's shape is recognised by its picture, not by three words that all sound alike.
   */
  const mode = $derived(browseMode(settings.libraryView));
  const columns = $derived(columnsFor(settings.browseColumns, viewport.width, viewport.height));
  const ceiling = $derived(maxColumns(viewport.width, viewport.height));

  const LAYOUTS = [
    { id: "row" as const, label: "Rows", path: "M4 7h16M4 12h16M4 17h16" },
    { id: "grid" as const, label: "Grid", path: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" },
    { id: "card" as const, label: "Cards", path: "M6 3h12v11H6zM6 17h12M6 20h8" },
  ];

  const TITLES = [
    { id: "below" as const, label: "Below", path: "M4 4h16v10H4zM6 18h12" },
    { id: "overlay" as const, label: "On cover", path: "M4 4h16v14H4zM7 14h10" },
  ];

</script>

<div class="menu" role="group" aria-label="Display">
  <div class="seg" role="group" aria-label="Layout">
    {#each LAYOUTS as item (item.id)}
      <button
        class="opt"
        class:on={mode === item.id}
        aria-pressed={mode === item.id}
        title={`${item.label} layout`}
        onclick={() => settings.set("libraryView", item.id)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.path} /></svg>
        <span>{item.label}</span>
      </button>
    {/each}
  </div>

  {#if mode === "grid"}
    <span class="rule" aria-hidden="true"></span>
    <div class="seg" role="group" aria-label="Title placement">
      {#each TITLES as item (item.id)}
        <button
          class="opt"
          class:on={settings.browseTitle === item.id}
          aria-pressed={settings.browseTitle === item.id}
          title={`Title ${item.label.toLowerCase()}`}
          onclick={() => settings.set("browseTitle", item.id)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={item.path} /></svg>
          <span>{item.label}</span>
        </button>
      {/each}
    </div>
    <label class="columns">
      <output>{columns} across</output>
      <input aria-label="Grid columns" type="range" min="2" max={ceiling} step="1" value={columns}
        oninput={(e) => settings.set("browseColumns", Number(e.currentTarget.value))} />
    </label>
  {/if}
</div>

<style>
  /* The frame is what makes it one menu rather than a scatter of buttons in the tools row. */
  .menu {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--s2);
    min-width: 0;
    max-width: 100%;
    margin: 0 0 var(--s3);
    padding: 4px;
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: var(--surface-2);
  }

  .seg {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    min-width: 0;
  }

  .rule {
    width: 1px;
    align-self: stretch;
    min-height: 26px;
    background: var(--line);
  }

  .opt {
    display: grid;
    justify-items: center;
    gap: 1px;
    min-width: 52px;
    padding: 3px 6px;
    border: 0;
    border-radius: var(--r1);
    background: transparent;
    color: var(--text-3);
    font: inherit;
    cursor: pointer;
  }

  .opt svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .opt span { font-size: 10px; line-height: 1.2; }

  .opt:hover, .opt:focus-visible { color: var(--text-1); background: var(--surface); }

  .opt.on { color: var(--accent, var(--text-1)); background: var(--surface); box-shadow: inset 0 0 0 1px var(--accent, var(--line)); }

  .columns {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-left: auto;
    padding-right: 2px;
    min-width: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
  }
  .columns output { min-width: 5.5ch; font-variant-numeric: tabular-nums; }
  .columns input { width: 100px; min-width: 0; margin: 0; }
</style>