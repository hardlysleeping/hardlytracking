<script lang="ts">
  let { message, ondismiss }: { message: string; ondismiss?: () => void } = $props();
</script>

<div class="global-warning" role="status">
  <span>{message}</span>
  {#if ondismiss}<button onclick={ondismiss} aria-label="Dismiss">×</button>{/if}
</div>

<style>
  .global-warning {
    position: relative;
    z-index: 35;
    display: flex;
    align-items: flex-start;
    gap: var(--s3);
    padding: calc(var(--safe-t) + var(--s3)) var(--s4) var(--s3);
    border-bottom: 1px solid var(--line-strong);
    background: var(--surface);
    color: var(--text-1);
    font-size: var(--t-sm);
  }
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
</style>
