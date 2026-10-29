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

  /** Two-step confirm: clearing the log is destructive and should not be one stray tap. */
  let clearing = $state(false);
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
    <h2>Privacy</h2>
    <label class="row">
      <span>Record reading history<em class="sub">What you read, when, and for how long. Progress and Continue Reading are kept either way.</em></span>
      <input type="checkbox" checked={settings.recordHistory} onchange={(event) => settings.set("recordHistory", event.currentTarget.checked)} />
    </label>
    {#if clearing}
      <div class="row">
        <span>Delete the reading log? Bookmarks stay.</span>
        <span class="acts2">
          <button class="chip" onclick={() => (clearing = false)}>Cancel</button>
          <button
            class="chip danger"
            onclick={async () => {
              await library.clearHistory();
              clearing = false;
            }}>Clear</button>
        </span>
      </div>
    {:else}
      <button class="row link" onclick={() => (clearing = true)}>
        <span>Clear reading history</span>
        <span class="chev">›</span>
      </button>
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
</style>
