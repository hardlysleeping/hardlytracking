<script lang="ts">
  import { settings } from "../state/settings.svelte";
  import { viewport } from "../lib/layout.svelte";
  import { ROW_STYLES, browseMode, columnsFor, maxColumns } from "../lib/browse-display";

  /**
   * The display controls: one door for the layout, one for sideways, and the column slider.
   *
   * Three layout buttons and two title buttons used to sit side by side with the slider — five
   * controls of three different widths for one question ("how does the shelf look?"), and a fourth
   * and fifth appeared only in one mode, so the row changed shape under the thumb that had just
   * pressed something. They are one menu now: the button names the current layout, the menu holds
   * every shape and every option that applies to it.
   */
  const mode = $derived(browseMode(settings.libraryView));
  const columns = $derived(columnsFor(settings.browseColumns, viewport.width, viewport.height));
  const ceiling = $derived(maxColumns(viewport.width, viewport.height));

  /** The three layouts, one glyph each: rows, a grid of tiles, one card. */
  const MODES = [
    { id: "row" as const, label: "Rows", path: "M4 6h16M4 12h16M4 18h16" },
    { id: "grid" as const, label: "Grid", path: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" },
    { id: "card" as const, label: "Cards", path: "M5 4h14v10H5zM5 17h9M5 20h6" },
  ];

  /** Title placement, drawn as where the line sits against the cover. */
  const TITLE_PLACEMENTS = [
    { id: "below" as const, label: "Title below the cover", short: "Below", path: "M4 4h16v10H4zM6 18h12" },
    { id: "overlay" as const, label: "Title on the cover", short: "On cover", path: "M4 4h16v14H4zM7 14h10" },
  ];

  /** Sideways: the shelf runs left to right. */
  const SIDEWAYS = "M3 12h18M7 8l-4 4 4 4M17 8l4 4-4 4";

  const current = $derived(MODES.find((view) => view.id === mode) ?? MODES[1]);
  let open = $state(false);

  function choose(id: (typeof MODES)[number]["id"]): void {
    settings.set("libraryView", id);
    // The menu stays open when the choice reveals more options (row shapes, the title pair, the
    // column slider): closing it would hide the thing the tap just opened. Cards add nothing, so
    // that one is done.
    if (id === "card") open = false;
  }

  /** A press anywhere else closes it, and so does Escape. */
  function dismiss(node: HTMLElement) {
    const down = (event: PointerEvent) => {
      if (!node.contains(event.target as Node)) open = false;
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") open = false;
    };
    document.addEventListener("pointerdown", down, true);
    document.addEventListener("keydown", key);
    return {
      destroy() {
        document.removeEventListener("pointerdown", down, true);
        document.removeEventListener("keydown", key);
      },
    };
  }
</script>

<div class="display" aria-label="Browse display">
  <!-- Sideways first and bare: it is the one control here that changes the shelf rather than the
       tiles, and it is either on or off, so a word under it was a label for a state the pressed
       glyph already shows. Far left keeps it out of the way of the layout door. -->
  <button
    class="chip icon"
    class:on={settings.browseHorizontal}
    aria-pressed={settings.browseHorizontal}
    aria-label="Sideways: scroll the shelf horizontally"
    title="Sideways: scroll the shelf horizontally"
    onclick={() => settings.set("browseHorizontal", !settings.browseHorizontal)}
  >
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={SIDEWAYS} /></svg>
  </button>

  <div class="picker" use:dismiss>
    <button
      class="chip door"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Layout: ${current.label}${mode === "row" ? `, ${settings.rowStyle} rows` : mode === "grid" ? `, title ${settings.browseTitle === "overlay" ? "on the cover" : "below"}` : ""}`}
      title="Layout and display"
      onclick={() => (open = !open)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={current.path} /></svg>
      <span class="word">{current.label}</span>
      <svg class="caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </button>

    {#if open}
      <div class="menu" role="menu" aria-label="Layout">
        <p class="group">Layout</p>
        {#each MODES as view (view.id)}
          <button
            class="item"
            class:on={mode === view.id}
            role="menuitemradio"
            aria-checked={mode === view.id}
            onclick={() => choose(view.id)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={view.path} /></svg>
            <span class="label">{view.label}</span>
            <span class="tick" aria-hidden="true">{mode === view.id ? "✓" : ""}</span>
          </button>
        {/each}

        {#if mode === "row"}
          <p class="group">Row shape</p>
          {#each ROW_STYLES as style (style.id)}
            <button
              class="item tall"
              class:on={settings.rowStyle === style.id}
              role="menuitemradio"
              aria-checked={settings.rowStyle === style.id}
              onclick={() => settings.set("rowStyle", style.id)}
            >
              <span class="dot" aria-hidden="true">{settings.rowStyle === style.id ? "•" : ""}</span>
              <span class="label">
                {style.label}
                <span class="note">{style.note}</span>
              </span>
              <span class="tick" aria-hidden="true">{settings.rowStyle === style.id ? "✓" : ""}</span>
            </button>
          {/each}
        {/if}

        {#if mode === "grid"}
          <p class="group">Title</p>
          {#each TITLE_PLACEMENTS as option (option.id)}
            <button
              class="item"
              class:on={settings.browseTitle === option.id}
              role="menuitemradio"
              aria-checked={settings.browseTitle === option.id}
              onclick={() => settings.set("browseTitle", option.id)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d={option.path} /></svg>
              <span class="label">{option.short}</span>
              <span class="tick" aria-hidden="true">{settings.browseTitle === option.id ? "✓" : ""}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
  </div>

  {#if mode === "grid"}
    <label class="columns">
      <output>{columns} across</output>
      <input aria-label="Grid columns" type="range" min="1" max={ceiling} step="1" value={columns}
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
  .chip.icon {
    padding: 5px;
    width: 32px;
    height: 32px;
    justify-content: center;
  }
  .chip.icon svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  /* The door: the current layout's own glyph, its name, and a caret. It reads as a control with a
     state rather than a button that opens something unknown. */
  .picker { position: relative; min-width: 0; }
  .chip.door {
    display: flex;
    align-items: center;
    gap: var(--s1);
    height: 32px;
    padding: 0 8px;
  }
  .chip.door svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .chip.door .caret { width: 13px; height: 13px; opacity: 0.65; }
  .chip.door .word { font-size: var(--t-sm); }

  .menu {
    position: absolute;
    z-index: 30;
    top: calc(100% + 4px);
    left: 0;
    display: grid;
    gap: 1px;
    width: max-content;
    min-width: 208px;
    max-width: min(300px, calc(100vw - 48px));
    padding: 4px;
    border: 1px solid var(--line-strong);
    border-radius: var(--r2);
    background: var(--surface);
    box-shadow: 0 12px 28px rgb(0 0 0 / 42%);
  }
  .group {
    margin: 6px 6px 2px;
    color: var(--text-3);
    font-size: 10px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .item {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr) 16px;
    gap: var(--s2);
    align-items: center;
    min-height: 34px;
    padding: 4px 6px;
    border: 0;
    border-radius: calc(var(--r2) - 3px);
    background: transparent;
    color: var(--text-2);
    font: inherit;
    font-size: var(--t-sm);
    text-align: left;
    cursor: pointer;
  }
  .item:hover { background: var(--surface-2); color: var(--text-1); }
  .item.on { color: var(--text-1); }
  .item svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .item .dot { width: 17px; text-align: center; color: var(--accent); font-size: 17px; line-height: 1; }
  .item .label { min-width: 0; }
  .item .note { display: block; color: var(--text-3); font-size: var(--t-xs); line-height: 1.3; }
  .item .tick { color: var(--accent); font-size: var(--t-sm); text-align: right; }
  .item.tall { min-height: 40px; align-items: start; padding-top: 6px; }
  .item.tall .dot, .item.tall .tick { padding-top: 1px; }

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
