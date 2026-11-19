<script lang="ts">
  /**
   * Keeping part of the library offline, on purpose.
   *
   * Three switches, all off by default, and a sentence that says the one thing a reader needs to
   * know before touching them: turning this off deletes nothing. Downloads are the reader's files;
   * a policy only decides what gets fetched next.
   */
  import { categories } from "../state/categories.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { settings } from "../state/settings.svelte";
  import { describeKeepPolicy } from "../lib/offline/policy";

  /** What the last keep pass did, so the button's tap is answered. */
  let note = $state<string | null>(null);
  let busy = $state(false);

  const chosen = $derived(new Set(settings.keepCategories));

  function toggleCategory(id: string): void {
    const next = new Set(chosen);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    settings.set("keepCategories", [...next]);
  }

  async function keepNow(): Promise<void> {
    // No categories chosen used to answer "Everything in those categories is already on this
    // device", which is true of nothing: there were no categories. Ask for the choice instead.
    if (settings.keepCategories.length === 0) {
      note = "Pick at least one category above. Until one is chosen there is nothing to fetch — or turn on “Keep new titles offline” so a title is fetched the moment it is added.";
      return;
    }
    busy = true;
    try {
      const result = await downloads.keepLibraryOffline();
      // A partial pass says both halves: what was queued and what could not be asked. Reporting only
      // the failure threw away the work that had already happened.
      const unreached =
        result.failed === 0
          ? ""
          : ` ${result.failed} title${result.failed === 1 ? "" : "s"} could not be reached.`;
      note =
        result.queued === 0
          ? result.failed === 0
            ? "Everything in those categories is already on this device."
            : `Nothing new was queued.${unreached}`
          : `Queued ${result.queued} issue${result.queued === 1 ? "" : "s"} from ${result.titles} title${result.titles === 1 ? "" : "s"}.${unreached}`;
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
    }
  }
</script>

<label class="row">
  <span>
    Keep new titles offline
    <small>When a title is added to the library, fetch its issues in the background.</small>
  </span>
  <input
    type="checkbox"
    checked={settings.keepOnAdd}
    onchange={(event) => settings.set("keepOnAdd", event.currentTarget.checked)}
  />
</label>

{#if categories.items.length > 0}
  <div class="keepcats">
    <span class="label">Always keep these categories</span>
    <div class="chips">
      {#each categories.items as category (category.id)}
        <button
          class="chip"
          class:on={chosen.has(category.id)}
          aria-pressed={chosen.has(category.id)}
          onclick={() => toggleCategory(category.id)}
        >
          {category.name}
        </button>
      {/each}
    </div>
  </div>
{/if}

<div class="keepnow">
  <button class="btn" disabled={busy} onclick={() => void keepNow()}>
    {busy ? "Fetching…" : "Fetch the selected categories now"}
  </button>
  {#if note !== null}<p class="hint">{note}</p>{/if}
</div>

<p class="hint">{describeKeepPolicy({ keepOnAdd: settings.keepOnAdd, keepCategories: settings.keepCategories })}</p>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
  }

  .row small {
    display: block;
    margin-top: 2px;
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .keepcats {
    display: grid;
    gap: var(--s2);
  }

  /* A category chip is a button first: on a phone it must be a thumb target, not a word with
     padding. The shared chip is sized for a dense toolbar, so this list raises it. */
  .chip {
    min-height: 36px;
  }

  @media (pointer: coarse) {
    .chip {
      min-height: 44px;
    }
  }

  .keepnow {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .hint {
    margin: 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.4;
  }
</style>
