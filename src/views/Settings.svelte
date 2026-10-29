<script lang="ts">
  /**
   * Settings: one screen, grouped, no giant list of everything.
   *
   * Each row writes through `settings.set`, which assigns first and saves after, so a toggle never
   * waits on the database. Appearance is separate: the theme is applied to `<html>` and kept in
   * localStorage, because it has to be right before the database is open.
   */
  import { settings } from "../state/settings.svelte";
  import { library } from "../state/library.svelte";
  import { downloads } from "../state/downloads.svelte";
  import { appearance, THEME_OPTIONS } from "../lib/theme.svelte";
  import { DENSITY_OPTIONS, coverWidth, deviceClass } from "../lib/layout-modes";
  import { viewport } from "../lib/layout.svelte";
  import { go } from "../lib/nav";

  /** The slider shows the cover the library actually draws, not a value a preset overrides. */
  const cover = $derived(coverWidth(settings.libraryDensity, deviceClass(viewport.width), settings.coverSize));

  const bytes = $derived(
    downloads.bytes < 1024 * 1024
      ? `${(downloads.bytes / 1024).toFixed(0)} KB`
      : downloads.bytes < 1024 * 1024 * 1024
        ? `${(downloads.bytes / 1024 / 1024).toFixed(1)} MB`
        : `${(downloads.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
  );

  /**
   * History controls. Clearing the log is destructive, so it is always two taps, and the copy says
   * exactly what survives — progress, read marks, library and downloads.
   */
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

<section class="view">
  <header class="bar">
    <button class="btn ghost icon" aria-label="Back" onclick={() => go("/more")}>
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <h1>Settings</h1>
  </header>

  <section class="group">
    <h2>Appearance</h2>
    <div class="chips">
      {#each THEME_OPTIONS as option (option.id)}
        <button class="chip" class:on={appearance.theme === option.id} onclick={() => appearance.apply(option.id)}>{option.label}</button>
      {/each}
    </div>
  </section>

  <section class="group">
    <h2>Library</h2>
    <label class="row">
      <span>Layout</span>
      <select class="field" value={settings.libraryView} onchange={(event) => settings.set("libraryView", event.currentTarget.value as typeof settings.libraryView)}>
        <option value="grid">Cover grid</option>
        <option value="compact">Compact grid</option>
        <option value="list">List</option>
      </select>
    </label>
    <label class="row">
      <span>Cover size</span>
      <input
        type="range"
        min="96"
        max="200"
        step="4"
        value={cover}
        oninput={(event) => {
          settings.set("coverSize", Number(event.currentTarget.value));
          settings.set("libraryDensity", "manual");
        }}
      />
    </label>
    <div class="row">
      <span>Density</span>
      <div class="chips">
        {#each DENSITY_OPTIONS as option (option.id)}
          <button class="chip" class:on={settings.libraryDensity === option.id} onclick={() => settings.set("libraryDensity", option.id)}>
            {option.label}
          </button>
        {/each}
      </div>
    </div>
    <label class="row">
      <span>Category navigation</span>
      <select class="field" value={settings.categoryNav} onchange={(event) => settings.set("categoryNav", event.currentTarget.value as typeof settings.categoryNav)}>
        <option value="automatic">Automatic</option>
        <option value="tabs">Tabs</option>
        <option value="sidebar">Sidebar</option>
      </select>
    </label>
    <label class="row">
      <span>Show “Continue reading”</span>
      <input type="checkbox" checked={settings.showContinue} onchange={(event) => settings.set("showContinue", event.currentTarget.checked)} />
    </label>
  </section>

  <section class="group">
    <h2>Reader</h2>
    <label class="row">
      <span>Reading mode</span>
      <select class="field" value={settings.readerMode} onchange={(event) => settings.set("readerMode", event.currentTarget.value as typeof settings.readerMode)}>
        <option value="vertical">Vertical</option>
        <option value="webtoon">Webtoon</option>
        <option value="paged">Paged</option>
        <option value="ltr">Left → right</option>
        <option value="rtl">Right → left</option>
      </select>
    </label>
    <label class="row">
      <span>Fit</span>
      <select class="field" value={settings.readerFit} onchange={(event) => settings.set("readerFit", event.currentTarget.value as typeof settings.readerFit)}>
        <option value="width">Width</option>
        <option value="height">Height</option>
        <option value="contain">Whole page</option>
      </select>
    </label>
    <label class="row">
      <span>Page spacing</span>
      <input type="range" min="0" max="24" step="2" value={settings.pageGap} oninput={(event) => settings.set("pageGap", Number(event.currentTarget.value))} />
    </label>
    <label class="row">
      <span>Tap zones turn pages</span>
      <input type="checkbox" checked={settings.tapZones} onchange={(event) => settings.set("tapZones", event.currentTarget.checked)} />
    </label>
    <label class="row">
      <span>Keep the screen awake</span>
      <input type="checkbox" checked={settings.keepAwake} onchange={(event) => settings.set("keepAwake", event.currentTarget.checked)} />
    </label>
  </section>

  <section class="group">
    <h2>History</h2>
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
  </section>

  <section class="group">
    <h2>Storage</h2>
    <div class="row">
      <span>Downloads</span>
      <span class="muted">{bytes} · {downloads.rows.length} chapters</span>
    </div>
    <button class="row link" onclick={() => go("/downloads")}>
      <span>Manage downloads</span>
      <span class="chev">›</span>
    </button>
  </section>

  <section class="group">
    <h2>Backup</h2>
    <button class="row link" onclick={() => go("/backup")}>
      <span>Backup &amp; restore</span>
      <span class="chev">›</span>
    </button>
    <p class="hint">Manual backup is free and always available. Automatic sync is a paid extra and never required to read.</p>
  </section>
</section>

<style>
  .view {
    padding: var(--s3) var(--s4) var(--s7);
    max-width: 720px;
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding-top: var(--safe-t);
    margin-bottom: var(--s4);
  }

  .bar svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  h1 {
    font-size: var(--t-xl);
    font-weight: 650;
  }

  .group {
    margin-bottom: var(--s5);
    padding-bottom: var(--s3);
    border-bottom: 1px solid var(--line);
  }

  h2 {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin-bottom: var(--s2);
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

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
  }

  .hint {
    margin: var(--s2) 0 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.6;
  }

  .muted {
    color: var(--text-3);
    font-size: var(--t-sm);
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
</style>
