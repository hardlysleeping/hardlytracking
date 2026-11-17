<script lang="ts">
  /**
   * The Library's own options, in one component with two doors.
   *
   * The Settings page draws it inside its Library section and the Library page draws it in a
   * gear popup, so there is one implementation and no second copy to drift. `browse` is false on
   * the Library page because `<BrowseDisplay />` already sits inline above the shelf there — the
   * same control, in the place a reader reaches for it without opening anything.
   */
  import { settings } from "../state/settings.svelte";
  import BrowseDisplay from "./BrowseDisplay.svelte";
  import { PANE_CHOICES } from "../lib/view-options";
  import { LIBRARY_SECTIONS, moveItem } from "../lib/nav-order";

  interface Props {
    /** Draw the view/columns/density row. Off where the page already draws it inline. */
    browse?: boolean;
  }
  let { browse = true }: Props = $props();

  /** The tabs above the shelf, in the order the reader put them. */
  function moveSection(id: string, delta: number): void {
    const index = settings.libraryTabs.indexOf(id);
    if (index < 0) return;
    settings.set("libraryTabs", moveItem(settings.libraryTabs, index, delta));
  }
</script>

<div class="panelbody" data-panel="library" aria-label="Library settings">
  {#if browse}
    <BrowseDisplay />
  {/if}

  <label class="row">
    <span>Category navigation</span>
    <select class="field" value={settings.categoryNav} onchange={(event) => settings.set("categoryNav", event.currentTarget.value as typeof settings.categoryNav)}>
      <option value="automatic">Automatic</option>
      <option value="tabs">Tabs</option>
      <option value="sidebar">Sidebar</option>
    </select>
  </label>

  <label class="row">
    <span>Library panes<em class="sub">Two panes put the series beside the shelf, like a tablet.</em></span>
    <select
      class="field"
      value={settings.libraryPane}
      onchange={(event) => settings.set("libraryPane", event.currentTarget.value as typeof settings.libraryPane)}
    >
      {#each PANE_CHOICES as choice (choice.id)}
        <option value={choice.id}>{choice.label}</option>
      {/each}
    </select>
  </label>

  <label class="row">
    <span>Show “Continue reading”</span>
    <input type="checkbox" checked={settings.showContinue} onchange={(event) => settings.set("showContinue", event.currentTarget.checked)} />
  </label>

  <!--
    The section tabs, above the shelf: reordered here because it is a library option, not a
    performance one. Arrows, not drag: one tap moves one place and it works with a keyboard.
  -->
  <div class="orderlist">
    <p class="orderhead">
      Library sections
      <em class="sub">The order of the tabs above the shelf.</em>
    </p>
    {#each settings.libraryTabs as id, index (id)}
      {@const section = LIBRARY_SECTIONS.find((item) => item.id === id)}
      <div class="row orderrow">
        <span class="orderlabel">{section?.label ?? id}</span>
        <div class="orderacts">
          <button
            class="orderbtn"
            aria-label={`Move ${section?.label ?? id} up`}
            disabled={index === 0}
            onclick={() => moveSection(id, -1)}
          >↑</button>
          <button
            class="orderbtn"
            aria-label={`Move ${section?.label ?? id} down`}
            disabled={index === settings.libraryTabs.length - 1}
            onclick={() => moveSection(id, 1)}
          >↓</button>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .panelbody {
    display: grid;
    gap: 2px;
    min-width: 0;
  }

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

  .sub {
    display: block;
    margin-top: 2px;
    font-style: normal;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.5;
    max-width: 46ch;
  }

  .orderlist {
    display: grid;
    gap: 2px;
    padding: var(--s2) 0 var(--s1);
    border-top: 1px solid var(--line);
  }

  .orderhead {
    margin: var(--s2) 0 var(--s1);
    font-size: var(--t-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .orderrow {
    gap: var(--s2);
    min-height: 44px;
  }

  .orderlabel {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .orderacts {
    display: flex;
    align-items: center;
    gap: var(--s1);
    flex: none;
  }

  /* 44 × 44, the same tap target as every other control in this panel. */
  .orderbtn {
    all: unset;
    box-sizing: border-box;
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 1px solid var(--line);
    border-radius: var(--r2);
    color: var(--text-2);
    cursor: pointer;
    font-size: var(--t-md);
  }

  .orderbtn:disabled {
    opacity: 0.35;
    cursor: default;
  }
</style>
