<script lang="ts">
  /**
   * The PIN fixture: the two places the sheet opens — the Library band's Lock/Unlock seats and the
   * Privacy section Settings renders — over a memory database and a synthetic code.
   */
  import LibraryBand from "../../src/components/LibraryBand.svelte";
  import PrivacyPanel from "../../src/components/PrivacyPanel.svelte";
  import { privacy } from "../../src/state/privacy.svelte";
  import { settings } from "../../src/state/settings.svelte";
  import { hasPin } from "../../src/lib/pin";

  const pinned = $derived(hasPin(settings.privacyPin));
</script>

<div class="band"><LibraryBand /></div>

<section aria-label="Privacy settings">
  <PrivacyPanel />
</section>

<p class="state" role="status">locked: {privacy.locked ? "yes" : "no"}; pin: {pinned ? "set" : "none"}</p>

<style>
  :global(body) {
    margin: 0;
    padding: var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l);
    box-sizing: border-box;
    min-height: 100dvh;
    overflow: auto;
  }
  .band,
  section,
  .state {
    max-width: 560px;
    margin: 0 auto;
    padding: 0 var(--s4);
  }
  .band { padding-top: var(--s4); }
  .state { color: var(--text-3); font-size: var(--t-sm); }
</style>
