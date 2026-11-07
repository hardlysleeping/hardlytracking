<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    KOMGA_MAX_SERVERS,
    addKomgaServer,
    fetchKomgaLibraries,
    komgaServerConfigured,
    komgaServers,
    probeKomga,
    removeKomgaServer,
    setKomgaServerEnabled,
    setKomgaServerLibrary,
    updateKomgaServer,
    type KomgaLibrary,
    type KomgaServer,
  } from "../lib/komga";

  let { onchange }: { onchange: () => Promise<void> } = $props();

  let servers = $state<KomgaServer[]>([]);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  /** The id whose Test button is running, so one row cannot disable the rest. */
  let testing = $state<string | null>(null);
  /** What each server's last test said, keyed by server id. */
  let results = $state<Record<string, string>>({});
  /**
   * The libraries each server reports, for its aggregate source's picker.
   *
   * Read when the card draws the row, not at app boot: a settings card is the only thing that needs
   * the list, and a server that is off should not hold up a library load.
   */
  let libraries = $state<Record<string, { status: "loading" | "ok" | "error"; items: KomgaLibrary[]; error?: string }>>({});

  let dialogOpen = $state(false);
  /** The entry being edited, or `null` for a new one. */
  let editing = $state<KomgaServer | null>(null);
  let label = $state("");
  let address = $state("");
  let username = $state("");
  let password = $state("");
  let busy = $state(false);
  let formError = $state<string | null>(null);
  let dialog: HTMLDialogElement;
  /** Closing or cancelling bumps this, so an abandoned probe can never save afterwards. */
  let generation = 0;

  const headingId = "komga-servers-heading";

  /** The library list for one row, read once and kept until the row changes or is removed. */
  function loadLibraries(server: KomgaServer): void {
    const known = libraries[server.id];
    // A failed read retries on the next reload (an edit or a toggle); a good one is kept.
    if (known?.status === "loading" || known?.status === "ok") return;
    if (!komgaServerConfigured(server)) {
      libraries = {
        ...libraries,
        [server.id]: { status: "error", items: [], error: "Add a login to choose a library." },
      };
      return;
    }
    libraries = { ...libraries, [server.id]: { status: "loading", items: [] } };
    void fetchKomgaLibraries(server).then((result) => {
      // The row can be removed while the request is in flight; a late answer must not resurrect it.
      if (!servers.some((row) => row.id === server.id)) return;
      libraries = {
        ...libraries,
        [server.id]: result.ok
          ? { status: "ok", items: result.libraries ?? [] }
          : { status: "error", items: [], error: result.error ?? "Komga did not answer." },
      };
    });
  }

  function reload(): void {
    servers = komgaServers();
    const ids = new Set(servers.map((server) => server.id));
    libraries = Object.fromEntries(Object.entries(libraries).filter(([id]) => ids.has(id)));
    for (const server of servers) loadLibraries(server);
  }

  onMount(reload);

  async function refresh(): Promise<void> {
    try {
      await onchange();
    } catch {
      notice = "Saved, but the sources could not be refreshed yet.";
    }
  }

  async function openNew(): Promise<void> {
    error = null;
    notice = null;
    // The limit is enforced in `addKomgaServer` too; this is the same refusal said where the
    // button is, instead of a button that quietly does nothing.
    if (servers.length >= KOMGA_MAX_SERVERS) {
      error = `HardlyTracking supports ${KOMGA_MAX_SERVERS} Komga servers. Remove one before adding another.`;
      return;
    }
    editing = null;
    label = `Komga ${servers.length + 1}`;
    address = "";
    username = "";
    password = "";
    formError = null;
    await showDialog();
  }

  async function openEdit(server: KomgaServer): Promise<void> {
    error = null;
    notice = null;
    editing = server;
    label = server.label;
    address = server.baseUrl;
    username = server.username;
    // Blank means "keep the saved password": it is never rendered back into the field.
    password = "";
    formError = null;
    await showDialog();
  }

  async function showDialog(): Promise<void> {
    dialogOpen = true;
    // Mount the fields before native dialog focus management chooses its first control.
    await tick();
    if (dialogOpen && dialog.isConnected) dialog.showModal();
  }

  function close(): void {
    generation++;
    dialogOpen = false;
    busy = false;
    formError = null;
    password = "";
    dialog.close();
  }

  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const attempt = ++generation;
    const server = editing;
    const effectivePassword = password === "" && server !== null ? server.password : password;
    const login = { baseUrl: address.trim(), username: username.trim(), password: effectivePassword };
    busy = true;
    formError = null;
    try {
      // Persist only after the login proves itself, the rule the single-server card had: a saved
      // address that 401s reads as a broken source.
      const probe = await probeKomga(login);
      // Closing the prompt or leaving the page must never save an abandoned login.
      if (attempt !== generation) return;
      if (!probe.ok) {
        formError = probe.error ?? "Komga did not answer. Try again.";
        password = "";
        return;
      }
      const saved =
        server === null
          ? addKomgaServer({ ...login, label })
          : updateKomgaServer(server.id, { ...login, label });
      if (attempt !== generation) return;
      if (!saved.ok) {
        formError = saved.error ?? "Could not save that server.";
        return;
      }
      reload();
      if (probe.libraries?.length === 0) notice = "Signed in, but no libraries are visible to that account.";
      close();
      void refresh();
    } catch {
      if (attempt === generation) formError = "Could not complete the sign in. Try again.";
    } finally {
      if (attempt === generation) busy = false;
    }
  }

  async function test(server: KomgaServer): Promise<void> {
    testing = server.id;
    results = { ...results, [server.id]: "Testing…" };
    try {
      const probe = await probeKomga(server);
      results = {
        ...results,
        [server.id]: probe.ok
          ? probe.libraries?.length === 0
            ? "Signed in, but no libraries are visible to this account."
            : `Signed in — ${probe.libraries?.join(", ") ?? "no libraries reported"}.`
          : probe.error ?? "Komga did not answer.",
      };
    } finally {
      testing = null;
    }
  }

  function toggle(server: KomgaServer, enabled: boolean): void {
    setKomgaServerEnabled(server.id, enabled);
    reload();
    void refresh();
  }

  /** The picker's rows: what the server reports, plus a saved id it no longer lists. */
  function libraryOptions(server: KomgaServer): KomgaLibrary[] {
    const items = libraries[server.id]?.items ?? [];
    if (server.libraryId !== undefined && !items.some((library) => library.id === server.libraryId)) {
      return [...items, { id: server.libraryId, name: "Saved library (not listed)" }];
    }
    return items;
  }

  /** All changes the aggregate source only; the per-library sources are untouched. */
  function chooseLibrary(server: KomgaServer, libraryId: string): void {
    setKomgaServerLibrary(server.id, libraryId === "" ? undefined : libraryId);
    reload();
    void refresh();
  }

  function remove(server: KomgaServer): void {
    removeKomgaServer(server.id);
    const { [server.id]: _gone, ...kept } = results;
    results = kept;
    error = null;
    reload();
    void refresh();
  }
</script>

<div class="komga">
  <div class="head">
    <span class="count">{servers.length} of {KOMGA_MAX_SERVERS} servers</span>
    <button class="chip small" onclick={openNew}>Add server</button>
  </div>

  {#if servers.length === 0}
    <p class="hint">No Komga server yet. Add up to {KOMGA_MAX_SERVERS} — two logins on the same address give you two separate sets of libraries.</p>
  {/if}

  {#each servers as server (server.id)}
    <div class="server">
      <div class="who">
        <span class="name">{server.label}</span>
        <span class="addr">{server.baseUrl}</span>
      </div>
      <div class="controls">
        <label class="switch">
          <input type="checkbox" checked={server.enabled} onchange={(event) => toggle(server, event.currentTarget.checked)} />
          <span>{server.enabled ? "On" : "Off"}</span>
        </label>
        <button class="chip small" disabled={testing === server.id} onclick={() => void test(server)}>
          {testing === server.id ? "Testing…" : "Test"}
        </button>
        <button class="chip small" onclick={() => void openEdit(server)}>Edit</button>
        <button class="chip small" onclick={() => remove(server)}>Remove</button>
      </div>
      <div class="picker">
        <label>
          <span>Library</span>
          <select
            class="field"
            value={server.libraryId ?? ""}
            disabled={libraries[server.id]?.status === "loading"}
            onchange={(event) => chooseLibrary(server, event.currentTarget.value)}
          >
            <option value="">All libraries</option>
            {#each libraryOptions(server) as library (library.id)}
              <option value={library.id}>{library.name}</option>
            {/each}
          </select>
        </label>
        {#if libraries[server.id]?.status === "loading"}
          <p class="hint" role="status">Reading libraries…</p>
        {:else if libraries[server.id]?.status === "error"}
          <p class="failure" role="status">{libraries[server.id].error}</p>
        {/if}
      </div>
      {#if results[server.id]}<p class="hint result" role="status">{results[server.id]}</p>{/if}
    </div>
  {/each}

  {#if error}<p class="failure" role="alert">{error}</p>{/if}
  {#if notice}<p class="hint" role="status">{notice}</p>{/if}
</div>

<dialog bind:this={dialog} aria-labelledby={headingId} oncancel={(event) => { event.preventDefault(); close(); }}>
  {#if dialogOpen}
    <form onsubmit={save}>
      <h2 id={headingId}>{editing === null ? "Add a Komga server" : `Edit ${editing.label}`}</h2>
      <p class="hint">
        Use your normal Komga login; it stays on this device and is not in backups. Two servers may
        share an address.
      </p>
      <label>
        <span>Name</span>
        <input class="field" type="text" bind:value={label} placeholder="Komga" maxlength="40" disabled={busy} />
      </label>
      <label>
        <span>Server address</span>
        <input class="field" type="url" bind:value={address} placeholder="http://server:25600" required autocomplete="url" autocapitalize="none" spellcheck="false" disabled={busy} />
      </label>
      <label>
        <span>Username</span>
        <input class="field" type="text" bind:value={username} required autocomplete="username" autocapitalize="none" spellcheck="false" disabled={busy} />
      </label>
      <label>
        <span>Password{editing === null ? "" : " (blank keeps the saved one)"}</span>
        <input class="field" type="password" bind:value={password} required={editing === null} autocomplete="current-password" disabled={busy} />
      </label>
      {#if formError}<p class="failure" role="alert">{formError}</p>{/if}
      <div class="actions">
        <button type="button" class="chip" onclick={close}>Cancel</button>
        <button type="submit" class="chip" disabled={busy || address.trim() === "" || username.trim() === "" || (editing === null && password === "")}>
          {busy ? "Signing in…" : editing === null ? "Sign in and add" : "Save"}
        </button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  .komga { display: grid; gap: var(--s2); margin-top: var(--s2); }
  .head { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
  .count { flex: 1; min-width: 0; color: var(--muted); font-size: var(--t-sm); }
  .server { display: grid; gap: var(--s2); border: 1px solid var(--line); border-radius: var(--r2); padding: var(--s2); }
  .who { display: grid; gap: 2px; min-width: 0; }
  .name { font-size: var(--t-sm); }
  .addr { color: var(--muted); font-size: var(--t-sm); overflow-wrap: anywhere; }
  .controls { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
  .picker { display: grid; gap: var(--s1); min-width: 0; }
  .picker label { display: grid; gap: var(--s1); min-width: 0; }
  .picker label span { font-size: var(--t-sm); color: var(--muted); }
  .picker select { width: 100%; min-height: 36px; }
  .switch { display: inline-flex; align-items: center; gap: var(--s1); font-size: var(--t-sm); color: var(--muted); }
  .hint, .failure { margin: 0; overflow-wrap: anywhere; font-size: var(--t-sm); }
  .result { color: var(--muted); }
  .failure { color: var(--danger, #e5484d); }
  dialog { box-sizing: border-box; width: min(28rem, calc(100% - 2rem)); max-height: calc(100dvh - 2rem - var(--safe-t, 0px) - var(--safe-b, 0px)); overflow: auto; overscroll-behavior: contain; color: var(--text-1); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r3); padding: var(--s4); }
  dialog::backdrop { background: rgb(0 0 0 / 65%); backdrop-filter: blur(5px); }
  form { display: grid; gap: var(--s3); min-width: 0; }
  h2, p { margin: 0; }
  h2 { font-size: var(--t-lg); }
  label { display: grid; gap: var(--s1); min-width: 0; }
  label span { font-size: var(--t-sm); color: var(--muted); }
  input { box-sizing: border-box; width: 100%; min-width: 0; font-size: 16px; }
  .actions { display: flex; justify-content: flex-end; gap: var(--s2); flex-wrap: wrap; }
  .actions button { min-height: 44px; }
</style>
