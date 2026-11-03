<script lang="ts">
  /**
   * The `⋯` sheet: the library actions that are worth having but not worth an icon.
   *
   * Refresh and Select are here *as well as* in the top bar — the parity contract says neither may
   * vanish until the owner says so — and Statistics is a second page of the same sheet rather than
   * a second overlay, so only one thing is ever open.
   */
  import Sheet from "./Sheet.svelte";
  import { plugins } from "../state/plugins.svelte";

  export interface LibraryStats {
    series: number;
    unread: number;
    downloaded: number;
    categories: Array<{ name: string; count: number }>;
  }

  interface Props {
    open: boolean;
    onclose: () => void;
    onrefresh: () => void;
    onselect: () => void;
    oncategories: () => void;
    onsettings: () => void;
    stats: LibraryStats;
  }
  let { open, onclose, onrefresh, onselect, oncategories, onsettings, stats }: Props = $props();

  let page = $state<"menu" | "stats">("menu");

  /** Plugin entries for this menu. A plugin declares them; a grant puts them here. */
  const pluginActions = $derived(plugins.actionsFor("library"));

  // Reopening always lands on the menu: a sheet that remembers "statistics" reads as a bug.
  $effect(() => {
    if (!open) page = "menu";
  });

  function run(action: () => void): void {
    onclose();
    action();
  }
</script>

<Sheet open={open} title={page === "menu" ? "Library" : "Statistics"} onclose={onclose}>
  {#if page === "menu"}
    <div class="menu-list">
      <button class="menu-item" onclick={() => run(onrefresh)}><span>Refresh library</span></button>
      <button class="menu-item" onclick={() => run(onselect)}><span>Select manga</span></button>
      <button class="menu-item" onclick={() => run(oncategories)}><span>Edit categories</span></button>
      <button class="menu-item" onclick={() => run(onsettings)}><span>Library settings</span></button>
      <button class="menu-item" onclick={() => (page = "stats")}><span>Statistics</span><span aria-hidden="true">›</span></button>
      {#if pluginActions.length > 0}
        <!--
          Plugin entries come last and name their plugin: an action someone else wrote must never be
          mistaken for the app's own, and the manifest is what decided it may be here at all.
        -->
        {#each pluginActions as action (action.pluginId + action.id)}
          <button class="menu-item" onclick={() => run(() => plugins.invoke(action.pluginId, action.id))}>
            <span>{action.title}</span>
            <span class="plugin" aria-hidden="true">{action.pluginId}</span>
          </button>
        {/each}
      {/if}
    </div>
  {:else}
    <dl class="facts">
      <div><dt>Series</dt><dd>{stats.series}</dd></div>
      <div><dt>Unread chapters</dt><dd>{stats.unread}</dd></div>
      <div><dt>Downloaded chapters</dt><dd>{stats.downloaded}</dd></div>
    </dl>
    {#if stats.categories.length > 0}
      <h3>Per category</h3>
      <dl class="facts">
        {#each stats.categories as category (category.name)}
          <div><dt>{category.name}</dt><dd>{category.count}</dd></div>
        {/each}
      </dl>
    {/if}
    <button class="btn" onclick={() => (page = "menu")}>Back</button>
  {/if}
</Sheet>

<style>
  .menu-list {
    display: grid;
    gap: 2px;
  }

  .menu-item {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding: var(--s3);
    border-radius: var(--r2);
    min-height: 44px;
    box-sizing: border-box;
    font-size: var(--t-md);
  }

  .menu-item:hover {
    background: var(--surface-2);
  }

  .plugin {
    color: var(--text-3);
    font-size: var(--t-xs);
  }

  .facts {
    display: grid;
    gap: var(--s2);
    margin: 0;
    font-size: var(--t-sm);
  }

  .facts > div {
    display: flex;
    justify-content: space-between;
    gap: var(--s3);
  }

  .facts dt {
    color: var(--text-3);
  }

  .facts dd {
    margin: 0;
    color: var(--text-1);
  }

  h3 {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
  }
</style>
