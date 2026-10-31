<script lang="ts">
  /**
   * "From Google Drive" — the same import as a picked file, from a folder instead of a disk.
   *
   * Three things this deliberately does *not* do.
   *
   * It does not stream pages from Drive while reading. A token lasts an hour; the library lasts
   * longer, and a book that stops working when a token expires is worse than a book that took a
   * moment to arrive. The bytes are downloaded once and stored like any other imported file.
   *
   * It does not keep the token. It lives in this component's state and dies with the dialog, so
   * nothing on disk is a credential.
   *
   * It does not ask for a broad scope or a secret. `drive.readonly` and a public client id, pasted
   * by the user, is the least that can see a folder they already own.
   */
  import Sheet from "./Sheet.svelte";
  import { library } from "../state/library.svelte";
  import { importComicFiles } from "../lib/files/import";
  import {
    DRIVE_SCOPE,
    comicFiles,
    driveToFiles,
    folderIdFrom,
    listFolder,
    type DriveFile,
  } from "../lib/cloud/drive";
  import { requestDriveToken, storeClientId, storeFolderId, storedClientId, storedFolderId } from "../lib/cloud/google";

  interface Props {
    open: boolean;
    onclose: () => void;
  }
  let { open, onclose }: Props = $props();

  let clientId = $state(storedClientId());
  let folderInput = $state(storedFolderId());
  let token = $state<string | null>(null);
  let entries = $state<DriveFile[]>([]);
  let chosen = $state<string[]>([]);
  let busy = $state<"token" | "list" | "import" | null>(null);
  let note = $state<string | null>(null);

  const folderId = $derived(folderIdFrom(folderInput));
  const readable = $derived(comicFiles(entries));

  async function connect(): Promise<void> {
    busy = "token";
    note = null;
    try {
      storeClientId(clientId);
      token = await requestDriveToken(clientId, DRIVE_SCOPE);
      note = "Connected. Now the folder.";
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    } finally {
      busy = null;
    }
  }

  async function list(): Promise<void> {
    if (token === null) return;
    const id = folderIdFrom(folderInput);
    if (id === null) {
      note = "That does not look like a Drive folder link or id.";
      return;
    }
    busy = "list";
    note = null;
    try {
      storeFolderId(folderInput);
      entries = await listFolder(token, id);
      chosen = comicFiles(entries).map((file) => file.id);
      note =
        readable.length === 0
          ? "Nothing in that folder this app can open — it reads CBZ, ZIP, PDF and CBR."
          : `${readable.length} comic${readable.length === 1 ? "" : "s"} in that folder.`;
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    } finally {
      busy = null;
    }
  }

  function toggle(id: string): void {
    chosen = chosen.includes(id) ? chosen.filter((value) => value !== id) : [...chosen, id];
  }

  async function importChosen(): Promise<void> {
    if (token === null || library.profile === null) return;
    const picked = readable.filter((file) => chosen.includes(file.id));
    if (picked.length === 0) return;
    busy = "import";
    note = "Downloading…";
    try {
      const files = await driveToFiles(token, picked, fetch, (done, total) => {
        note = `Downloading ${done} of ${total}…`;
      });
      const result = await importComicFiles(library.profile.store, files);
      await library.refreshLibrary();
      const bits: string[] = [];
      if (result.added > 0) bits.push(`${result.added} added`);
      if (result.skipped.length > 0) bits.push(`${result.skipped.length} already here`);
      if (result.errors.length > 0) bits.push(result.errors.join(" · "));
      note = bits.join(" · ") || "Nothing to add";
      chosen = [];
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    } finally {
      busy = null;
    }
  }

  function size(bytes: string | undefined): string {
    const value = Number(bytes ?? 0);
    if (!Number.isFinite(value) || value <= 0) return "";
    return value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MB` : `${Math.round(value / 1024)} KB`;
  }
</script>

<Sheet {open} title="From Google Drive" {onclose}>
  <div class="drive">
    <p class="lede">
      Import the comics you already own. They are downloaded once and stored on this device, so they
      read with no connection afterwards — this is not a stream.
    </p>

    <label class="field">
      <span>OAuth client id</span>
      <input bind:value={clientId} placeholder="1234-abc.apps.googleusercontent.com" spellcheck="false" />
    </label>
    <p class="hint">
      One-time setup in your own Google Cloud project: enable the Drive API, create an <em>OAuth
      client ID</em> of type “Web application”, and add this app's address as an authorised JavaScript
      origin. No secret is used or stored.
    </p>

    <div class="row">
      <button class="go" disabled={busy !== null || clientId.trim() === ""} onclick={connect}>
        {busy === "token" ? "Waiting for Google…" : token === null ? "Connect Google Drive" : "Reconnect"}
      </button>
      {#if token !== null}<span class="ok">connected</span>{/if}
    </div>

    <label class="field">
      <span>Folder</span>
      <input bind:value={folderInput} placeholder="https://drive.google.com/drive/folders/…" spellcheck="false" />
    </label>
    <div class="row">
      <button class="go" disabled={busy !== null || token === null || folderId === null} onclick={list}>
        {busy === "list" ? "Listing…" : "List folder"}
      </button>
      <button
        class="go"
        disabled={busy !== null || chosen.length === 0}
        onclick={importChosen}
      >
        {busy === "import" ? "Importing…" : `Import ${chosen.length || ""}`.trim()}
      </button>
    </div>

    {#if readable.length > 0}
      <ul class="files">
        {#each readable as file (file.id)}
          <li>
            <label>
              <input type="checkbox" checked={chosen.includes(file.id)} onchange={() => toggle(file.id)} />
              <span class="name">{file.name}</span>
              <span class="size">{size(file.size)}</span>
            </label>
          </li>
        {/each}
      </ul>
    {/if}

    {#if note !== null}<p class="note">{note}</p>{/if}
  </div>
</Sheet>

<style>
  .drive {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
    min-width: min(30rem, 78vw);
  }
  .lede {
    margin: 0;
    color: var(--muted, #9aa0a6);
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    font-size: 0.8rem;
    color: var(--muted, #9aa0a6);
  }
  .field input {
    padding: 0.5rem 0.6rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line, #333);
    background: var(--input, #1a1a1c);
    color: inherit;
    font: inherit;
    font-size: 0.85rem;
  }
  .hint {
    margin: 0;
    font-size: 0.75rem;
    line-height: 1.45;
    color: var(--muted, #9aa0a6);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .go {
    padding: 0.45rem 0.8rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line, #333);
    background: var(--button, #242427);
    color: inherit;
    font: inherit;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .go:disabled {
    opacity: 0.45;
    cursor: default;
  }
  .ok {
    font-size: 0.75rem;
    color: var(--good, #6bbf7a);
  }
  .files {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: 16rem;
    overflow: auto;
    border: 1px solid var(--line, #333);
    border-radius: 0.45rem;
  }
  .files li + li {
    border-top: 1px solid var(--line, #333);
  }
  .files label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.45rem 0.6rem;
    font-size: 0.82rem;
    cursor: pointer;
  }
  .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .size {
    color: var(--muted, #9aa0a6);
    font-size: 0.75rem;
  }
  .note {
    margin: 0;
    font-size: 0.78rem;
    color: var(--muted, #9aa0a6);
  }
</style>
