<script lang="ts">
  /**
   * The History page's own options, in one component with two doors: the Settings page's History
   * section and the gear popup on the History page itself.
   *
   * Clearing the log is destructive, so it is always two taps, and the copy says exactly what
   * survives — progress, read marks, library and downloads.
   */
  import { settings } from "../state/settings.svelte";
  import { library } from "../state/library.svelte";
  import { PANE_CHOICES } from "../lib/view-options";

  let clearing = $state<"all" | "range" | null>(null);
  let cleared = $state<string | null>(null);

  const RETENTION_PRESETS = [0, 30, 90, 180, 365];
  const RANGES = [
    { id: "today", label: "Today" },
    { id: "7", label: "Last 7 days" },
    { id: "30", label: "Last 30 days" },
    { id: "all", label: "All time" },
  ] as const;
  let rangeChoice = $state<(typeof RANGES)[number]["id"]>("7");

  /** `custom` when the stored number is not one of the presets. */
  let retentionChoice = $state(
    RETENTION_PRESETS.includes(settings.historyRetentionDays) ? String(settings.historyRetentionDays) : "custom",
  );
  let customDays = $state(RETENTION_PRESETS.includes(settings.historyRetentionDays) ? 30 : settings.historyRetentionDays);

  function midnight(daysAgo = 0): number {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return start.getTime() - daysAgo * 86_400_000;
  }

  async function clearNow(): Promise<void> {
    const range =
      clearing === "range" && rangeChoice !== "all"
        ? { since: midnight(rangeChoice === "today" ? 0 : Number(rangeChoice)) }
        : {};
    const removed = await library.clearHistory(range);
    const scope = clearing === "all" || (clearing === "range" && rangeChoice === "all") ? "all history" : RANGES.find((r) => r.id === rangeChoice)?.label.toLowerCase() ?? "history";
    cleared = `Deleted ${removed.sessions} session${removed.sessions === 1 ? "" : "s"} and ${removed.history} history entr${removed.history === 1 ? "y" : "ies"} from ${scope}. Progress and read marks were not touched.`;
    clearing = null;
  }
</script>

<div class="panelbody" data-panel="history" aria-label="History settings">
  <label class="row">
    <span>Pause reading history<em class="sub">No new sessions and no new history entries — incognito reading. Progress, read marks and Continue Reading keep working.</em></span>
    <input type="checkbox" checked={settings.historyPaused} onchange={(event) => settings.set("historyPaused", event.currentTarget.checked)} />
  </label>

  <label class="row">
    <span>Keep reading history<em class="sub">Applies to reading sessions only. Progress, read marks, categories, bookmarks and downloads are never deleted by retention.</em></span>
    <select
      class="field"
      value={String(retentionChoice)}
      onchange={(event) => {
        const value = event.currentTarget.value;
        if (value === "custom") {
          retentionChoice = "custom";
          settings.set("historyRetentionDays", customDays);
        } else {
          retentionChoice = value;
          settings.set("historyRetentionDays", Number(value));
          void library.pruneSessions();
        }
      }}
    >
      <option value="0">Forever</option>
      <option value="30">30 days</option>
      <option value="90">90 days</option>
      <option value="180">6 months</option>
      <option value="365">1 year</option>
      <option value="custom">Custom…</option>
    </select>
  </label>
  {#if retentionChoice === "custom"}
    <label class="row">
      <span>Days</span>
      <input
        class="field num"
        type="number"
        min="1"
        max="3650"
        value={customDays}
        onchange={(event) => {
          const days = Math.max(1, Math.min(3650, Number(event.currentTarget.value) || 30));
          customDays = days;
          settings.set("historyRetentionDays", days);
          void library.pruneSessions();
        }}
      />
    </label>
  {/if}

  <!-- The timeline's shape belongs to the page it draws, so it is set here rather than in Layout. -->
  <label class="row">
    <span>History panes<em class="sub">Two panes: the timeline on the left, the entry you pick on the right.</em></span>
    <select
      class="field"
      value={settings.historyPane}
      onchange={(event) => settings.set("historyPane", event.currentTarget.value as typeof settings.historyPane)}
    >
      {#each PANE_CHOICES.filter((choice) => choice.id !== "three") as choice (choice.id)}
        <option value={choice.id}>{choice.label}</option>
      {/each}
    </select>
  </label>

  {#if clearing === null}
    <button class="row link" onclick={() => (clearing = "all")}>
      <span>Clear reading history</span>
      <span class="chev">›</span>
    </button>
    <button class="row link" onclick={() => (clearing = "range")}>
      <span>Clear history by date…</span>
      <span class="chev">›</span>
    </button>
  {:else if clearing === "all"}
    <div class="confirm">
      <p>Delete all recorded reading sessions and reading-history entries? Your current chapter, page progress, read/unread state, library, and downloads will not be changed.</p>
      <span class="acts2">
        <button class="chip" onclick={() => (clearing = null)}>Cancel</button>
        <button class="chip danger" onclick={() => void clearNow()}>Delete</button>
      </span>
    </div>
  {:else}
    <div class="confirm">
      <p>Delete recorded sessions and history entries from a period. Progress, read marks, library and downloads are not changed.</p>
      <div class="range">
        {#each RANGES as range (range.id)}
          <button class="chip" class:on={rangeChoice === range.id} onclick={() => (rangeChoice = range.id)}>{range.label}</button>
        {/each}
      </div>
      <span class="acts2">
        <button class="chip" onclick={() => (clearing = null)}>Cancel</button>
        <button class="chip danger" onclick={() => void clearNow()}>Delete</button>
      </span>
    </div>
  {/if}
  {#if cleared !== null}
    <p class="hint">{cleared}</p>
  {/if}
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

  .row.link {
    all: unset;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    min-height: 44px;
    font-size: var(--t-md);
    width: 100%;
    box-sizing: border-box;
  }

  .row.link:hover {
    color: var(--accent);
  }

  .chev {
    color: var(--text-3);
    font-size: var(--t-lg);
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

  .confirm {
    display: grid;
    gap: var(--s3);
    padding: var(--s3) 0 var(--s2);
    border-top: 1px solid var(--line);
  }

  .confirm p {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
    line-height: 1.6;
  }

  .acts2 {
    display: flex;
    gap: var(--s2);
    justify-content: flex-end;
  }

  .range {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .chip.danger {
    color: var(--danger, #d9534f);
    border-color: currentColor;
  }

  .field.num {
    width: 96px;
  }

  .hint {
    margin: var(--s2) 0 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.6;
  }
</style>
