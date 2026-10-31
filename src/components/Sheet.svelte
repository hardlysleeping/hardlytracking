<script lang="ts">
  /**
   * One overlay primitive: a bottom sheet on a phone, a centred dialog on a wide screen.
   *
   * The plan calls for the same component in both places — filters, reader settings, category
   * management — so it lives here once. Escape and a backdrop click both close it, and the
   * content is focusable so a keyboard user is not stranded behind the scrim.
   */
  import type { Snippet } from "svelte";
  import { viewport } from "../lib/layout.svelte";

  interface Props {
    open: boolean;
    title: string;
    onclose: () => void;
    children: Snippet;
    footer?: Snippet;
  }
  let { open, title, onclose, children, footer }: Props = $props();

  let panel = $state<HTMLDivElement | null>(null);

  $effect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onclose();
      }
    };
    addEventListener("keydown", onKey);
    // Move focus into the sheet, so Tab does not walk the page behind it.
    queueMicrotask(() => panel?.focus());
    return () => removeEventListener("keydown", onKey);
  });
</script>

{#if open}
  <div class="scrim" role="presentation" onclick={onclose}></div>
  <div
    class="panel"
    class:sheet={viewport.size === "compact"}
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    bind:this={panel}
  >
    <header>
      <h2>{title}</h2>
      <!-- 44px is the smallest comfortable finger target; the ghost icon button is 36 by default. -->
      <button class="btn ghost icon close" aria-label="Close" onclick={onclose}>✕</button>
    </header>
    <div class="body">
      {@render children()}
    </div>
    {#if footer}
      <footer>{@render footer()}</footer>
    {/if}
  </div>
{/if}

<style>
  .scrim {
    position: fixed;
    inset: 0;
    z-index: 40;
    background: rgb(0 0 0 / 55%);
    backdrop-filter: blur(2px);
  }

  .panel {
    position: fixed;
    z-index: 41;
    display: flex;
    flex-direction: column;
    background: var(--elevated);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-2);
    max-height: 86dvh;
    /* wide screen: a dialog */
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: min(520px, calc(100vw - 32px));
    border-radius: var(--r3);
  }

  /* phone: a sheet that comes up from the bottom, with the safe area respected */
  .panel.sheet {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    transform: none;
    width: auto;
    border-radius: var(--r3) var(--r3) 0 0;
    border-bottom: none;
    padding-bottom: var(--safe-b);
    max-height: 88dvh;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding: var(--s4) var(--s4) var(--s2);
    border-bottom: 1px solid var(--line);
  }

  /* The close control is the one thing a thumb reaches for; 36px is a miss on a phone. */
  .close {
    min-width: 44px;
    min-height: 44px;
  }

  h2 {
    font-size: var(--t-lg);
  }

  .body {
    padding: var(--s4);
    overflow-y: auto;
    display: grid;
    gap: var(--s3);
  }

  footer {
    padding: var(--s3) var(--s4) var(--s4);
    border-top: 1px solid var(--line);
    display: flex;
    justify-content: flex-end;
    gap: var(--s2);
  }
</style>
