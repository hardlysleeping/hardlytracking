<script lang="ts">
  import { onDestroy, tick, untrack } from "svelte";

  interface Login { baseUrl: string; username: string; password: string }
  interface Props {
    name: string;
    configured: () => boolean;
    savedAddress: () => string;
    probe: (login: Login) => Promise<{ ok: boolean; error?: string; libraries?: string[]; sources?: string[] }>;
    save: (login: Login) => void;
    logout: () => void;
    onchange: () => Promise<void>;
    requireCredentials?: boolean;
  }
  let { name, configured, savedAddress, probe, save, logout, onchange, requireCredentials = true }: Props = $props();
  const headingId = $derived(`${name.toLowerCase()}-login-heading`);
  let saved = $state(untrack(() => configured()));
  let verified = $state(false);
  let editing = $state(false);
  let busy = $state(false);
  let address = $state("");
  let username = $state("");
  let password = $state("");
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let dialog: HTMLDialogElement;
  let generation = 0;

  function clearDraft(): void {
    address = "";
    username = "";
    password = "";
  }

  function dismiss(): void {
    generation++;
    busy = false;
    editing = false;
    clearDraft();
    error = null;
    dialog.close();
  }

  async function open(): Promise<void> {
    clearDraft();
    address = savedAddress();
    error = null;
    editing = true;
    // Mount the fields before native dialog focus management chooses its first control.
    await tick();
    if (editing && dialog.isConnected) dialog.showModal();
  }

  async function refresh(): Promise<void> {
    try {
      await onchange();
    } catch {
      notice = "The login changed, but sources could not be refreshed yet.";
    }
  }

  async function signIn(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (busy) return;
    const attempt = ++generation;
    const login = { baseUrl: address.trim(), username: username.trim(), password };
    busy = true;
    error = null;
    try {
      const result = await probe(login);
      // Closing the prompt or leaving this page must never save an abandoned login.
      if (attempt !== generation) return;
      if (!result.ok) {
        error = result.error ?? `${name} did not answer. Try again.`;
        password = "";
        return;
      }
      save(login);
      saved = true;
      verified = true;
      notice = result.libraries?.length === 0 ? "Signed in, but no libraries are visible to this account."
        : result.sources?.length === 0 ? "Connected, but this server has no sources installed." : null;
      dismiss();
      void refresh();
    } catch {
      if (attempt === generation) {
        error = "Could not complete sign in. Try again.";
        password = "";
      }
    } finally {
      if (attempt === generation) busy = false;
    }
  }

  function logOut(): void {
    logout();
    saved = false;
    verified = false;
    notice = null;
    clearDraft();
    void refresh();
  }

  onDestroy(() => { generation++; clearDraft(); });
</script>

<div class="connection">
  <span class="status">{saved ? (verified ? "Signed in" : "Login saved") : "Not signed in"}</span>
  {#if saved}
    <button class="chip small" onclick={logOut}>Log out</button>
  {:else}
    <button class="chip small" onclick={open}>Sign in</button>
  {/if}
</div>
{#if notice}<p class="hint" role="status">{notice}</p>{/if}

<dialog bind:this={dialog} aria-labelledby={headingId} oncancel={(event) => { event.preventDefault(); dismiss(); }}>
  {#if editing}
    <form onsubmit={signIn}>
      <h2 id={headingId}>Sign in to {name}</h2>
      <p class="hint">Use your normal {name} login{requireCredentials ? "." : ", if your server requires one."} Your login stays on this device and is not included in library backups.</p>
      <label>
        <span>Server address</span>
        <input class="field" type="url" bind:value={address} placeholder={name === "Komga" ? "http://server:25600" : "http://server:4567"} required autocomplete="url" autocapitalize="none" spellcheck="false" disabled={busy} />
      </label>
      <label>
        <span>Username{requireCredentials ? "" : " (if required)"}</span>
        <input class="field" type="text" bind:value={username} required={requireCredentials} autocomplete="username" autocapitalize="none" spellcheck="false" disabled={busy} />
      </label>
      <label>
        <span>Password{requireCredentials ? "" : " (if required)"}</span>
        <input class="field" type="password" bind:value={password} required={requireCredentials} autocomplete="current-password" disabled={busy} />
      </label>
      {#if error}<p class="failure" role="alert">{error}</p>{/if}
      <div class="actions">
        <button type="button" class="chip" onclick={dismiss}>Cancel</button>
        <button type="submit" class="chip" disabled={busy || !address.trim() || (requireCredentials && (!username.trim() || !password))}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </div>
    </form>
  {/if}
</dialog>

<style>
  .connection { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s2); }
  .status { flex: 1; min-width: 0; color: var(--muted); font-size: var(--t-sm); }
  dialog { box-sizing: border-box; width: min(28rem, calc(100% - 2rem)); max-height: calc(100dvh - 2rem - var(--safe-t, 0px) - var(--safe-b, 0px)); overflow: auto; overscroll-behavior: contain; color: var(--text-1); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r3); padding: var(--s4); }
  dialog::backdrop { background: rgb(0 0 0 / 65%); backdrop-filter: blur(5px); }
  form { display: grid; gap: var(--s3); min-width: 0; }
  h2, p { margin: 0; }
  h2 { font-size: var(--t-lg); }
  label { display: grid; gap: var(--s1); min-width: 0; }
  label span { font-size: var(--t-sm); color: var(--muted); }
  input { box-sizing: border-box; width: 100%; min-width: 0; font-size: 16px; }
  .hint, .failure { overflow-wrap: anywhere; font-size: var(--t-sm); }
  .failure { color: var(--danger, #e5484d); }
  .actions { display: flex; justify-content: flex-end; gap: var(--s2); flex-wrap: wrap; }
  .actions button { min-height: 44px; }
</style>
