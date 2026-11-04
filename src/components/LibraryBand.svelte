<script lang="ts">
  import { categories } from "../state/categories.svelte";
  import { privacy } from "../state/privacy.svelte";
  import { EYE_PATHS, MARKER_PATH } from "../lib/categories";
</script>

<div class="band" aria-label="Library visibility">
  <button class="fold" disabled={privacy.locked} aria-label={privacy.bandCollapsed ? "Expand visibility controls" : "Fold visibility controls"} aria-expanded={!privacy.bandCollapsed} onclick={() => privacy.toggleBand()}>{privacy.bandCollapsed ? "▸" : "▾"}</button>
  {#if !privacy.bandCollapsed && !privacy.locked}
    <button class="eye" aria-label={`Hidden categories: ${categories.hiddenLabel}`} onclick={() => void categories.cycleHiddenView()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={EYE_PATHS[categories.hiddenView]} /></svg>
      {categories.hiddenLabel}
    </button>
    <button class="pin" aria-label={`Pinned: ${categories.pinLabel}`} onclick={() => void categories.cyclePinView()}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d={MARKER_PATH} /></svg>
      {categories.pinLabel}
    </button>
  {/if}
  <button class="lock" aria-pressed={privacy.locked} aria-label={privacy.locked ? "Unlock local privacy screen" : "Lock local privacy screen"} title="Local screen privacy only — no passcode, authentication or encryption" onclick={() => privacy.locked ? privacy.unlock() : privacy.lock()}>
    <svg viewBox="0 0 24 24" aria-hidden="true"><path d={privacy.locked ? "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5z" : "M7 10V7a5 5 0 0 1 10 0M5 10h14v11H5z"} /></svg>
    {privacy.locked ? "Unlock" : "Lock"}
  </button>
</div>
{#if privacy.locked}<p class="hint" role="status">Hidden shelves tucked away. Local screen privacy only; anyone can unlock. No authentication or encryption.</p>{/if}

<style>
  .band { display:flex; align-items:center; gap:4px; margin-bottom:var(--s3); border-bottom:1px solid var(--line); padding-bottom:4px; }
  button { display:flex; align-items:center; justify-content:center; gap:6px; min-height:44px; min-width:44px; padding:6px 10px; border:0; border-radius:var(--r2); background:transparent; color:var(--text-2); cursor:pointer; }
  button:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
  button:disabled { cursor:default; opacity:.5; }
  .eye { color:var(--tone-hidden); }
  .lock { color:var(--tone-lock-open); }
  .lock[aria-pressed="true"] { color:var(--tone-lock-closed); }
  .pin { color:var(--tone-pinned); }
  .lock { margin-left:auto; }
  svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; stroke-linejoin:round; }
  .hint { color:var(--text-2); font-size:var(--t-sm); margin-bottom:var(--s3); }
</style>
