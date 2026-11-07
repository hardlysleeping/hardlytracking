<script lang="ts">
  /**
   * Settings → Privacy: the screen-curtain PIN.
   *
   * A panel of its own so the section is the same component the browser fixture mounts, and so the
   * sheet it opens is the same one the Library band opens. Copy is load-bearing here: the owner
   * asked for one PIN across devices, and the honest limits (local screen privacy, hash only, not
   * encryption) belong beside the buttons, not in a release note.
   */
  import { settings } from "../state/settings.svelte";
  import { privacy } from "../state/privacy.svelte";
  import { hasPin, PIN_MAX, PIN_MIN } from "../lib/pin";
  import PinSheet from "./PinSheet.svelte";

  type Mode = "set" | "unlock" | "change" | "remove";
  let mode = $state<Exclude<Mode, "unlock"> | null>(null);
  const set = $derived(hasPin(settings.privacyPin));
</script>

<div class="row">
  <span>
    Screen lock PIN
    <em class="sub">
      {#if set}
        A PIN is set. The Lock button in the Library band asks for it before the shelves come back.
      {:else}
        No PIN yet. The Lock button will offer to set one — it will not lock without it.
      {/if}
    </em>
  </span>
  <div class="chips">
    {#if set}
      <button class="btn ghost" disabled={privacy.locked} onclick={() => (mode = "change")}>Change PIN</button>
      <button class="btn ghost" disabled={privacy.locked} onclick={() => (mode = "remove")}>Remove PIN</button>
    {:else}
      <button class="btn" onclick={() => (mode = "set")}>Set PIN</button>
    {/if}
  </div>
</div>

<p class="hint">
  The PIN is local screen privacy: it keeps hidden shelves off the screen, and {PIN_MIN}–{PIN_MAX}
  digits is the whole rule. It is stored only as a salted hash — never in plain text, never in a URL —
  and it travels with your HardlySync account, because one PIN across devices was the point. It is
  not encryption: your library is not encrypted. Changing or removing it asks for the current PIN
  (or the device owner, where a native build can ask).
</p>

{#if privacy.locked}
  <p class="hint">The screen is locked. Raise the curtain from the Library band before changing the PIN it is holding.</p>
{/if}

{#if mode !== null}
  <PinSheet open={mode !== null} {mode} onclose={() => (mode = null)} />
{/if}

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    min-height: 44px;
    font-size: var(--t-md);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .hint {
    margin: var(--s2) 0 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.6;
    max-width: 62ch;
  }

  .sub {
    display: block;
    margin-top: 2px;
    font-style: normal;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.5;
    max-width: 46ch;
  }
</style>
