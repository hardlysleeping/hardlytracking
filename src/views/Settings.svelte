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
  import { inbox } from "../state/inbox.svelte";
  import { plugins } from "../state/plugins.svelte";
  import { notices } from "../state/notices.svelte";
  import { noticeTime } from "../lib/notice-log";
  import { go } from "../lib/nav";
  import { onMount } from "svelte";
  import PageMenu from "../components/PageMenu.svelte";
  import SyncAccount from "../components/SyncAccount.svelte";
  import TrackersPanel from "../components/TrackersPanel.svelte";
  import LibrarySettingsPanel from "../components/LibrarySettingsPanel.svelte";
  import HistorySettingsPanel from "../components/HistorySettingsPanel.svelte";
  import { hostInfo, hostToken, htServerEnabled, pairingLink, remoteHost, type HostInfo } from "../lib/host";
  import { imageCache } from "../lib/cache/images";
  import { CACHE_LIMIT_CHOICES, describeCache, formatBytes, type CacheEntry } from "../lib/cache/policy";
  import { MARGIN_CHOICES, NAV_CORNER_CHOICES } from "../lib/view-options";
  import { DESTINATIONS } from "../lib/destinations";
  import { DEFAULT_BOTTOM_NAV, moveItem, toggleItem } from "../lib/nav-order";
  import BottomBar from "../components/BottomBar.svelte";
  import { CPU_LEVELS, describeLevel } from "../lib/performance";
import { CONTENT_LEVELS, type ContentLevel } from "../lib/content/levels";
import KeepOfflinePanel from "../components/KeepOfflinePanel.svelte";
import PrivacyPanel from "../components/PrivacyPanel.svelte";

  /**
   * The navigation editor (Layout): the phone bar, the rail and the sidebar.
   *
   * Arrows, not drag-and-drop: one tap moves one place, it works with a keyboard and a screen
   * reader, and the order it writes is the order the bar draws. Every destination is listed, so a
   * page taken off the bar is still here to put back.
   */
  /** What the last edit refused to do — the one case is trying to hide the last visible page. */
  let navNote = $state<string | null>(null);

  const navRows = $derived([
    ...settings.bottomNav,
    ...DESTINATIONS.map((destination) => destination.id).filter((id) => !settings.bottomNav.includes(id)),
  ]);

  function labelOf(id: string): string {
    return DESTINATIONS.find((destination) => destination.id === id)?.label ?? id;
  }

  /** Refused, with a reason, rather than written: an empty bar leaves no way off the page. */
  function toggleNav(id: string): void {
    if (settings.bottomNav.includes(id) && settings.bottomNav.length <= 1) {
      navNote = "Keep at least one page in the bar.";
      return;
    }
    navNote = null;
    settings.set("bottomNav", toggleItem(settings.bottomNav, id, DEFAULT_BOTTOM_NAV));
  }

  function moveNav(id: string, delta: number): void {
    const index = settings.bottomNav.indexOf(id);
    if (index < 0) return;
    settings.set("bottomNav", moveItem(settings.bottomNav, index, delta));
  }

  /**
   * What the bar looks like right now, drawn by the bar itself.
   *
   * This is the whole reason the editor has a picture: an arrow moves a row in a list, and a list of
   * five names in a column does not tell anyone what the phone will show them. Same ids, same
   * mapping and same component as the shell — the picture is the real bar, made inert.
   */
  const previewItems = $derived(
    settings.bottomNav
      .map((id) => DESTINATIONS.find((destination) => destination.id === id))
      .filter((destination) => destination !== undefined),
  );

  const bytes = $derived(
    downloads.bytes < 1024 * 1024
      ? `${(downloads.bytes / 1024).toFixed(0)} KB`
      : downloads.bytes < 1024 * 1024 * 1024
        ? `${(downloads.bytes / 1024 / 1024).toFixed(1)} MB`
        : `${(downloads.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
  );

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

  /**
   * What the app is using, and how much it may use.
   *
   * A webview cannot see the disk, so this is `navigator.storage.estimate()`: the quota the browser
   * grants this origin and what is already in it. It is the honest number for "am I about to run out
   * of room", and it is labelled as such rather than presented as free disk space.
   */
  let space = $state<{ used: number; quota: number } | null>(null);
  let searchCache = $state<{ rows: number; bytes: number } | null>(null);
  let spaceNote = $state<string | null>(null);

  async function refreshSpace(): Promise<void> {
    try {
      const estimate = await navigator.storage?.estimate?.();
      if (estimate !== undefined && typeof estimate.quota === "number" && estimate.quota > 0) {
        space = { used: estimate.usage ?? 0, quota: estimate.quota };
      }
    } catch {
      space = null;
    }
    if (library.profile !== null) searchCache = await library.profile.store.searchCacheSize();
  }

  async function clearSearches(): Promise<void> {
    if (library.profile === null) return;
    const before = searchCache;
    await library.profile.store.clearSearchCache();
    await refreshSpace();
    spaceNote = `Cleared ${before?.rows ?? 0} cached search${(before?.rows ?? 0) === 1 ? "" : "es"} — ${formatBytes(before?.bytes ?? 0)} freed`;
    setTimeout(() => (spaceNote = null), 4000);
  }

  /** The bar's fill, with a floor so a nearly empty disk is a sliver rather than a blank strip. */
  const spacePercent = $derived(space === null || space.quota === 0 ? 0 : Math.max(1.5, Math.min(100, (space.used / space.quota) * 100)));
  const spaceTone = $derived(spacePercent > 92 ? "critical" : spacePercent > 80 ? "warn" : "ok");

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
    void refreshSpace();
    imageCache.setPolicy({ limitBytes: settings.imageCacheLimitMb * 1024 * 1024, cacheImages: settings.cacheImages });
    // The bell's count, and whether there is an account at all. One call, and
    // only when this screen is opened: nothing here fetches on launch.
    void inbox.load();
    // The notice log: what the app said at the top of the screen, newest first. It is read here
    // because the overlay is gone in seconds and "what did that say?" lands on this page.
    void notices.load();
  });

  const pluginCount = $derived(plugins.list.length);

  const link = $derived(info === null ? null : pairingLink(info, token));

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
  /** The age gate is shown, not applied: choosing Adult asks before it shows anything. */
  let ageGate = $state(false);

  function chooseLevel(level: ContentLevel): void {
    if (level === "adult" && !settings.adultDeclared) {
      ageGate = true;
      return;
    }
    settings.set("contentLevel", level);
    ageGate = false;
  }

  function declareAdult(): void {
    settings.set("adultDeclaredAt", Date.now());
    settings.set("adultDeclared", true);
    settings.set("contentLevel", "adult");
    ageGate = false;
  }

  function withdrawAdult(): void {
    settings.set("adultDeclared", false);
    settings.set("adultDeclaredAt", null);
    if (settings.contentLevel === "adult") settings.set("contentLevel", "mature");
  }
</script>

<section class="view">
  <header class="top">
    <PageMenu title="Settings" current="more" />
  </header>

  <!--
    The pages that are not daily tabs, as rows on this page. They used to be rows on a page called
    More that then opened Settings — two presses to reach a control, behind a page named for the
    leftover rather than for what it holds. The rows keep their one-line explanation, because a name
    like "Appearance" does not say what is behind it.
  -->
  <nav class="doors" aria-label="Settings pages">
    <button class="row door" onclick={() => go("/appearance")}>
      <span class="t">Appearance</span>
      <span class="s">Theme, colours, page background</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row door" onclick={() => go("/stats")}>
      <span class="t">Stats</span>
      <span class="s">What you have read, and when</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row door" onclick={() => go("/plugins")}>
      <span class="t">Plugins</span>
      <span class="s">{pluginCount} installed</span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
    <button class="row door sync" onclick={() => go("/sync")}>
      <span class="t">Sync<span class="s">Optional cloud sync · account and subscription</span></span>
      <span class="chev" aria-hidden="true">›</span>
    </button>
  </nav>

  <!-- One page of sections, each of which unfolds where it stands. The General/Trackers tabs made
       the same page dress up as two pages and hid half the settings behind a press; a section that
       opens in place keeps everything one scroll away and nothing needs its own route. -->
  <details class="group" open>
    <summary><h2>Content</h2></summary>
    <div class="row">
      <span>Show sources rated<em class="sub">{CONTENT_LEVELS.find((l) => l.id === settings.contentLevel)?.hint ?? ""}</em></span>
      <div class="chips">
        {#each CONTENT_LEVELS as option (option.id)}
          <button class="chip" class:on={settings.contentLevel === option.id} onclick={() => chooseLevel(option.id)}>
            {option.label}
          </button>
        {/each}
      </div>
    </div>
    {#if ageGate}
      <div class="age">
        <p class="agehead">Adult sources</p>
        <p class="agebody">
          Nothing about them is classified but their own index. Confirm you are 18 or older and they
          will be listed and searchable; the setting is remembered on this device.
        </p>
        <div class="ageacts">
          <button class="btn ghost" onclick={() => (ageGate = false)}>Cancel</button>
          <button class="btn primary" onclick={declareAdult}>I am 18 or older</button>
        </div>
      </div>
    {:else if settings.adultDeclared}
      <div class="row">
        <span>
          Adult sources
          <em class="sub">
            Declared {settings.adultDeclaredAt === null ? "on this device" : `on ${new Date(settings.adultDeclaredAt).toLocaleDateString()}`}.
          </em>
        </span>
        <button class="btn ghost" onclick={withdrawAdult}>Turn off</button>
      </div>
    {/if}
  </details>

  <!--
    One implementation, two doors: the Library page's gear popup draws this same panel, so the
    options a reader changes on the shelf can never drift from the ones listed here.
  -->
  <details class="group" open>
    <summary><h2>Library</h2></summary>
    <LibrarySettingsPanel />
  </details>

  <details class="group" open>
    <summary><h2>Privacy</h2></summary>
    <PrivacyPanel />
  </details>

  <details class="group" open>
    <summary><h2>Keep offline</h2></summary>
    <KeepOfflinePanel />
  </details>

  <details class="group" open>
    <summary><h2>Performance</h2></summary>
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
    <div class="row">
      <span>Back/forward corner<em class="sub">Where the floating back and forward buttons sit on a phone. They only appear when there is history to move through.</em></span>
      <div class="chips">
        {#each NAV_CORNER_CHOICES as choice (choice.id)}
          <button
            class="chip"
            class:on={settings.historyNavCorner === choice.id}
            aria-pressed={settings.historyNavCorner === choice.id}
            onclick={() => settings.set("historyNavCorner", choice.id)}
          >
            {choice.label}
          </button>
        {/each}
      </div>
    </div>
    <!-- Back/forward corner stays here: it places the floating back/forward pair on every page
         that draws one, not only History. History's own pane layout moved into the History panel. -->

    <!--
      The bar and the tabs, above the controls that only change how much room content gets: these
      two change *where the reader can go*, which is the shape of the app rather than its spacing.
    -->
    <div class="navedit">
      <p class="navhead">
        Navigation
        <em class="sub">The pages in the bar, the rail and the sidebar — one order for every layout.</em>
      </p>
      <!--
        The picture comes first: it is the answer to "what did I just do", and it changes under the
        same tap that changed the list, so an arrow reads as a move rather than as a setting.
      -->
      <div class="navpreview">
        <span class="pvlabel">Preview — the phone's bottom menu</span>
        <div class="pvscreen">
          <BottomBar items={previewItems} />
        </div>
      </div>
      {#each navRows as id (id)}
        {@const onBar = settings.bottomNav.includes(id)}
        {@const at = settings.bottomNav.indexOf(id)}
        <div class="row navrow">
          <span class="navlabel">{labelOf(id)}</span>
          <div class="navactions">
            <button
              class="navbtn"
              aria-label={`Move ${labelOf(id)} up`}
              disabled={!onBar || at === 0}
              onclick={() => moveNav(id, -1)}
            >↑</button>
            <button
              class="navbtn"
              aria-label={`Move ${labelOf(id)} down`}
              disabled={!onBar || at === settings.bottomNav.length - 1}
              onclick={() => moveNav(id, 1)}
            >↓</button>
            <button
              class="chip navtoggle"
              aria-pressed={onBar}
              aria-label={`${onBar ? "Hide" : "Show"} ${labelOf(id)} in the navigation`}
              onclick={() => toggleNav(id)}
            >{onBar ? "On bar" : "Off bar"}</button>
          </div>
        </div>
      {/each}
      {#if navNote !== null}
        <p class="navnote" role="status">{navNote}</p>
      {/if}
      <!-- One line, in place of a whole paragraph about reachability. -->
      <p class="hint">The page-title menu always lists every page, so a page taken off the bar is still one tap away on any device.</p>
    </div>

    <h2>Reader</h2>
    <label class="row">
      <span>Reading mode</span>
      <select class="field" value={settings.readerMode} onchange={(event) => settings.set("readerMode", event.currentTarget.value as typeof settings.readerMode)}>
        <option value="vertical">Vertical</option>
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
        <option value="fill">Fill the screen (crops)</option>
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
  </details>

  <!-- The History page's gear popup draws this same panel — one implementation, two doors. -->
  <details class="group" open>
    <summary><h2>History</h2></summary>
    <HistorySettingsPanel />
  </details>

  <details class="group" open>
    <summary><h2>Phone access</h2></summary>
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
        <p class="hint">That link has no token yet — put the server's <code>HARDLYTRACKING_TOKEN</code> on the HT-Server card in Extensions so the phone can call the runtime.</p>
      {/if}
    {:else}
      <p class="hint">Serving on the network, but no network address was found.</p>
    {/if}
    <div class="row">
      <span>
        HT-Server
        <em class="sub">
          {hostValue === "" ? "No host set — this device runs everything itself." : `${hostValue} · ${htServerEnabled() ? "used as a source" : "switched off"}`}
          The address and token live on the HT-Server's own card in Extensions.
        </em>
      </span>
      <button class="chip" onclick={() => go("/extensions")}>Open in Extensions</button>
    </div>
  </details>

  <details class="group" open>
    <summary><h2>Storage</h2></summary>
    <div class="space">
      <div class="spaceline">
        <span>{space === null ? "Reading this device's storage…" : `${formatBytes(space.used)} used of ${formatBytes(space.quota)} this app may use`}</span>
        <span class="muted">{space === null ? "" : `${Math.round(spacePercent)}%`}</span>
      </div>
      <div class="spacebar" aria-hidden="true"><i class={spaceTone} style={`width:${spacePercent}%`}></i></div>
      <p class="sub">Your browser reports what this app may store, not the free space on the disk — a full disk still stops a download before this bar is full.</p>
      {#if spaceNote !== null}<p class="sub note">{spaceNote}</p>{/if}
    </div>
    <div class="row">
      <span>Search results<em class="sub">Answers kept for ten minutes, so a repeated search is instant and works offline.</em></span>
      <span class="muted">{searchCache === null ? "…" : `${searchCache.rows} · ${formatBytes(searchCache.bytes)}`}</span>
    </div>
    <button class="row link" onclick={() => void clearSearches()} disabled={searchCache === null || searchCache.rows === 0}>
      <span>Clear cached searches</span>
      <span class="chev">›</span>
    </button>
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
  </details>

  <details class="group" open>
    <summary><h2>Backup</h2></summary>
    <button class="row link" onclick={() => go("/backup")}>
      <span>Backup &amp; restore</span>
      <span class="chev">›</span>
    </button>
    <p class="hint">Manual backup is free and always available. Automatic sync is a paid extra and never required to read.</p>
  </details>

  {#if inbox.signedIn}
    <!--
      The bell: one small row, drawn only for an account, because a message is
      addressed to one. Nothing pops up when one arrives — the dot and the count
      are the whole of the interruption, and both live here until the page is
      opened, which marks the list read.
    -->
    <section class="group">
      <h2>Messages</h2>
      <button class="row link" onclick={() => go("/messages")}>
        <span class="bellrow">
          <span class="bell" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <path d="M12 4a4.5 4.5 0 0 0-4.5 4.5v3.4L5.5 15h13l-2-3.1V8.5A4.5 4.5 0 0 0 12 4Z" />
              <path d="M9.8 18a2.2 2.2 0 0 0 4.4 0" />
            </svg>
            {#if inbox.unread > 0}<i class="dot"></i>{/if}
          </span>
          Messages
          <em class="sub">
            {inbox.unread > 0 ? `${inbox.unread} unread` : "Notes about the app, your account, or a promotion"}
          </em>
        </span>
        <span class="chev">›</span>
      </button>
    </section>
  {/if}

  <details class="group" open>
    <summary><h2>Trackers</h2></summary>
    <TrackersPanel />
  </details>

  <SyncAccount />

  <section class="notices" aria-label="Notices">
    <header class="nhead">
      <h2>Notices</h2>
      {#if notices.log.length > 0}
        <button class="clear" onclick={() => notices.clearLog()}>Clear</button>
      {/if}
    </header>
    {#if notices.log.length === 0}
      <p class="none">Nothing to report. Anything the app tells you at the top of the screen is kept here.</p>
    {:else}
      <ol class="log">
        {#each notices.log as entry (entry.at + entry.text)}
          <li>
            <span class="when">{noticeTime(entry.at)}</span>
            <span class="what selectable">{entry.text}</span>
          </li>
        {/each}
      </ol>
    {/if}
  </section>

  <p class="about">
    HardlyTracking · a Mihon/Komikku-compatible reader. Your library, history and downloads live on
    this device; sync is optional and paid, the reader is not.
  </p>
</section>

<style>
  .age {
    margin-top: var(--s2);
    padding: var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background: var(--surface-2);
    display: grid;
    gap: var(--s2);
  }

  .agehead {
    margin: 0;
    font-weight: 600;
  }

  .agebody {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
    max-width: 58ch;
  }

  .ageacts {
    display: flex;
    gap: var(--s2);
    flex-wrap: wrap;
  }

  .view {
    padding: var(--s3) var(--s4) var(--s7);
    max-width: 720px;
  }

  .top {
    margin-bottom: var(--s4);
  }

  /* The doors: the pages that are not daily tabs. Same shape as the list the More page drew — name
     on the left, its one-line explanation beside it, chevron on the right — so nothing moved except
     the page it stands on. */
  .doors {
    display: grid;
    margin-bottom: var(--s5);
  }

  .row.door {
    all: unset;
    cursor: pointer;
    display: grid;
    grid-template-columns: 1fr auto auto;
    align-items: center;
    gap: var(--s3);
    padding: var(--s3) var(--s2);
    min-height: 52px;
    box-sizing: border-box;
    border-bottom: 1px solid var(--line);
  }

  .row.door.sync { grid-template-columns: minmax(0, 1fr) auto; }
  .row.door:hover { background: var(--surface-2); }
  .row.door:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }

  .t {
    font-size: var(--t-md);
  }

  .s {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .t .s {
    display: block;
    margin-top: var(--s1);
    overflow-wrap: anywhere;
  }

  .notices {
    margin: var(--s5) 0;
  }

  .nhead {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s3);
    padding-bottom: var(--s2);
    border-bottom: 1px solid var(--line);
  }

  .nhead h2 {
    font-size: var(--t-md);
    font-weight: 600;
    text-transform: none;
    letter-spacing: 0;
    color: inherit;
  }

  .clear {
    all: unset;
    cursor: pointer;
    min-height: 44px;
    padding: 0 var(--s2);
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .none {
    margin: var(--s3) 0 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.6;
  }

  .log {
    list-style: none;
    margin: var(--s2) 0 0;
    padding: 0;
    display: grid;
  }

  .log li {
    display: grid;
    gap: 2px;
    padding: var(--s2) 0;
    border-bottom: 1px solid var(--line);
  }

  .when {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .what {
    font-size: var(--t-sm);
    overflow-wrap: anywhere;
  }

  .about {
    font-size: var(--t-xs);
    color: var(--text-3);
    line-height: 1.7;
    max-width: 52ch;
  }

  .group {
    margin-bottom: var(--s5);
    padding-bottom: var(--s3);
    border-bottom: 1px solid var(--line);
  }

  /* A section header is the handle for its own settings: it opens and closes in place, so the
     page never swaps to a second page for half of itself. The marker is the app's own caret, not
     the platform triangle, so it matches the Library band's fold. */
  summary {
    display: flex;
    align-items: center;
    gap: var(--s2);
    min-height: 44px;
    margin-bottom: var(--s2);
    cursor: pointer;
    list-style: none;
  }

  summary::-webkit-details-marker { display: none; }

  summary::after {
    content: "";
    width: 8px;
    height: 8px;
    margin-left: auto;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(45deg);
    transition: transform 140ms ease;
    color: var(--text-3);
  }

  details:not([open]) > summary::after { transform: rotate(-45deg); }
  summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: var(--r1); }

  h2 {
    margin: 0;
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
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

  /* ---- navigation editors (Layout) -------------------------------------------------------- */
  /* One block per list: a heading in the section-label voice, then a row per item. The rows reuse
     `.row`, so the height and spacing match the toggles above and below them. */
  .navedit {
    display: grid;
    gap: 2px;
    padding: var(--s2) 0 var(--s3);
    border-top: 1px solid var(--line);
  }

  .navhead {
    margin: var(--s2) 0 var(--s1);
    font-size: var(--t-sm);
    font-weight: 600;
    color: var(--text-2);
  }

  .navrow {
    gap: var(--s2);
    min-height: 44px;
  }

  /*
   * The preview is a strip of "phone" the bar sits in: the surface the bar is designed against, its
   * own rounded frame, and enough room under the pill that it reads as floating over a page rather
   * than as a row of chips in a form.
   */
  .navpreview {
    display: grid;
    gap: var(--s1);
    margin-bottom: var(--s2);
  }

  .pvlabel {
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .pvscreen {
    padding: var(--s3) var(--s3) var(--s4);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background:
      radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, var(--accent) 8%, transparent), transparent 70%),
      var(--bg-2, var(--surface));
  }

  .navlabel {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .navactions {
    display: flex;
    align-items: center;
    gap: var(--s1);
    flex: none;
  }

  /* 44 × 44, the same tap target as every other control on this page. */
  .navbtn {
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

  .navbtn:disabled {
    opacity: 0.35;
    cursor: default;
  }

  .navtoggle {
    min-height: 44px;
    min-width: 76px;
  }

  .navnote {
    margin: var(--s1) 0 0;
    font-size: var(--t-xs);
    color: var(--danger, #d9534f);
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

  .space {
    display: grid;
    gap: var(--s2);
    padding: var(--s2) 0 var(--s3);
  }

  .spaceline {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s2);
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  .spacebar {
    height: 8px;
    border-radius: 999px;
    background: var(--surface-2);
    overflow: hidden;
  }

  .spacebar i {
    display: block;
    height: 100%;
    border-radius: 999px;
    background: var(--accent);
  }

  .spacebar i.warn {
    background: #d99a2b;
  }

  .spacebar i.critical {
    background: var(--danger, #d9534f);
  }

  .sub.note {
    color: var(--accent);
    font-style: normal;
  }

  /* The bell row: the glyph sits on the row's own line, the dot on its corner,
     and the count is the `.sub` line every other row already uses. */
  .bellrow {
    display: block;
    position: relative;
    padding-left: 26px;
    text-align: left;
  }

  .bell {
    position: absolute;
    left: 0;
    top: 5px;
    width: 17px;
    height: 17px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }

  .bell svg {
    width: 17px;
    height: 17px;
    fill: none;
    stroke: var(--text-2);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .bell .dot {
    position: absolute;
    top: -1px;
    right: -2px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent);
  }
</style>
