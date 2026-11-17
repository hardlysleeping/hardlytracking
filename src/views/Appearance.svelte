<script lang="ts">
  /**
   * Appearance: the theme, on its own page.
   *
   * It used to be printed twice — once under More and again inside Settings — so the same swatches
   * sat behind two different doors. One door, named the same thing everywhere: More → Appearance.
   */
  import ThemePanel from "../components/ThemePanel.svelte";
  import { go } from "../lib/nav";
</script>

<section class="view">
  <div class="pin">
    <header class="bar">
      <button class="btn ghost icon" aria-label="Back" onclick={() => go("/settings")}>
        <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      <h1>Appearance</h1>
    </header>
  </div>
  <ThemePanel />
</section>

<style>
  .view {
    padding: var(--s3) var(--s4) var(--s7);
    max-width: 760px;
    --pad-x: var(--s4);
    --pad-y: var(--s3);
  }
  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding-bottom: var(--s3);
  }
  h1 {
    font-size: var(--t-xl);
    font-weight: 650;
  }
</style>
