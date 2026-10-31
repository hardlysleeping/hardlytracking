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
  import { onMount } from "svelte";
  import SyncAccount from "../components/SyncAccount.svelte";
  import { hostInfo, hostToken, pairingLink, remoteHost, setHostToken, setRemoteHost, type HostInfo } from "../lib/host";
  import { imageCache } from "../lib/cache/images";
  import { CACHE_LIMIT_CHOICES, describeCache, formatBytes, type CacheEntry } from "../lib/cache/policy";
  import { MARGIN_CHOICES, PANE_CHOICES } from "../lib/view-options";
  import { CPU_LEVELS, describeLevel } from "../lib/performance";

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

  /** Phone access: what this server says about itself, and the pairing state of this device. */
  let info = $state<HostInfo | null>(null);

  /** The image cache, described the way HardlyReader describes its own: a number, not a spinner. */
  let cacheEntries = $state<CacheEntry[]>([]);
  let cacheNote = $state<string | null>(null);

  const cacheSentence = $derived(
    cacheNote ?? describeCache(cacheEntries, { limitBytes: settings.imageCacheLimitMb * 1024 * 1024, cacheImages: settings.cacheImages, keepRead: true }),
  );

  async function refreshCache(): Promise<void> {
    cacheEntries = await imageCache.entries();
  }

  async function clearImages(): Promise<void> {
    const removed = await imageCache.clear();
    cacheNote = `Cleared ${removed.removed} cached image${removed.removed === 1 ? "" : "s"} — ${formatBytes(removed.freed)} freed`;
    await refreshCache();
    setTimeout(() => (cacheNote = null), 4000);
  }
  let token = $state(hostToken());
  let hostValue = $state(remoteHost());
  let copied = $state(false);

  onMount(() => {
    void hostInfo().then((value) => (info = value));
    void refreshCache();
    imageCache.setPolicy({ limitBytes: settings.imageCacheLimitMb * 1024 * 1024, cacheImages: settings.cacheImages });
  });

  const link = $derived(info === null ? null : pairingLink(info, token));

  function saveToken(value: string): void {
    setHostToken(value);
    token = hostToken();
    void hostInfo().then((next) => (info = next));
  }

  function saveHost(value: string): void {
    setRemoteHost(value);
    hostValue = remoteHost();
    void hostInfo().then((next) => (info = next));
  }

  async function copyLink(): Promise<void> {
    if (link === null) return;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
      setTimeout(() => (copied = false), 1500);
    } catch {
      copied = false;
    }
  }
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
  </section>

  <section class="group">
    <h2>Performance</h2>
    <div class="row">
      <span>Work level<em class="sub">{describeLevel(settings.cpuLevel)}</em></span>
      <div class="chips">
        {#each CPU_LEVELS as level (level.id)}
          <button
            class="chip"
            class:on={settings.cpuLevel === level.id}
            title={level.hint}
            onclick={() => settings.set("cpuLevel", level.id)}
          >
            {level.label}
          </button>
        {/each}
      </div>
    </div>
    <p class="hint">Downloads and cover warming follow this. It cannot touch the extension host — that runs in its own container, capped by <code>docker-compose.yml</code>.</p>

    <h2>Layout</h2>
    <div class="row">
      <span>Content margins<em class="sub">How much room the content leaves at the edges.</em></span>
      <div class="chips">
        {#each MARGIN_CHOICES as choice (choice.id)}
          <button
            class="chip"
            class:on={settings.contentMargins === choice.id}
            title={choice.hint}
            onclick={() => settings.set("contentMargins", choice.id)}
          >
            {choice.label}
          </button>
        {/each}
      </div>
    </div>
    <label class="row">
      <span>Maximize space<em class="sub">Hides the screen heading and the Continue strip; every control stays one tap away.</em></span>
      <input
        type="checkbox"
        checked={settings.maximizeSpace}
        onchange={(event) => settings.set("maximizeSpace", event.currentTarget.checked)}
      />
    </label>
    <label class="row">
      <span>History panes<em class="sub">Two panes: the timeline on the left, the entry you pick on the right.</em></span>
      <select
        class="field"
        value={settings.historyPane}
        onchange={(event) => settings.set("historyPane", event.currentTarget.value as typeof settings.historyPane)}
      >
        {#each PANE_CHOICES as choice (choice.id)}
          <option value={choice.id}>{choice.label}</option>
        {/each}
      </select>
    </label>

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
    <h2>Phone access</h2>
    <p class="hint">
      This machine can be the runtime for your phone: it serves the app and its extensions over the network,
      so the phone needs nothing installed on it.
    </p>
    {#if info === null}
      <p class="hint">Not serving on the network. Start the server with <code>HOST=0.0.0.0 HARDLYTRACKING_TOKEN=… npm run serve</code>.</p>
    {:else if !info.serving}
      <p class="hint">Serving on this machine only (127.0.0.1). Restart with <code>HOST=0.0.0.0</code> to let a phone in.</p>
    {:else if link !== null}
      <div class="row">
        <span>Open on your phone<em class="sub">{link}</em></span>
        <button class="chip" onclick={() => void copyLink()}>{copied ? "Copied" : "Copy"}</button>
      </div>
      {#if info.tokenRequired && token === ""}
        <p class="hint">That link has no token yet — paste the server's <code>HARDLYTRACKING_TOKEN</code> below so the phone can call the runtime.</p>
      {/if}
    {:else}
      <p class="hint">Serving on the network, but no network address was found.</p>
    {/if}
    <label class="row">
      <span>Server token<em class="sub">Stored on this device only, and never in a backup.</em></span>
      <input class="field" type="text" value={token} placeholder="optional" spellcheck="false" onchange={(event) => saveToken(event.currentTarget.value)} />
    </label>
    <label class="row">
      <span>Use a remote runtime<em class="sub">Point this device at a desktop instead of itself, e.g. http://192.168.1.20:8460</em></span>
      <input class="field" type="text" value={hostValue} placeholder="this device" spellcheck="false" onchange={(event) => saveHost(event.currentTarget.value)} />
    </label>
  </section>

  <section class="group">
    <h2>Storage</h2>
    <div class="row">
      <span>Downloads</span>
      <span class="muted">{bytes} · {downloads.rows.length} chapters</span>
    </div>
    <label class="row">
      <span>Image cache<em class="sub">{cacheSentence}</em></span>
      <select
        class="field"
        value={String(settings.imageCacheLimitMb)}
        onchange={(event) => {
          const mb = Number(event.currentTarget.value);
          settings.set("imageCacheLimitMb", mb);
          imageCache.setPolicy({ limitBytes: mb * 1024 * 1024 });
          void refreshCache();
        }}
      >
        {#each CACHE_LIMIT_CHOICES as choice (choice.id)}
          <option value={String(choice.bytes / 1024 / 1024)}>{choice.label}</option>
        {/each}
      </select>
    </label>
    <label class="row">
      <span>Cache cover and page images<em class="sub">Off means every image is fetched again.</em></span>
      <input
        type="checkbox"
        checked={settings.cacheImages}
        onchange={(event) => {
          settings.set("cacheImages", event.currentTarget.checked);
          imageCache.setPolicy({ cacheImages: event.currentTarget.checked });
          void refreshCache();
        }}
      />
    </label>
    <button class="row link" onclick={() => void clearImages()}>
      <span>Clear cached images</span>
      <span class="chev">›</span>
    </button>
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

  <SyncAccount />
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
