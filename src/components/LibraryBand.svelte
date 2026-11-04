<script lang="ts">
  import { categories } from "../state/categories.svelte";
  import { privacy } from "../state/privacy.svelte";
  import { EYE_PATHS, MARKER_PATH } from "../lib/categories";
</script>

<!--
  The band is the reader's shape, not a toolbar: a full-width caret tab above, then one row of
  seats — eye, lock, pin. Three rules come from that shape and they are the whole of this file:

  * The caret is always here, collapsed, locked or neither. It is the way the band is folded, so
    it is the one thing the fold cannot take away.
  * Folding takes the lock with it. Leaving a lock floating on its own under a folded band made
    the fold look broken — half the row went away and half stayed.
  * Locking folds the band, and folding nothing else: the pin keeps a strip of its own. A pin is
    *which* shelves are shown, not what is on them, so it stays under the thumb while the curtain
    is down. Locking also never hides the pin's button — the earlier build dropped the whole row,
    pin included, and the button the reader had just pressed vanished.
-->
<div class="bandbox" class:collapsed={privacy.bandCollapsed}>
  <button
    class="tab"
    onclick={() => privacy.toggleBand()}
    aria-expanded={!privacy.bandCollapsed}
    aria-label={privacy.bandCollapsed ? "Show visibility controls" : "Hide visibility controls"}
    title={privacy.bandCollapsed ? "Show" : "Hide"}
  >
    <svg class="caret" class:up={!privacy.bandCollapsed} viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6" /></svg>
  </button>

  {#if !privacy.bandCollapsed}
    {#if privacy.locked}
      <div class="row compact">
        <button class="seat lock on" aria-pressed="true" aria-label="Unlock local privacy screen" title="Local screen privacy only — no passcode, authentication or encryption" onclick={() => privacy.unlock()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z" /></svg>
          <span class="lbl">Unlock</span>
        </button>
        <button class="seat pin" aria-label={`Pinned: ${categories.pinLabel}`} title="Picked shelves, not their contents" onclick={() => void categories.cyclePinView()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>
          <span class="lbl">{categories.pinLabel}</span>
        </button>
      </div>
      <p class="hint" role="status">Hidden shelves tucked away. Local screen privacy only; anyone can unlock. No authentication or encryption.</p>
    {:else}
      <div class="row">
        <button class="seat eye" aria-label={`Hidden categories: ${categories.hiddenLabel}`} title="Which shelves are hidden" onclick={() => void categories.cycleHiddenView()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={EYE_PATHS[categories.hiddenView]} /></svg>
          <span class="lbl">{categories.hiddenLabel}</span>
        </button>
        <button class="seat lock" aria-pressed="false" aria-label="Lock local privacy screen" title="Local screen privacy only — no passcode, authentication or encryption" onclick={() => privacy.lock()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10V7a5 5 0 0 1 10 0M5 10h14v11H5z" /></svg>
          <span class="lbl">Lock</span>
        </button>
        <button class="seat pin" aria-label={`Pinned: ${categories.pinLabel}`} title="Picked shelves, not their contents" onclick={() => void categories.cyclePinView()}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>
          <span class="lbl">{categories.pinLabel}</span>
        </button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .bandbox { display: grid; gap: 2px; margin-bottom: var(--s3); }

  /* The tab is the band's handle, so it is the band's width — a caret in the corner read as a
     dropdown belonging to the row underneath rather than the control for it. 18px tall: a strip
     you can hit with a thumb without giving up a row of the list. */
  .tab {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    min-height: 18px;
    padding: 0;
    border: 0;
    border-radius: var(--r2);
    background: transparent;
    color: var(--text-3);
    cursor: pointer;
  }
  .bandbox.collapsed .tab { min-height: 22px; color: var(--text-2); }
  .tab:hover, .tab:focus-visible { color: var(--text-1); background: var(--hover, color-mix(in srgb, var(--text-1) 8%, transparent)); }
  .tab:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  .caret { width: 14px; height: 14px; transition: transform 140ms ease; }
  .caret.up { transform: rotate(180deg); }
  @media (prefers-reduced-motion: reduce) { .caret { transition: none; } }

  /* Eye, lock, pin: the lock keeps the middle so the two labelled seats give up their ends evenly. */
  .row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: 2px;
    padding: 2px;
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: color-mix(in srgb, var(--surface) 60%, transparent);
    -webkit-backdrop-filter: blur(12px) saturate(1.2);
    backdrop-filter: blur(12px) saturate(1.2);
  }
  .row.compact { border-color: color-mix(in srgb, var(--line) 60%, transparent); }

  .seat {
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
    color: var(--text-2);
    font: inherit;
    cursor: pointer;
  }
  .seat.eye { color: var(--tone-hidden); }
  .seat.lock { --tone: var(--tone-lock-open); color: var(--tone); min-width: 64px; }
  .seat.lock.on { --tone: var(--tone-lock-closed); }
  .seat.pin { --tone: var(--tone-pinned); color: var(--tone); }
  .seat:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
  .seat:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .seat:active { background: color-mix(in srgb, currentColor 24%, transparent); }

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
