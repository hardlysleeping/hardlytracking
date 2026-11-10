<script lang="ts">
  import { categories } from "../state/categories.svelte";
  import { privacy } from "../state/privacy.svelte";
  import { EYE_PATHS, LOCK_PATHS, PIN_PATHS } from "../lib/categories";
  import PinSheet from "./PinSheet.svelte";

  /**
   * The Lock seat asks for a PIN, always.
   *
   * With no PIN stored the seat opens the Set a PIN sheet instead of lowering a curtain nobody
   * could raise; once a PIN exists the same seat locks immediately and the Unlock seat opens the
   * keypad. Wrong digits keep the curtain up — the sheet is a verification, not a formality.
   */
  let sheet = $state<"set" | "unlock" | null>(null);

  function lock(): void {
    if (privacy.lock() === "needs-pin") sheet = "set";
  }
</script>

<!--
  The band is the reader's shape, not a toolbar: a full-width caret tab above, then the eye and the
  lock. Two rules come from that shape and they are the whole of this file:

  * The caret is always here, collapsed, locked or neither. It is the way the band is folded, so
    it is the one thing the fold cannot take away.
  * Folding takes the seats with it — they are what the fold is for.

  The pin is a seat here, where the rest of the shelves' controls are — it is part of the band's row,
  not a second toolbar above it. It leaves only when the curtain is down: with the privacy screen up
  the band carries nothing but the way back, so the pin moves to the top bar rather than sitting
  beside a control that no longer means the same thing.
-->
<div class="bandbox" class:collapsed={privacy.bandCollapsed}>
  <button
    class="tab"
    onclick={() => privacy.toggleBand()}
    aria-expanded={!privacy.bandCollapsed}
    aria-label={privacy.bandCollapsed ? "Show visibility controls" : "Hide visibility controls"}
    title={privacy.bandCollapsed ? "Show" : "Hide"}
  >
    <span class="grip">
      <svg class="caret" class:up={!privacy.bandCollapsed} viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
    </span>
  </button>

  {#if !privacy.bandCollapsed}
    {#if privacy.locked}
      <div class="row compact pinless">
        <button class="seat lock on" aria-pressed="true" aria-label="Unlock local privacy screen" title="Local screen privacy only — enter your PIN" onclick={() => (sheet = "unlock")}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={LOCK_PATHS.closed} /></svg>
          <span class="lbl">Unlock</span>
        </button>
      </div>
      <p class="hint" role="status">Hidden shelves tucked away. Enter your PIN to bring them back — local screen privacy, not encryption.</p>
    {:else}
      <div class="row">
        <button
          class="seat eye"
          class:off={categories.hiddenView === "hidden"}
          class:loud={categories.hiddenView === "only"}
          aria-label={`Hidden categories: ${categories.hiddenLabel}`}
          title="Which shelves are hidden"
          onclick={() => void categories.cycleHiddenView()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={EYE_PATHS[categories.hiddenView]} /></svg>
          <span class="lbl">{categories.hiddenLabel}</span>
        </button>
        <button class="seat lock" aria-pressed="false" aria-label="Lock local privacy screen" title={privacy.pinSet ? "Lock the screen — asks for your PIN to come back" : "Set a PIN first — a lock with no PIN cannot be opened"} onclick={lock}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={LOCK_PATHS.open} /></svg>
          <span class="lbl">Lock</span>
        </button>
        <button
          class="seat pin"
          class:off={categories.pinView === "without"}
          class:loud={categories.pinView === "only"}
          aria-label={`Pinned: ${categories.pinLabel}`}
          aria-pressed={categories.pinView !== "all"}
          title={`Picked shelves, not their contents — ${categories.pinLabel}`}
          onclick={() => void categories.cyclePinView()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={PIN_PATHS[categories.pinView]} /></svg>
          <span class="lbl">{categories.pinLabel}</span>
        </button>
      </div>
    {/if}
  {/if}
</div>

{#if sheet !== null}
  <PinSheet
    open={sheet !== null}
    mode={sheet}
    onclose={() => (sheet = null)}
    ondone={() => {
      if (sheet === "set") privacy.lock();
    }}
  />
{/if}

<style>
  .bandbox { display: grid; gap: 2px; margin-bottom: var(--s2); }

  /* The tab is the band's handle, so it is the band's width — a caret in the corner read as a
     dropdown belonging to the row underneath rather than the control for it. The width stays; the
     ink does not: the caret is a muted 12 px chevron on a bare strip, and only a folded band gives
     the thumb a small grip to aim at (a folded band is nothing but this handle, an open one has the
     seats right under it). A quiet control above loud ones is the point — it folds, it is not a
     fourth seat. */
  .tab {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 20px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }
  .grip {
    display: grid;
    place-items: center;
    width: 30px;
    height: 18px;
    border-radius: var(--r-pill);
    transition: background 120ms ease;
  }
  .bandbox.collapsed .tab { min-height: 26px; color: var(--text-2); }
  /* Folded, the band is nothing but this handle, so it gets the faintest pill to tell the thumb
     where to land — a soft fill, no ring. A bordered pill read as a button from another design
     sitting alone above the shelf. */
  .bandbox.collapsed .grip { background: color-mix(in srgb, var(--surface-2) 55%, transparent); }
  .tab:hover, .tab:focus-visible { color: var(--text-1); }
  .tab:hover .grip { background: color-mix(in srgb, var(--text-1) 7%, transparent); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .caret { width: 12px; height: 12px; opacity: 0.7; transition: transform 140ms ease, opacity 120ms ease; }
  .tab:hover .caret, .tab:focus-visible .caret { opacity: 1; }
  .caret.up { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .caret, .grip { transition: none; } }

  /* Eye, lock, pin: the lock keeps the middle so the two labelled seats give up their ends evenly.
     One frame around all three, in the accent — the seats colour their glyphs, the band colours the
     box they live in, so the row reads as a control group rather than three loose buttons. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: 2px;
    padding: 2px;
    border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
    border-radius: var(--r2);
    background: color-mix(in srgb, var(--surface) 60%, transparent);
    -webkit-backdrop-filter: blur(12px) saturate(1.2);
    backdrop-filter: blur(12px) saturate(1.2);
  }
  .row.compact { border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
  /* With the curtain down there is one seat, and a one-seat grid puts it in the left column. Centre
     it in the width of the band instead, so Unlock sits under the caret rather than off to one side. */
  .row.compact.pinless { grid-template-columns: minmax(0, 1fr); justify-items: center; }

  /* The seat itself is bare: the frame above is the band's, and a tinted box inside a tinted box
     made three buttons fight the group they belong to. The tone lives in the glyph and the label. */
  .seat {
    --tone: var(--text-2);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1px;
    min-width: 0;
    min-height: 40px;
    padding: 3px 6px;
    border: 0;
    border-radius: calc(var(--r2) - 2px);
    background: transparent;
    color: var(--tone);
    font: inherit;
    cursor: pointer;
  }
  .seat.eye { --tone: var(--tone-hidden); }
  .seat.lock { --tone: var(--tone-lock-open); min-width: 64px; }
  .seat.pin { --tone: var(--tone-pinned); }
  .seat.lock.on { --tone: var(--tone-lock-closed); }
  /* Put away: the glyph is crossed out and the seat stops claiming a colour. */
  .seat.off { --tone: var(--text-3); }
  /* Narrowed to this one thing: the icon keeps its tone, the word under it goes plain white. */
  .seat.loud .lbl { color: var(--text-1); font-weight: 600; opacity: 1; }
  .seat:hover { background: color-mix(in srgb, var(--tone) 16%, transparent); }
  .seat:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .seat:active { background: color-mix(in srgb, var(--tone) 26%, transparent); }

  /* Tiny caps words: enough to name the seat, never enough to outshout the list. */
  .lbl {
    max-width: 100%;
    overflow: hidden;
    font-size: 9px;
    line-height: 1;
    letter-spacing: 0.05em;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
    opacity: 0.9;
  }
  @media (pointer: coarse) {
    .seat { min-height: 44px; }
  }

  svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
  .hint { margin: 2px 0 var(--s3); color: var(--text-2); font-size: var(--t-sm); }
</style>
