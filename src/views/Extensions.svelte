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
  import { RepositoryError, type Repository } from "../lib/extensions/repository";
  import { extensionLabel, extensionLanguages, sourcesOfExtension } from "../lib/extensions/installed";
  import { proxiedImage } from "../lib/pages";
  import { go, pathTo } from "../lib/nav";
  import { htServerEnabled, hostToken, remoteHost, setHostToken, setRemoteHost } from "../lib/host";
import {
  komgaBaseUrl,
  komgaPassword,
  komgaUsername,
  probeKomga,
  setKomgaEnabled,
  setKomgaSettings,
} from "../lib/komga";

  interface Props {
    /** A repository from an install link (`mihon://…`, `?repo=…`), added on arrival. */
    repo?: string | null;
  }
  let { repo = null }: Props = $props();

  let section = $state<"installed" | "available" | "repositories">("installed");

  let repoUrl = $state("");
  let adding = $state(false);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);

  let entries = $state<ExtensionEntry[]>([]);
  let loading = $state(false);
  let search = $state("");
  let activeRepo = $state<string | null>(null);
  let installing = $state<string | null>(null);
  /** Two-step uninstall: removing an extension is destructive and one stray tap should not do it. */
  let removing = $state<string | null>(null);
  let busy = $state<string | null>(null);
  // The HT-Server's settings belong on its own card: it is a source you point at a machine, and a
  // second copy in Settings would be two places to keep right.
  // ---- Komga ---------------------------------------------------------------
  //
  // Its own card, like the HT-Server: a source you point at a machine. The login is a username and
  // a password, because that is what every Komga client asks for and what a person already has.
  let komgaBase = $state(komgaBaseUrl());
  let komgaUser = $state(komgaUsername());
  let komgaSecret = $state(komgaPassword());
  let komgaProbe = $state<string | null>(null);
  let komgaBusy = $state(false);

  function komgaSaved(): void {
    setKomgaSettings({ baseUrl: komgaBase, username: komgaUser, password: komgaSecret });
    komgaBase = komgaBaseUrl();
    komgaUser = komgaUsername();
    void library.refreshKomga().catch(() => undefined);
  }

  async function testKomga(): Promise<void> {
    const settings = { baseUrl: komgaBase, username: komgaUser, password: komgaSecret };
    komgaBusy = true;
    komgaProbe = null;
    try {
      const probe = await probeKomga(settings);
      komgaProbe = probe.ok
        ? `Signed in${probe.libraries === undefined || probe.libraries.length === 0 ? " — but no libraries are visible to that user" : ` · ${probe.libraries.join(", ")}`}`
        : (probe.error ?? "Komga did not answer");
    } finally {
      komgaBusy = false;
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
      await library.setExtensionEnabled(row.extensionId, row.enabled === false);
      if (row.extensionId === "builtin:komga") await library.refreshKomga();
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

  const matched = $derived.by(() => {
    const needle = search.trim().toLowerCase();
    if (needle === "") return entries;
    return entries.filter((entry) =>
      `${entry.name} ${entry.pkg} ${entry.sources.map((source) => source.lang).join(" ")}`.toLowerCase().includes(needle),
    );
  });

  /** A live repository publishes over a thousand entries; drawing them all is a stall. */
  const shown = $derived(matched.slice(0, 120));

  /**
   * An install link opened this screen: put it in the field, then add it, so the user sees what was
   * added and can correct it if the link was wrong.
   */
  let consumedRepo: string | null = null;
  $effect(() => {
    if (repo === null || repo === consumedRepo) return;
    consumedRepo = repo;
    repoUrl = repo;
    section = "repositories";
    void addRepository();
  });

  async function addRepository(): Promise<void> {
    const url = repoUrl.trim();
    if (url === "") return;
    adding = true;
    error = null;
    notice = null;
    try {
      const repository: Repository = await library.addRepository(url);
      repoUrl = "";
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
    activeRepo = url;
    loading = true;
    error = null;
    try {
      entries = await library.repoEntries(url);
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
  <header class="top">
    <h1>Extensions</h1>
    <span class="count">{installed.length} installed</span>
  </header>

  <div class="tabs" role="tablist" aria-label="Extension sections">
    <button class="chip" class:on={section === "installed"} role="tab" aria-selected={section === "installed"} onclick={() => (section = "installed")}>Installed</button>
    <button class="chip" class:on={section === "available"} role="tab" aria-selected={section === "available"} onclick={() => (section = "available")}>Available</button>
    <button class="chip" class:on={section === "repositories"} role="tab" aria-selected={section === "repositories"} onclick={() => (section = "repositories")}>Repositories</button>
  </div>

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
                <span class="name">{label}</span>
                <span class="sub">
                  {#if row.extensionId === "builtin:ht-server"}
                    <!-- A host is not a source itself: what matters is which machine it is. -->
                    {row.versionName ?? "1.0.0"} · {hostValue === "" ? "no host set" : hostValue}{#if !htServerEnabled()} · paired but off{/if}
                  {:else if row.extensionId === "builtin:komga"}
                    <!-- Same idea: what matters is which server, and whether the login works. -->
                    {row.versionName ?? "1.0.0"} · {komgaBase === "" ? "no server set" : komgaBase}{#if komgaBase !== "" && !row.enabled} · switched off{/if}
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
              <div class="hostform">
                <label>
                  <span>Address</span>
                  <input
                    class="field"
                    type="text"
                    value={komgaBase}
                    placeholder="http://192.168.1.20:25600"
                    spellcheck="false"
                    onchange={(event) => {
                      komgaBase = event.currentTarget.value;
                      komgaSaved();
                    }}
                  />
                </label>
                <label>
                  <span>Username</span>
                  <input
                    class="field"
                    type="text"
                    value={komgaUser}
                    autocomplete="username"
                    spellcheck="false"
                    onchange={(event) => {
                      komgaUser = event.currentTarget.value;
                      komgaSaved();
                    }}
                  />
                </label>
                <label>
                  <span>Password</span>
                  <input
                    class="field"
                    type="password"
                    value={komgaSecret}
                    autocomplete="current-password"
                    onchange={(event) => {
                      komgaSecret = event.currentTarget.value;
                      komgaSaved();
                    }}
                  />
                </label>
                <div class="hosthead">
                  <button class="chip small" disabled={komgaBusy || komgaBase === ""} onclick={() => void testKomga()}>
                    {komgaBusy ? "Asking…" : "Test login"}
                  </button>
                  {#if komgaProbe !== null}<span class="hoststate">{komgaProbe}</span>{/if}
                </div>
                <p class="hint">
                  {#if komgaBase === ""}
                    No server set — Komga's shelves are not offered.
                  {:else if komgaUser === "" || komgaSecret === ""}
                    Add the username and password you sign in to Komga with.
                  {:else if komgaProbe !== null && !komgaProbe.startsWith("Signed in")}
                    Login saved, but it did not work — read the answer above.
                  {:else}
                    Login saved as {komgaUser} · read state syncs both ways
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
              {/if}
            </div>
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
          <button class="chip" class:on={activeRepo === repo.url} onclick={() => void openRepository(repo.url)}>{repo.name}</button>
        {/each}
      </div>

      <input class="field search" type="search" placeholder="Search extensions, packages or languages" bind:value={search} aria-label="Search extensions" />

      {#if loading}
        <p class="empty">Reading the index…</p>
      {:else if entries.length === 0}
        <p class="empty">Pick a repository above to read its index.</p>
      {:else}
        <p class="summary">
          {matched.length === 0 ? "No match" : `${matched.length} extension${matched.length === 1 ? "" : "s"}`}{matched.length > shown.length ? ` · showing ${shown.length}` : ""}
        </p>
        <ul class="rows">
          {#each shown as entry (entry.pkg)}
            {@const state = stateOf(entry)}
            <li class="card">
              <div class="info">
                <span class="name">{entry.name}</span>
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
                  {installing === entry.pkg ? "Installing…" : state === "new" ? "Install" : state === "update" ? "Update" : state === "downgrade" ? "Reinstall" : "Installed"}
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
    <form
      class="add"
      onsubmit={(event) => {
        event.preventDefault();
        void addRepository();
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
      <button class="btn primary" type="submit" disabled={adding}>{adding ? "Reading…" : "Add repository"}</button>
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
            </div>
            <div class="rowacts">
              <button class="btn ghost" onclick={() => { section = "available"; void openRepository(repo.url); }}>Browse</button>
              <button class="btn danger" onclick={() => void remove(repo.url)}>Remove</button>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

<style>
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

  .search {
    width: 100%;
    min-height: 38px;
    margin-bottom: var(--s3);
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
