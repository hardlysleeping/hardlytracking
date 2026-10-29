<script lang="ts">
  /**
   * The shell: one navigation model, three presentations.
   *
   * A phone gets a bottom bar, a narrow window a rail, a desktop a sidebar with labels. The
   * destinations and the active state are the same in all three, so nothing about "where am I"
   * changes when the window is resized — only how much room the chrome takes.
   */
  import type { Snippet } from "svelte";
  import { DESTINATIONS } from "../lib/destinations";
  import { viewport } from "../lib/layout.svelte";
  import { deviceClass } from "../lib/layout-modes";
  import { go } from "../lib/nav";

  let { active, children }: { active: string; children: Snippet } = $props();

  /**
   * The chrome is the library's device class, from the same module the library's own layout comes
   * from — a rail the shell draws is a width the library may not use for a grid.
   */
  const device = $derived(deviceClass(viewport.width));
</script>

<div class="app" class:compact={device === "phone"} class:medium={device === "tablet"} class:large={device === "desktop"}>
  {#if device === "desktop"}
    <aside class="sidebar">
      <div class="brand">HardlyTracking</div>
      <nav aria-label="Main">
        {#each DESTINATIONS as destination (destination.id)}
          <button
            class="item"
            class:on={active === destination.id}
            aria-current={active === destination.id ? "page" : undefined}
            onclick={() => go(destination.href)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
            <span>{destination.label}</span>
          </button>
        {/each}
      </nav>
    </aside>
  {:else if device === "tablet"}
    <nav class="rail" aria-label="Main">
      {#each DESTINATIONS as destination (destination.id)}
        <button
          class="item"
          class:on={active === destination.id}
          aria-current={active === destination.id ? "page" : undefined}
          onclick={() => go(destination.href)}
          title={destination.label}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
          <span>{destination.label}</span>
        </button>
      {/each}
    </nav>
  {/if}

  <main>
    {@render children()}
  </main>

  {#if device === "phone"}
    <nav class="bar" aria-label="Main">
      {#each DESTINATIONS as destination (destination.id)}
        <button
          class="item"
          class:on={active === destination.id}
          aria-current={active === destination.id ? "page" : undefined}
          onclick={() => go(destination.href)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d={destination.icon} /></svg>
          <span>{destination.label}</span>
        </button>
      {/each}
    </nav>
  {/if}
</div>

<style>
  .app {
    min-height: 100dvh;
    background: var(--bg);
  }

  main {
    min-width: 0;
    min-height: 100dvh;
  }

  .app.large main {
    margin-left: var(--sidebar-w);
  }

  .app.medium main {
    margin-left: var(--rail-w);
  }

  .app.compact main {
    padding-bottom: calc(var(--nav-h) + var(--safe-b));
  }

  nav {
    display: flex;
  }

  .item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: var(--s3);
    color: var(--text-3);
    border-radius: var(--r2);
    transition: color var(--dur), background var(--dur);
  }

  .item svg {
    width: 22px;
    height: 22px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
    flex: none;
  }

  .item:hover {
    color: var(--text-1);
  }

  .item.on {
    color: var(--text-1);
  }

  /* ---- sidebar (large) ---- */
  .sidebar {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--sidebar-w);
    padding: calc(var(--s5) + var(--safe-t)) var(--s3) var(--s4) calc(var(--s3) + var(--safe-l));
    border-right: 1px solid var(--line);
    background: var(--surface);
    display: flex;
    flex-direction: column;
    gap: var(--s5);
  }

  .brand {
    font-size: var(--t-sm);
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--text-2);
    padding: 0 var(--s3);
  }

  .sidebar nav {
    flex-direction: column;
    gap: 2px;
  }

  .sidebar .item {
    padding: var(--s2) var(--s3);
    font-size: var(--t-md);
    min-height: 40px;
  }

  .sidebar .item.on {
    background: var(--surface-2);
    font-weight: 600;
  }

  /* ---- rail (medium) ---- */
  .rail {
    position: fixed;
    inset: 0 auto 0 0;
    width: var(--rail-w);
    padding: calc(var(--s4) + var(--safe-t)) var(--s2) var(--s4) calc(var(--s2) + var(--safe-l));
    border-right: 1px solid var(--line);
    background: var(--surface);
    flex-direction: column;
    gap: var(--s2);
  }

  .rail .item {
    flex-direction: column;
    gap: 2px;
    padding: var(--s2) 0;
    font-size: var(--t-xs);
  }

  .rail .item.on {
    background: var(--surface-2);
  }

  /* ---- bottom bar (compact) ---- */
  .bar {
    position: fixed;
    inset: auto 0 0 0;
    z-index: 20;
    padding: var(--s2) var(--s1) calc(var(--s2) + var(--safe-b)) var(--s1);
    background: color-mix(in srgb, var(--surface) 92%, transparent);
    backdrop-filter: blur(14px);
    border-top: 1px solid var(--line);
    justify-content: space-around;
  }

  .bar .item {
    flex: 1;
    flex-direction: column;
    gap: 2px;
    padding: var(--s1) 0;
    font-size: 10px;
    min-height: 44px;
    justify-content: center;
  }

  .bar .item.on {
    color: var(--accent);
  }
</style>
