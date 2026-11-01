<script lang="ts">
  /**
   * "Still working" — the slow-call chip.
   *
   * The extension host interprets a Mihon extension, so a search can take ten seconds on a good day
   * and forever on a bad one. Without this the screen simply does not change, which reads as a
   * frozen app; with it, the app is visibly alive while the source is slow. It appears after
   * `APPEAR_AFTER_MS` (a fast answer must not flicker a chip) and names the oldest call in flight.
   *
   * It is deliberately not a Cancel button: aborting a half-read index buys nothing, and the call
   * already has a deadline of its own (`lib/deadline.ts`), which ends it with a sentence a user can
   * read.
   */
  import { onMount } from "svelte";
  import { activity } from "../lib/deadline";

  /** A call shorter than this never shows a chip — otherwise every tap flickers one. */
  const APPEAR_AFTER_MS = 1200;
  /** The clock only re-renders once a second; the chip says seconds, not milliseconds. */
  const TICK_MS = 1000;

  let slowest = $state<{ label: string; elapsedMs: number } | null>(null);

  onMount(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const read = () => {
      const current = activity.slowest();
      slowest = current !== null && current.elapsedMs >= APPEAR_AFTER_MS ? current : null;
    };
    read();
    const stop = activity.subscribe(read);
    timer = setInterval(read, TICK_MS);
    return () => {
      stop();
      if (timer !== null) clearInterval(timer);
    };
  });

  const seconds = $derived(slowest === null ? 0 : Math.round(slowest.elapsedMs / 1000));
</script>

{#if slowest !== null}
  <div class="slow" role="status" aria-live="polite">
    <span class="pulse" aria-hidden="true"></span>
    <span class="text">Waiting on {slowest.label} · {seconds}s</span>
  </div>
{/if}

<style>
  .slow {
    position: fixed;
    left: 50%;
    bottom: calc(var(--safe-b) + 68px);
    z-index: 30;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    transform: translateX(-50%);
    background: var(--elevated, var(--surface));
    border: 1px solid var(--line);
    border-radius: var(--r-pill);
    box-shadow: 0 6px 20px rgb(0 0 0 / 25%);
    color: var(--fg);
    font-size: var(--t-sm);
    pointer-events: none;
    white-space: nowrap;
  }
  .pulse {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    animation: breathe 1.6s ease-in-out infinite;
  }
  @keyframes breathe {
    0%,
    100% {
      opacity: 0.35;
      transform: scale(0.85);
    }
    50% {
      opacity: 1;
      transform: scale(1);
    }
  }
  /* Motion is decoration here; the text still says what is happening. */
  @media (prefers-reduced-motion: reduce) {
    .pulse {
      animation: none;
      opacity: 0.9;
    }
  }
</style>
