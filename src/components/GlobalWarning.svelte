<script lang="ts">
  /**
   * One notice, floating over the top of the screen.
   *
   * It is an overlay on purpose: as a bar in the layout it pushed the header and the page down, which
   * moved the controls under the reader's thumb every time the app had something to say. Overlaying
   * leaves the layout where it was, and the notice leaves on its own (see `state/notices`).
   */
  let { message, ondismiss, sticky = false }: { message: string; ondismiss?: () => void; sticky?: boolean } = $props();
</script>

<div class="global-warning" class:sticky role="status" aria-live="polite">
  <span>{message}</span>
  {#if ondismiss && !sticky}<button onclick={ondismiss} aria-label="Dismiss">×</button>{/if}
</div>

<style>
  /* Fixed, not in flow: the content underneath keeps its position and the header does not move. */
  .global-warning {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: 60;
    display: flex;
    align-items: flex-start;
    gap: var(--s3);
    padding: calc(var(--safe-t) + var(--s3)) var(--s4) var(--s3);
    border-bottom: 1px solid var(--line-strong);
    background: var(--surface);
    color: var(--text-1);
    font-size: var(--t-sm);
    box-shadow: 0 10px 24px rgb(0 0 0 / 28%);
    animation: notice-in 160ms ease-out;
  }
  .global-warning.sticky { box-shadow: none; }
  span { min-width: 0; overflow-wrap: anywhere; flex: 1; }
  button {
    flex: none;
    min-width: 44px;
    min-height: 44px;
    border: 0;
    background: none;
    color: inherit;
    font-size: var(--t-md);
    cursor: pointer;
  }
  @keyframes notice-in {
    from { transform: translateY(-100%); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
  @media (prefers-reduced-motion: reduce) {
    .global-warning { animation: none; }
  }
</style>
