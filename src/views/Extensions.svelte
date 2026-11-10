<script lang="ts">
  /**
   * Extensions: repositories, what is installed, and what can be installed.
   *
   * Three sections in the order they are used — a repository is where extensions come from, an
   * installed extension is what the runtime is actually running, and "available" is the index
   * narrowed by a search. The runtime's internals (a JVM, an APK handle) stay out of the way: the
   * user installed an extension, not a virtual machine.
   */
  import { library } from "../state/library.svelte";
  import { planUpdates, updateState, type ExtensionEntry } from "../lib/extensions/index";
  import { RepositoryError, loadRepository, type Repository } from "../lib/extensions/repository";
  import { packagesLabel, proposalOf, type RepoProposal } from "../lib/extensions/proposal";
  import { THIRD_PARTY_DECISION, THIRD_PARTY_DISCLOSURE } from "../lib/extensions/disclosure";
  import { filterByLevel, hiddenNotice, levelOfWarning } from "../lib/content/levels";
  import { settings } from "../state/settings.svelte";
  import { REPORT_REASONS, sourceReport, type ReportReason } from "../lib/report/source";
  import { extensionLabel, extensionLanguages, sourcesOfExtension } from "../lib/extensions/installed";
  import { filterEntries, keepLanguages, languageCounts, languagesOf } from "../lib/extensions/browse-filter";
  import ExtensionLanguageSheet from "../components/ExtensionLanguageSheet.svelte";
  import { softwareHref } from "../lib/software";
  import { proxiedImage } from "../lib/pages";
  import { go, pathTo } from "../lib/nav";
  import { htServerEnabled, hostToken, remoteHost, setHostToken, setRemoteHost } from "../lib/host";
  import { setKomgaEnabled } from "../lib/komga";
  import { setSuwayomiEnabled } from "../lib/suwayomi";
  import SuwayomiLogin from "../components/SuwayomiLogin.svelte";
  import KomgaLogin from "../components/KomgaLogin.svelte";
import {
  setWebdavEnabled,
  setWebdavPassword,
  setWebdavUrl,
  setWebdavUsername,
  webdavPassword,
  webdavUrl,
  webdavUsername,
} from "../lib/webdav";
import { probeWebdav } from "../api/webdav";

  interface Props {
    /** A repository from an install link (`mihon://…`, `?repo=…`), added on arrival. */
    repo?: string | null;
  }
  let { repo = null }: Props = $props();

  let section = $state<"installed" | "available" | "repositories">("installed");

  let repoUrl = $state("");
  let adding = $state(false);
  /**
   * A repository that has been read but not added: what the confirmation panel is about.
   *
   * Nothing is stored while this is set. That is the whole point — a link can propose a repository,
   * only a tap can add one.
   */
  let proposal = $state<RepoProposal | null>(null);
  /** The row a report is being written about, if any. Nothing is sent: the report is copied. */
  let reporting = $state<string | null>(null);
  let reportReason = $state<ReportReason>("broken");
  let reportNote = $state("");
  let reportCopied = $state(false);
  /** The report text when the clipboard refused, so it is still readable and selectable. */
  let reportFallback = $state<string | null>(null);
  /** The index that produced the proposal, so Add Repository does not download it twice. */
  let loaded = $state<Repository | null>(null);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  let entries = $state<ExtensionEntry[]>([]);
  let loading = $state(false);
  let search = $state("");
  let activeRepo = $state<string | null>(null);
  /** A repository name is a toggle: a second tap folds its list away instead of refetching it. */
  let collapsed = $state(false);
  /** The chosen source languages. Empty means every language — never "none". */
  let languageFilter = $state<string[]>([]);
  let languageSheet = $state(false);
  let installing = $state<string | null>(null);
  /** Two-step uninstall: removing an extension is destructive and one stray tap should not do it. */
  let removing = $state<string | null>(null);
  let busy = $state<string | null>(null);
  // The HT-Server's settings belong on its own card: it is a source you point at a machine, and a
  // second copy in Settings would be two places to keep right.
  // ---- WebDAV --------------------------------------------------------------
  // The folder, not the server: a WebDAV root lists nothing a reader wants, and asking for a path on
  // every read is worse than asking once. Nothing is downloaded until a book is opened.
  let davUrl = $state(webdavUrl());
  let davUser = $state(webdavUsername());
  let davSecret = $state(webdavPassword());
  let davProbe = $state<string | null>(null);
  let davBusy = $state(false);

  function davSaved(): void {
    setWebdavUrl(davUrl);
    setWebdavUsername(davUser);
    setWebdavPassword(davSecret);
    davUrl = webdavUrl();
    davUser = webdavUsername();
    void library.refreshWebdav().catch(() => undefined);
  }

  async function testDav(): Promise<void> {
    davBusy = true;
    davProbe = null;
    try {
      const probe = await probeWebdav({ url: davUrl, username: davUser, password: davSecret });
      davProbe = probe.message;
    } catch (error) {
      davProbe = error instanceof Error ? error.message : String(error);
    } finally {
      davBusy = false;
    }
  }

  let hostValue = $state(remoteHost());
  let hostTokenValue = $state(hostToken());

  function saveHost(value: string): void {
    setRemoteHost(value);
    hostValue = remoteHost();
    // The provider was built from the old address, so a save that only writes the setting leaves the
    // card saying one thing and Browse another. Re-probe now.
    void library.refreshHost().catch(() => undefined);
  }

  function saveHostToken(value: string): void {
    setHostToken(value);
    hostTokenValue = hostToken();
    void library.refreshHost().catch(() => undefined);
  }

  async function toggle(row: (typeof library.extensions)[number]): Promise<void> {
    busy = row.extensionId;
    try {
      // Komga's switch is a preference read live by the registry, so the row alone would not turn
      // its sources off. Both are written: the row is what the card draws, the preference is what
      // the provider asks.
      if (row.extensionId === "builtin:komga") setKomgaEnabled(row.enabled === false);
      if (row.extensionId === "builtin:suwayomi") setSuwayomiEnabled(row.enabled === false);
      if (row.extensionId === "builtin:webdav") setWebdavEnabled(row.enabled === false);
      await library.setExtensionEnabled(row.extensionId, row.enabled === false);
      if (row.extensionId === "builtin:komga") await library.refreshKomga();
      if (row.extensionId === "builtin:suwayomi") await library.refreshSuwayomi();
      if (row.extensionId === "builtin:webdav") await library.refreshWebdav();
    } finally {
      busy = null;
    }
  }

  async function uninstall(row: (typeof library.extensions)[number]): Promise<void> {
    busy = row.extensionId;
    try {
      await library.uninstallExtension(row.extensionId);
      removing = null;
    } finally {
      busy = null;
    }
  }

  // ---- the PC's extensions -------------------------------------------------
  //
  // The HT-Server card owns them, because they are the host's: its switch, its address, its token and
  // the list it is actually running. Nothing here writes to this device's own list — the two kinds
  // (`htserver:` and `dalvik:`) exist so a phone's extensions and a PC's can never be confused.

  let hostBusy = $state<string | null>(null);
  let hostRemoving = $state<string | null>(null);
  let hostError = $state<string | null>(null);
  let installingOnHost = $state<string | null>(null);

  function hostMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  async function reloadHost(): Promise<void> {
    hostError = null;
    try {
      await library.refreshHost();
    } catch (e) {
      hostError = hostMessage(e);
    }
  }

  async function toggleHost(row: { extensionId: string; enabled?: boolean }): Promise<void> {
    hostBusy = row.extensionId;
    hostError = null;
    try {
      await library.setHostExtensionEnabled(row.extensionId, row.enabled === false);
    } catch (e) {
      hostError = hostMessage(e);
    } finally {
      hostBusy = null;
    }
  }

  /** Build the report from the row, and put it on the clipboard. */
  async function copyReport(row: (typeof library.extensions)[number]): Promise<void> {
    const report = sourceReport(
      {
        name: row.name ?? row.packageId,
        pkg: row.packageId,
        version: row.versionName ?? String(row.versionCode ?? "unknown"),
        repo: row.repoUrl ?? null,
        sources: row.sources.length,
      },
      reportReason,
      reportNote,
    );
    const text = `${report.subject}\n\n${report.body}`;
    try {
      await navigator.clipboard.writeText(text);
      reportCopied = true;
      reportFallback = null;
    } catch {
      // No clipboard in this shell (an unfocused window, a locked-down webview): the report is shown
      // in full instead, so the action still produces something the person can send.
      reportCopied = false;
      reportFallback = text;
    }
  }

  function closeReport(): void {
    reporting = null;
    reportNote = "";
    reportReason = "broken";
    reportCopied = false;
    reportFallback = null;
  }

  async function uninstallHost(row: { extensionId: string }): Promise<void> {
    hostBusy = row.extensionId;
    hostError = null;
    try {
      await library.uninstallHostExtension(row.extensionId);
      hostRemoving = null;
    } catch (e) {
      hostError = hostMessage(e);
    } finally {
      hostBusy = null;
    }
  }

  /** Install one repository entry on the PC instead of this device. */
  async function installOnHost(entry: ExtensionEntry): Promise<void> {
    if (activeRepo === null) return;
    installingOnHost = entry.pkg;
    hostError = null;
    notice = null;
    try {
      const row = await library.installOnHost(entry, activeRepo);
      notice = `${entry.name} ${entry.version} installed on ${remoteHost()} — ${row.sources.length} sources`;
    } catch (e) {
      error = hostMessage(e);
    } finally {
      installingOnHost = null;
    }
  }

  /** A PC source's namespaced id: the registry stores the bare one. */
  function hostSourceId(source: { id: string }): string {
    return source.id.includes(":") ? source.id : `htserver:src:${source.id}`;
  }

  /** The extension's own sources, as the provider lists them — for its browse button. */
  function sourcesFor(row: (typeof library.extensions)[number]) {
    return sourcesOfExtension(library.sources, row);
  }

  // Built-ins first: they are part of the app, not something that was added to it.
  const installed = $derived(
    [...library.extensions].sort((a, b) => Number(b.builtin === true) - Number(a.builtin === true)),
  );

  /** package id -> installed row, so an entry knows whether it is new, current or old. */
  const byPackage = $derived(new Map(installed.map((row) => [row.packageId, row])));

  /**
   * What the content level allows, before the search box.
   *
   * Filtered at the index, not at the row: an entry the level hides must not be findable by typing
   * its name, and must not be installable by URL either.
   */
  const allowed = $derived(
    filterByLevel(entries, (entry) => levelOfWarning(entry.contentWarning), settings.contentLevel, settings.adultDeclared),
  );
  const levelNotice = $derived(hiddenNotice(entries.length - allowed.length, settings.contentLevel));

  /** The languages this index actually publishes in — the sheet is derived, never hardcoded. */
  const languageCodes = $derived(languagesOf(allowed));
  const languageTotals = $derived(languageCounts(allowed));

  /**
   * The rows: filtered, then alphabetical.
   *
   * Alphabetical because this is a catalogue, not a feed — the index's own order is the publisher's,
   * and a reader opening a repository should be able to scan from A without typing anything.
   */
  const matched = $derived(filterEntries(allowed, search, languageFilter));

  /** A live repository publishes over a thousand entries; drawing them all is a stall. */
  const shown = $derived(matched.slice(0, 120));

  /**
   * An install link opened this screen: read the index and *offer* it.
   *
   * It used to add the repository on arrival, which meant a URL somebody else wrote could put
   * third-party code sources into the app with no tap. Now the link fills the field and opens the
   * confirmation panel; `addRepository()` runs only from the panel's own button.
   */
  let consumedRepo: string | null = null;
  $effect(() => {
    if (repo === null || repo === consumedRepo) return;
    consumedRepo = repo;
    repoUrl = repo;
    section = "repositories";
    void inspect(repo);
  });

  /**
   * Opening Available reads a repository without being asked.
   *
   * The section used to arrive empty with "Pick a repository above to read its index", which put a
   * whole extra tap in front of the one thing the screen is for. The first repository is the one the
   * reader added (or the official one seeded with the app), so it opens itself; the chips still switch.
   * Only while nothing is open, so this never fights a repository the reader chose or folded.
   */
  $effect(() => {
    const first = library.repos[0];
    if (section !== "available" || first === undefined || activeRepo !== null || loading) return;
    void openRepository(first.url);
  });

  /** Read a repository index without storing anything, and show what it is. */
  async function inspect(url: string): Promise<void> {
    const target = url.trim();
    if (target === "") return;
    adding = true;
    error = null;
    notice = null;
    try {
      const repository = await loadRepository(target);
      loaded = repository;
      proposal = proposalOf(repository);
    } catch (e) {
      proposal = null;
      loaded = null;
      error = e instanceof RepositoryError && e.tried.length > 0 ? `${e.message} — tried ${e.tried.join(", ")}` : e instanceof Error ? e.message : String(e);
    } finally {
      adding = false;
    }
  }

  /**
   * Store the repository the panel is about.
   *
   * The only caller is the panel's Add Repository button: the index was already read to build the
   * proposal, so it is handed over rather than fetched a second time.
   */
  async function addRepository(): Promise<void> {
    const wanted = proposal;
    if (wanted === null) return;
    adding = true;
    error = null;
    notice = null;
    try {
      const repository: Repository = await library.addRepository(wanted.url, loaded ?? undefined);
      repoUrl = "";
      proposal = null;
      loaded = null;
      notice = `${repository.name} — ${repository.extensions.length} extensions`;
      section = "available";
      await openRepository(repository.url);
    } catch (e) {
      // A repository URL is the user's guess; the error has to say what was tried.
      error = e instanceof RepositoryError && e.tried.length > 0 ? `${e.message} — tried ${e.tried.join(", ")}` : e instanceof Error ? e.message : String(e);
    } finally {
      adding = false;
    }
  }

  async function openRepository(url: string): Promise<void> {
    // Same name, second tap: fold the list away. The entries stay in memory, so unfolding is free.
    if (activeRepo === url) {
      collapsed = !collapsed;
      return;
    }
    activeRepo = url;
    collapsed = false;
    loading = true;
    error = null;
    languageFilter = [];
    try {
      entries = await library.repoEntries(url);
      languageFilter = keepLanguages(languageFilter, entries);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      entries = [];
    } finally {
      loading = false;
    }
  }

  async function install(entry: ExtensionEntry): Promise<void> {
    if (activeRepo === null) return;
    installing = entry.pkg;
    error = null;
    notice = null;
    try {
      const row = await library.installEntry(entry, activeRepo);
      notice = `${entry.name} ${entry.version} installed — ${row.sources.length} sources`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      installing = null;
    }
  }

  async function remove(url: string): Promise<void> {
    await library.removeRepository(url);
    if (activeRepo === url) {
      activeRepo = null;
      entries = [];
    }
  }

  /**
   * Updates, checked across every repository at once.
   *
   * `updateState` already knows how to compare version codes, but it only ran for the repository
   * that happened to be open — so an extension installed months ago looked current until you opened
   * the exact repo it came from. One button asks each repository for its index and answers with the
   * entries that are actually newer. A repository that fails is named, not silently skipped.
   */
  let updates = $state<Map<string, { entry: ExtensionEntry; repoUrl: string }>>(new Map());
  let checking = $state(false);
  let checkNote = $state<string | null>(null);

  async function checkUpdates(): Promise<void> {
    if (library.repos.length === 0) {
      checkNote = "Add a repository first — an update comes from the repository an extension was installed from.";
      return;
    }
    checking = true;
    checkNote = null;
    const found = new Map<string, { entry: ExtensionEntry; repoUrl: string }>();
    const failed: string[] = [];
    for (const repo of library.repos) {
      try {
        const list = await library.repoEntries(repo.url);
        // The comparison itself is pure and tested (`planUpdates`); this loop only fetches.
        for (const update of planUpdates(library.extensions, list, repo.url)) found.set(update.pkg, { entry: update.entry, repoUrl: update.repoUrl });
      } catch (error) {
        failed.push(`${repo.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    updates = found;
    checking = false;
    const bits: string[] = [];
    bits.push(
      found.size === 0
        ? `Everything is up to date — ${library.repos.length} repositor${library.repos.length === 1 ? "y" : "ies"} checked`
        : `${found.size} update${found.size === 1 ? "" : "s"} available`,
    );
    if (failed.length > 0) bits.push(`could not read ${failed.join(" · ")}`);
    checkNote = bits.join(" · ");
  }

  async function updateNow(entry: ExtensionEntry, repoUrl: string): Promise<void> {
    installing = entry.pkg;
    error = null;
    notice = null;
    try {
      const row = await library.installEntry(entry, repoUrl);
      updates = new Map([...updates].filter(([pkg]) => pkg !== entry.pkg));
      notice = `${entry.name} ${entry.version} installed — ${row.sources.length} sources`;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      installing = null;
    }
  }

  /** An installed card's sources, listed on demand — a count does not tell you which sources. */
  let expanded = $state<Set<string>>(new Set());

  function toggleExpanded(extensionId: string): void {
    const next = new Set(expanded);
    if (next.has(extensionId)) next.delete(extensionId);
    else next.add(extensionId);
    expanded = next;
  }

  function stateOf(entry: ExtensionEntry): string {
    const row = byPackage.get(entry.pkg);
    return updateState(row === undefined || row.versionCode === undefined ? undefined : { versionCode: row.versionCode }, entry);
  }

  function languages(entry: ExtensionEntry): string {
    const langs = entry.sources.map((source) => source.lang).filter((lang, index, all) => all.indexOf(lang) === index);
    return langs.join(", ") || "—";
  }
</script>

<section class="view">
  <div class="pin">
  <header class="top">
    <h1>Extensions</h1>
    <span class="count">{installed.length} installed</span>
  </header>

  <div class="tabs" role="tablist" aria-label="Extension sections">
    <button class="chip" class:on={section === "installed"} role="tab" aria-selected={section === "installed"} onclick={() => (section = "installed")}>Installed</button>
    <button class="chip" class:on={section === "available"} role="tab" aria-selected={section === "available"} onclick={() => (section = "available")}>Available</button>
    <button class="chip" class:on={section === "repositories"} role="tab" aria-selected={section === "repositories"} onclick={() => (section = "repositories")}>Repositories</button>
  </div>

  <!--
    Search, and one button for languages. The languages used to be a wrapping row of chips in this
    header; with twenty-odd languages published by a live index that row became four lines and pushed
    the catalogue below the fold, so the filter read as the content and the list read as empty. The
    languages now live in their own scrollable sheet, behind one button that says how many are on.
  -->
  {#if section === "available" && library.repos.length > 0 && !collapsed}
    <div class="searchbar">
      <input class="field search" type="search" placeholder="Search extensions, packages or languages" bind:value={search} aria-label="Search extensions" />
      {#if languageCodes.length > 1}
        <button
          class="chip langbtn"
          class:on={languageFilter.length > 0}
          aria-haspopup="dialog"
          aria-expanded={languageSheet}
          onclick={() => (languageSheet = true)}
        >
          {languageFilter.length === 0 ? "Languages" : languageFilter.length === 1 ? `Language: ${languageFilter[0].toUpperCase()}` : `Languages (${languageFilter.length})`}
        </button>
      {/if}
    </div>
  {/if}
  </div>

  <ExtensionLanguageSheet
    open={languageSheet}
    codes={languageCodes}
    counts={languageTotals}
    selected={languageFilter}
    onclose={() => (languageSheet = false)}
    onchange={(next) => (languageFilter = next)}
  />

  <!-- The line this app has to be clear about: the app is ours, the extensions are not. Same words
       as README.md, "Third-party sources". -->
  <p class="disclosure">
    {THIRD_PARTY_DISCLOSURE}
    <span class="dsub">{THIRD_PARTY_DECISION}</span>
  </p>

  {#if error}<p class="banner">{error}</p>{/if}
  {#if notice}<p class="note">{notice}</p>{/if}

  {#if section === "installed"}
    {#if installed.length === 0}
      <div class="blank">
        <p class="blankline">Nothing installed yet.</p>
        <p class="blanksub">Add a repository, then install an extension from its index. Its sources appear under Browse.</p>
        <button class="btn primary" onclick={() => (section = "repositories")}>Add a repository</button>
      </div>
    {:else}
      <div class="updbar">
        <button class="chip" onclick={() => void checkUpdates()} disabled={checking}>
          {checking ? "Checking…" : "Check for updates"}
        </button>
        {#if checkNote !== null}<span class="updnote">{checkNote}</span>{/if}
      </div>
      <ul class="rows">
        {#each installed as row (row.extensionId)}
          {@const label = extensionLabel(row)}
          {@const langs = extensionLanguages(row)}
          {@const owned = sourcesFor(row)}
          <li class="card" class:off={row.enabled === false}>
            <div class="head">
              {#if row.iconUrl}
                <img class="icon" src={proxiedImage(row.iconUrl)} alt="" loading="lazy" decoding="async" />
              {:else}
                <span class="icon fallback" aria-hidden="true">{label.slice(0, 1)}</span>
              {/if}
              <div class="info">
                {#if row.builtin === true}
                  <span class="name">{label}</span>
                {:else}
                  <!-- The list is the index; the package page is the record. A built-in has no
                       package page: it ships with the app rather than coming from a repository. -->
                  <button
                    class="name link"
                    title={`Open ${label}`}
                    onclick={() => go(softwareHref({ pkg: row.packageId, repo: row.repoUrl ?? null }))}
                  >{label}</button>
                {/if}
                <span class="sub">
                  {#if row.extensionId === "builtin:ht-server"}
                    <!-- A host is not a source itself: what matters is which machine it is. -->
                    {row.versionName ?? "1.0.0"} · {hostValue === "" ? "no host set" : hostValue}{#if !htServerEnabled()} · paired but off{/if}
                  {:else if row.extensionId === "builtin:komga" || row.extensionId === "builtin:suwayomi"}
                    <!-- Same idea: what matters is which server, and whether the login works. -->
                    {row.versionName ?? "1.0.0"} · read state sync{#if !row.enabled} · switched off{/if}
                  {:else}
                    {row.versionName ?? "unknown version"} · {row.sources.length} source{row.sources.length === 1 ? "" : "s"}{#if langs.length > 0} · {langs.join(", ")}{/if}
                  {/if}
                </span>
                {#if row.builtin === true}<span class="badge">Built in</span>{/if}
                {#if row.enabled === false}<span class="badge off">Disabled</span>{/if}
                {#if owned.length > 0}
                  <button class="caret" onclick={() => toggleExpanded(row.extensionId)} aria-expanded={expanded.has(row.extensionId)}>
                    {expanded.has(row.extensionId) ? "▴ hide sources" : `▾ sources (${owned.length})`}
                  </button>
                {/if}
              </div>
              <label class="switch" title={row.enabled === false ? "Enable" : "Disable"}>
                <input
                  type="checkbox"
                  checked={row.enabled !== false}
                  disabled={busy === row.extensionId}
                  aria-label={`${row.enabled === false ? "Enable" : "Disable"} ${label}`}
                  onchange={() => void toggle(row)}
                />
                <span class="track" aria-hidden="true"><span class="knob"></span></span>
              </label>
            </div>

            {#if updates.has(row.packageId)}
              <div class="updrow">
                <span>{updates.get(row.packageId)!.entry.version} is available{row.versionName === undefined ? "" : ` — you have ${row.versionName}`}</span>
                <button
                  class="chip small"
                  disabled={installing === row.packageId}
                  onclick={() => void updateNow(updates.get(row.packageId)!.entry, updates.get(row.packageId)!.repoUrl)}
                >
                  {installing === row.packageId ? "Installing…" : "Update"}
                </button>
              </div>
            {/if}

            {#if expanded.has(row.extensionId) && owned.length > 0}
              <div class="srcrow">
                {#each owned as source (source.id)}
                  <button class="chip small link" title={`Browse ${source.name}`} onclick={() => go(pathTo("source", source.id))}>
                    {source.name}{#if source.lang}<span class="lang">{source.lang}</span>{/if}
                  </button>
                {/each}
              </div>
            {/if}

            {#if row.extensionId === "builtin:komga"}
              <KomgaLogin onchange={() => library.refreshKomga()} />
            {:else if row.extensionId === "builtin:suwayomi"}
              <SuwayomiLogin onchange={() => library.refreshSuwayomi()} />
            {/if}

            {#if row.extensionId === "builtin:webdav"}
              <div class="hostform">
                <label>
                  <span>Folder</span>
                  <input
                    class="field"
                    type="text"
                    value={davUrl}
                    placeholder="https://cloud.example.com/remote.php/dav/files/me/Comics"
                    spellcheck="false"
                    onchange={(event) => {
                      davUrl = event.currentTarget.value;
                      davSaved();
                    }}
                  />
                </label>
                <label>
                  <span>Username</span>
                  <input
                    class="field"
                    type="text"
                    value={davUser}
                    autocomplete="username"
                    spellcheck="false"
                    onchange={(event) => {
                      davUser = event.currentTarget.value;
                      davSaved();
                    }}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    class="field"
                    type="password"
                    value={davSecret}
                    autocomplete="current-password"
                    onchange={(event) => {
                      davSecret = event.currentTarget.value;
                      davSaved();
                    }}
                  />
                </label>
                <div class="hosthead">
                  <button
                    class="chip small"
                    disabled={davBusy || davUrl === "" || davUser === ""}
                    onclick={() => void testDav()}
                  >
                    {davBusy ? "Asking…" : "Test folder"}
                  </button>
                  {#if davProbe !== null}<span class="hoststate">{davProbe}</span>{/if}
                </div>
                <p class="hint">
                  {#if davUrl === ""}
                    No folder set — its comics are not offered. Works with Nextcloud, ownCloud, a NAS or
                    any WebDAV share.
                  {:else if davUser === "" || davSecret === ""}
                    Add the username and password you sign in to that server with.
                  {:else if davProbe !== null && !davProbe.includes("comic")}
                    Saved, but that folder did not answer — read the line above.
                  {:else}
                    Listing a folder costs one request; a book is downloaded the first time you open it
                    and read from this device after that.
                  {/if}
                </p>
              </div>
            {/if}

            {#if row.extensionId === "builtin:ht-server"}
              <div class="hostform">
                <label>
                  <span>Address</span>
                  <input
                    class="field"
                    type="text"
                    value={hostValue}
                    placeholder="http://192.168.1.20:8460"
                    spellcheck="false"
                    onchange={(event) => saveHost(event.currentTarget.value)}
                  />
                </label>
                <label>
                  <span>Token</span>
                  <input
                    class="field"
                    type="text"
                    value={hostTokenValue}
                    placeholder="optional"
                    spellcheck="false"
                    onchange={(event) => saveHostToken(event.currentTarget.value)}
                  />
                </label>
                <p class="hint">
                  {hostValue === ""
                    ? "No host set — this device runs everything itself."
                    : `${hostValue} · ${htServerEnabled() ? "used as a source" : "switched off"}`}
                </p>
              </div>

              {#if hostValue !== "" && htServerEnabled()}
                <div class="hostext">
                  <div class="hosthead">
                    <span class="hosttitle">On the PC</span>
                    <span class="hoststate">
                      {#if library.htServer === null}
                        not answering
                      {:else}
                        {library.hostExtensions.length} extension{library.hostExtensions.length === 1 ? "" : "s"}
                      {/if}
                    </span>
                    <button class="chip small" onclick={() => void reloadHost()}>Reload</button>
                  </div>

                  {#if library.htServer === null}
                    <p class="hint">
                      Nothing answered at {hostValue}. Start HardlyTracking there with <code>npm run serve</code>, check the
                      address, and check the token — this device's sources keep working either way.
                    </p>
                  {:else if library.hostExtensions.length === 0}
                    <p class="hint">
                      Nothing is installed on the PC yet. Install one from Available and it lands there, marked “on the PC”.
                    </p>
                  {:else}
                    <ul class="hostrows">
                      {#each library.hostExtensions as ext (ext.extensionId)}
                        {@const label = extensionLabel(ext)}
                        <li class="hostrow" class:off={ext.enabled === false}>
                          <div class="info">
                            <span class="name">{label}</span>
                            <span class="sub">
                              {ext.versionName ?? "unknown version"} · {ext.sources.length} source{ext.sources.length === 1 ? "" : "s"}
                              {#if ext.enabled === false}<span class="warn"> · off</span>{/if}
                            </span>
                          </div>
                          <label class="switch" title={ext.enabled === false ? `Enable ${label} on the PC` : `Disable ${label} on the PC`}>
                            <input
                              type="checkbox"
                              checked={ext.enabled !== false}
                              disabled={hostBusy === ext.extensionId}
                              aria-label={`${ext.enabled === false ? "Enable" : "Disable"} ${label} on the PC`}
                              onchange={() => void toggleHost(ext)}
                            />
                            <span class="track" aria-hidden="true"><span class="knob"></span></span>
                          </label>
                          {#if hostRemoving === ext.extensionId}
                            <span class="confirm">
                              <button class="chip small" onclick={() => (hostRemoving = null)}>Cancel</button>
                              <button
                                class="chip small danger"
                                disabled={hostBusy === ext.extensionId}
                                onclick={() => void uninstallHost(ext)}
                              >Uninstall on PC</button>
                            </span>
                          {:else}
                            <button class="chip small" onclick={() => (hostRemoving = ext.extensionId)}>Uninstall</button>
                          {/if}
                        </li>
                      {/each}
                    </ul>
                    <div class="srcs hostsrcs">
                      {#each library.hostExtensions.flatMap((ext) => ext.sources).slice(0, 8) as source (source.id)}
                        <button class="chip small link" title={`Browse ${source.name} on the PC`} onclick={() => go(pathTo("source", hostSourceId(source)))}>
                          {source.name}{#if source.lang} <span class="lang">{source.lang}</span>{/if}
                        </button>
                      {/each}
                    </div>
                  {/if}
                  {#if hostError}<p class="banner">{hostError}</p>{/if}
                </div>
              {/if}
            {/if}

            <div class="srcs">
              {#each row.sources.slice(0, 8) as source (source.id)}
                <button
                  class="chip small link"
                  title={`Browse ${source.name}`}
                  onclick={() => go(pathTo("source", source.id.includes(":") ? source.id : `dalvik:src:${source.id}`))}
                >
                  {source.name}{#if source.lang} <span class="lang">{source.lang}</span>{/if}
                </button>
              {/each}
              {#if row.sources.length > 8}<span class="chip small">+{row.sources.length - 8}</span>{/if}
            </div>

            <div class="acts">
              {#if owned.length > 0}
                <button class="btn ghost" onclick={() => go(pathTo("source", owned[0].id))}>Browse</button>
              {/if}
              {#if row.builtin === true}
                <span class="confirm">Ships with HardlyTracking — no APK, so there is nothing to uninstall.</span>
              {:else if removing === row.extensionId}
                <span class="confirm">
                  <span>Uninstall {label}? Its {row.sources.length} source{row.sources.length === 1 ? "" : "s"} disappear; your library stays.</span>
                  <button class="chip" onclick={() => (removing = null)}>Cancel</button>
                  <button class="chip danger" disabled={busy === row.extensionId} onclick={() => void uninstall(row)}>Uninstall</button>
                </span>
              {:else}
                <button class="btn ghost quiet" onclick={() => (removing = row.extensionId)}>Uninstall</button>
                <button class="btn ghost quiet" onclick={() => (reporting === row.extensionId ? closeReport() : (reporting = row.extensionId))}>Report</button>
              {/if}
            </div>

            {#if reporting === row.extensionId}
              <!-- 4.7.3 asks for a way to flag software that turns out to be objectionable. The
                   report is built from the row and copied; nothing is sent, and the screen says so. -->
              <div class="report" role="group" aria-label="Report this source">
                <p class="rq">Report {label}</p>
                <div class="chips">
                  {#each REPORT_REASONS as reason (reason.id)}
                    <button class="chip" class:on={reportReason === reason.id} onclick={() => (reportReason = reason.id)}>
                      {reason.label}
                    </button>
                  {/each}
                </div>
                <textarea class="field" rows="3" placeholder="What happened? (optional)" bind:value={reportNote} aria-label="What happened"></textarea>
                <div class="racts">
                  <button class="btn ghost" onclick={closeReport}>Cancel</button>
                  <button class="btn primary" onclick={() => void copyReport(row)}>{reportCopied ? "Copied" : "Copy report"}</button>
                </div>
                {#if reportFallback !== null}
                  <pre class="rtext selectable">{reportFallback}</pre>
                {/if}
                <p class="rhint">Nothing is sent anywhere. The report names the package, its version and its repository, and is copied so you can send it where you like.</p>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {:else if section === "available"}
    {#if library.repos.length === 0}
      <div class="blank">
        <p class="blankline">No repositories yet.</p>
        <p class="blanksub">A repository is one URL that lists extensions. Add it once and every extension in it is one tap away.</p>
        <button class="btn primary" onclick={() => (section = "repositories")}>Add a repository</button>
      </div>
    {:else}
      <div class="repo-bar">
        {#each library.repos as repo (repo.url)}
          <button
            class="chip"
            class:on={activeRepo === repo.url && !collapsed}
            aria-expanded={activeRepo === repo.url ? !collapsed : false}
            title={activeRepo === repo.url && !collapsed ? `Hide ${repo.name}'s extensions` : `Show ${repo.name}'s extensions`}
            onclick={() => void openRepository(repo.url)}
          >{repo.name}</button>
        {/each}
      </div>

      {#if loading}
        <p class="empty">Reading the index…</p>
      {:else if collapsed}
        <!-- Folded by its own repository chip: the names above are the whole section. -->
      {:else if entries.length === 0}
        <p class="empty">Pick a repository above to read its index.</p>
      {:else}
        <p class="summary">
          {matched.length === 0 ? "No match" : `${matched.length} extension${matched.length === 1 ? "" : "s"}`}{matched.length > shown.length ? ` · showing ${shown.length}` : ""}
        </p>
        {#if levelNotice !== null}
          <p class="levelnote">{levelNotice}</p>
        {/if}
        <ul class="rows">
          {#each shown as entry (entry.pkg)}
            {@const state = stateOf(entry)}
            <li class="card">
              <div class="info">
                <!-- The list is the index; the package page is the record — what it is, before the
                     Install button next to it is pressed. -->
                <button
                  class="name link"
                  title={`Open ${entry.name}`}
                  onclick={() => go(softwareHref({ pkg: entry.pkg, repo: activeRepo }))}
                >{entry.name}</button>
                <span class="sub">
                  {languages(entry)} · v{entry.version}
                  {#if entry.contentWarning !== "SAFE" && entry.contentWarning !== "UNKNOWN"}<span class="warn"> · {entry.contentWarning}</span>{/if}
                </span>
                <span class="pkg">{entry.pkg}</span>
              </div>
              <div class="rowacts">
                <button
                  class="btn"
                  class:primary={state === "new" || state === "update"}
                  disabled={installing === entry.pkg || state === "up-to-date"}
                  onclick={() => void install(entry)}
                >
                  {installing === entry.pkg ? (library.extensionHostStarting ? "Starting runtime…" : "Installing…") : state === "new" ? "Install" : state === "update" ? "Update" : state === "downgrade" ? "Reinstall" : "Installed"}
                </button>
                {#if library.htServer !== null}
                  <!-- A second, separate list: the PC's extensions are the PC's, and installing there
                       must not touch what this device runs. -->
                  <button
                    class="btn ghost"
                    disabled={installingOnHost === entry.pkg}
                    title={`Install ${entry.name} on ${remoteHost()}`}
                    onclick={() => void installOnHost(entry)}
                  >
                    {installingOnHost === entry.pkg ? "Sending…" : "On PC"}
                  </button>
                {/if}
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  {:else}
    {#if proposal !== null}
      <!-- A repository is third-party code. It is offered here, with what it is and who serves it,
           and it is stored only when this button is pressed. -->
      <div class="proposal" role="group" aria-label="Add repository">
        <h2>Add Repository?</h2>
        <p class="pname">{proposal.name}</p>
        <p class="pmeta">{proposal.host} · {proposal.ecosystemLabel} · {packagesLabel(proposal.packages)}</p>
        <p class="purl mono selectable">{proposal.indexUrl}</p>
        <p class="pnotice">{proposal.notice}</p>
        <div class="pacts">
          <button class="btn ghost" onclick={() => { proposal = null; loaded = null; }}>Cancel</button>
          <button class="btn primary" disabled={adding} onclick={() => void addRepository()}>
            {adding ? "Adding…" : "Add Repository"}
          </button>
        </div>
      </div>
    {/if}

    <form
      class="add"
      onsubmit={(event) => {
        event.preventDefault();
        void inspect(repoUrl);
      }}
    >
      <input
        class="field"
        type="text"
        inputmode="url"
        placeholder="Repository URL, or an Install link (mihon://extension-store?url=…)"
        bind:value={repoUrl}
        aria-label="Repository URL or install link"
        spellcheck="false"
      />
      <button class="btn primary" type="submit" disabled={adding}>{adding ? "Reading…" : "Check repository"}</button>
    </form>

    {#if library.repos.length === 0}
      <p class="empty">No repositories yet. A Keiyoushi-compatible URL is the usual starting point.</p>
    {:else}
      <ul class="rows">
        {#each library.repos as repo (repo.url)}
          <li class="card">
            <div class="info">
              <span class="name">{repo.name}</span>
              <span class="sub">{repo.url}</span>
              {#if repo.pinned === true}
                <span class="sub">Ships with HardlyTracking — its extensions update from here, so the repository itself cannot be removed.</span>
              {/if}
            </div>
            <div class="rowacts">
              <button class="btn ghost" onclick={() => { section = "available"; void openRepository(repo.url); }}>Browse</button>
              {#if repo.pinned === true}
                <span class="badge">Official</span>
              {:else}
                <button class="btn danger" onclick={() => void remove(repo.url)}>Remove</button>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
  .disclosure {
    margin: 0 var(--s3) var(--s3);
    padding: var(--s2) var(--s3);
    border-left: 2px solid var(--line);
    font-size: var(--t-xs);
    line-height: 1.5;
    color: var(--text-2);
    max-width: 68ch;
  }

  .dsub {
    display: block;
    margin-top: var(--s1);
    color: var(--text-3);
  }

  .report {
    display: grid;
    gap: var(--s2);
    margin-top: var(--s2);
    padding: var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background: var(--surface-2);
  }

  .rq {
    margin: 0;
    font-weight: 600;
  }

  .racts {
    display: flex;
    gap: var(--s2);
    flex-wrap: wrap;
  }

  .rtext {
    margin: 0;
    padding: var(--s2);
    border-radius: var(--r2);
    background: var(--surface);
    font-size: var(--t-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .rhint {
    margin: 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    max-width: 60ch;
  }

  .levelnote {
    margin: 0 0 var(--s2);
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .proposal {
    display: grid;
    gap: var(--s1);
    padding: var(--s3);
    margin-bottom: var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r3);
    background: var(--surface-2);
  }

  .proposal h2 {
    font-size: var(--t-xs);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-3);
    margin: 0;
  }

  .pname {
    margin: 0;
    font-size: var(--t-lg);
    font-weight: 600;
  }

  .pmeta {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  .purl {
    margin: 0;
    font-size: var(--t-xs);
    color: var(--text-3);
    overflow-wrap: anywhere;
  }

  .pnotice {
    margin: var(--s2) 0 0;
    font-size: var(--t-sm);
    color: var(--text-2);
    max-width: 60ch;
  }

  .pacts {
    display: flex;
    gap: var(--s2);
    margin-top: var(--s2);
    flex-wrap: wrap;
  }

  .hostform {
    display: grid;
    gap: var(--s1);
    padding: var(--s2) 0 var(--s1);
  }

  .hostform label {
    display: grid;
    grid-template-columns: 80px 1fr;
    align-items: center;
    gap: var(--s2);
    font-size: var(--t-sm);
  }

  .hostform .field {
    min-height: 32px;
  }

  .hostform .hint {
    margin: 0;
    color: var(--text-3);
    font-size: var(--t-xs);
  }

  /* The PC's own extensions: a list inside the HT-Server card, because they belong to that machine
     and to no other part of this app. */
  .hostext {
    display: grid;
    gap: var(--s2);
    padding-top: var(--s2);
    border-top: 1px solid var(--line);
  }

  .hosthead {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
  }

  .hosttitle {
    font-size: var(--t-sm);
    font-weight: 600;
  }

  .hoststate {
    flex: 1;
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .hostext .hint {
    margin: 0;
    font-size: var(--t-xs);
    line-height: 1.5;
    color: var(--text-3);
  }

  .hostext code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px;
  }

  .hostrows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s1);
  }

  .hostrow {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding: var(--s1) 0;
  }

  .hostrow.off {
    opacity: 0.62;
  }

  .hostsrcs {
    display: flex;
    max-width: none;
  }

  .view {
    padding: var(--s4) var(--s4) var(--s7);
    max-width: 900px;
  }

  .top {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--s3);
    margin-bottom: var(--s3);
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
  }

  .count {
    font-size: var(--t-sm);
    color: var(--text-3);
  }

  .tabs {
    display: flex;
    gap: var(--s2);
    margin-bottom: var(--s4);
    overflow-x: auto;
  }

  .add {
    display: flex;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }

  .add .field {
    flex: 1;
    min-height: 40px;
  }

  .repo-bar {
    display: flex;
    gap: var(--s2);
    overflow-x: auto;
    margin-bottom: var(--s3);
  }

  .updbar {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: var(--s2);
    margin-bottom: var(--s2);
  }

  .updnote {
    font-size: var(--t-xs);
    color: var(--text-2);
  }

  .updrow {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin: 0 0 var(--s2);
    padding: var(--s2) var(--s3);
    border-radius: var(--r2);
    background: var(--surface-2);
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  .updrow span {
    margin-right: auto;
  }

  .caret {
    all: unset;
    cursor: pointer;
    margin-top: var(--s1);
    padding: 3px 8px;
    border: 1px solid var(--line);
    border-radius: 999px;
    font-size: var(--t-xs);
    color: var(--text-2);
  }

  .caret:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  .srcrow {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    margin: 0 0 var(--s2);
  }

  /* The shared .view > .pin owns sticky positioning and the status-bar inset once. */
  .pin { padding-bottom: var(--s3); display: grid; gap: var(--s2); min-width: 0; }
  /* Search takes the row; the language button keeps its own width beside it. */
  .searchbar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    min-width: 0;
  }

  .langbtn {
    flex: none;
    min-height: 40px;
    white-space: nowrap;
  }

  .search {
    width: 100%;
    min-width: 0;
    min-height: 40px;
    margin: 0;
  }

  .summary {
    margin: 0 0 var(--s2);
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .rows {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: var(--s2);
  }

  .card {
    display: grid;
    gap: var(--s2);
    padding: var(--s3);
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: var(--surface);
  }

  .card.off {
    opacity: 0.62;
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--s3);
  }

  .icon {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    object-fit: cover;
    flex: none;
    background: var(--surface-2, var(--surface));
  }

  .icon.sm {
    width: 28px;
    height: 28px;
    border-radius: 8px;
  }

  .icon.fallback {
    display: grid;
    place-items: center;
    font-weight: 650;
    color: var(--text-3);
    border: 1px solid var(--line);
  }

  .switch {
    flex: none;
    display: grid;
    place-items: center;
    cursor: pointer;
  }

  .switch input {
    position: absolute;
    opacity: 0;
    width: 1px;
    height: 1px;
  }

  .track {
    width: 42px;
    height: 25px;
    border-radius: 999px;
    background: var(--line);
    display: block;
    position: relative;
    transition: background 140ms ease;
  }

  .knob {
    position: absolute;
    top: 3px;
    left: 3px;
    width: 19px;
    height: 19px;
    border-radius: 999px;
    background: var(--text-3);
    transition: transform 140ms ease, background 140ms ease;
  }

  .switch input:checked + .track {
    background: color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .switch input:checked + .track .knob {
    transform: translateX(17px);
    background: var(--accent);
  }

  .switch input:focus-visible + .track {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .badge.off {
    justify-self: start;
    font-size: var(--t-xs);
    color: var(--text-3);
    border: 1px solid var(--line);
    border-radius: 999px;
    padding: 1px 8px;
  }

  .chip.link {
    cursor: pointer;
  }

  .chip.link:hover {
    color: var(--accent);
  }

  .acts {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
  }

  .btn.quiet {
    color: var(--text-3);
  }

  .btn.quiet:hover {
    color: var(--danger, #d9534f);
  }

  .chip.danger {
    color: var(--danger, #d9534f);
    border-color: currentColor;
  }

  .confirm {
    display: flex;
    align-items: center;
    gap: var(--s2);
    flex-wrap: wrap;
    font-size: var(--t-xs);
    color: var(--text-3);
  }

  .info {
    display: grid;
    gap: 1px;
    min-width: 0;
    flex: 1;
  }

  .name {
    font-size: var(--t-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A package name is the way into its page; it has to look like the text it replaced. */
  .name.link {
    all: unset;
    cursor: pointer;
    font-size: var(--t-md);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name.link:hover {
    color: var(--accent);
  }

  .sub,
  .pkg {
    font-size: var(--t-xs);
    color: var(--text-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .pkg {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--text-3);
    opacity: 0.75;
  }

  .warn {
    color: var(--warning);
  }

  .lang {
    text-transform: uppercase;
    font-size: 10px;
    color: var(--text-3);
  }

  .chip.small {
    padding: 2px var(--s2);
    font-size: var(--t-xs);
  }

  .srcs {
    display: none;
    gap: var(--s1);
    flex-wrap: wrap;
  }

  @media (min-width: 760px) {
    .srcs {
      display: flex;
      max-width: 260px;
    }
  }

  .rowacts {
    display: flex;
    gap: var(--s1);
  }

  .blank {
    display: grid;
    gap: var(--s2);
    padding-top: var(--s5);
    max-width: 48ch;
    justify-items: start;
  }

  .blankline {
    margin: 0;
    font-size: var(--t-lg);
  }

  .blanksub {
    margin: 0;
    font-size: var(--t-sm);
    line-height: 1.6;
    color: var(--text-2);
  }
</style>
