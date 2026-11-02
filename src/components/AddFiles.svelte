<script lang="ts">
  /**
   * "Add files" and "Add folder" — the comics the user already owns.
   *
   * This is the one control in the app that needs no server, no extension and no network: a bought
   * CBZ, CBR or PDF becomes a normal library row, and everything the library does works on it.
   *
   * Two doors, because picking forty books one at a time is not reading: **Add folder** takes a
   * directory and imports every comic inside it, subfolders included. The folder is a *picker*, not a
   * grouping rule — each comic inside is its own title, exactly as if it had been picked by hand, so
   * nothing is filed under a title guessed from a directory name.
   *
   * A real file is allowed to be slow; it is not allowed to be silent. The label counts the files and
   * the line under it says what is being done to the one in hand ("Reading Saga v01.pdf"), so
   * "Adding…" can no longer mean both *working* and *hung*. When the import ends, the same line says
   * what happened — including anything it had to leave out, and why.
   */
  import { library } from "../state/library.svelte";
  import { describeProgress, importComicFiles, type ImportProgress } from "../lib/files/import";
  import { kindOf } from "../lib/files/index";

  interface Props {
    /** `primary` where it is the only thing to do (an empty library), `ghost` in a toolbar. */
    look?: "primary" | "ghost";
    label?: string;
  }
  let { look = "ghost", label = "Add files" }: Props = $props();

  let busy = $state(false);
  let note = $state<string | null>(null);
  let progress = $state<ImportProgress | null>(null);
  let input = $state<HTMLInputElement | null>(null);
  let folderInput = $state<HTMLInputElement | null>(null);

  /** The count, once there is more than one file to count. */
  const busyLabel = $derived(
    progress !== null && progress.total > 1 ? `Adding ${progress.index} of ${progress.total}…` : "Adding…",
  );

  /**
   * Everything under a picked folder that this app can read.
   *
   * A directory picker hands back whatever is in the directory — covers, `.nfo` files, a stray PDF
   * that is not a comic — so the filter is the same `kindOf` the reader uses. Without it one folder
   * reports forty "not a comic" skips and looks broken.
   */
  function comicsIn(files: File[]): File[] {
    return files.filter((file) => kindOf(file.name) !== null);
  }

  async function run(files: File[], fromFolder: boolean): Promise<void> {
    if (library.profile === null) return;
    const comics = fromFolder ? comicsIn(files) : files;
    note = null;
    if (comics.length === 0) {
      note = fromFolder ? "No comics in that folder — looking for .cbz, .cbr, .zip or .pdf" : "Nothing to add";
      return;
    }
    busy = true;
    progress = null;
    try {
      const result = await importComicFiles(library.profile.store, comics, {
        onProgress: (next) => (progress = next),
        // A folder can hold two books with one name — two editions, or one file name in two
        // subfolders — so the path is what identifies them, and it keeps a re-pick of the same
        // folder a skip instead of a shelf full of duplicates.
        ...(fromFolder ? { idOf: (file: File) => file.webkitRelativePath || file.name } : {}),
      });
      await library.refreshLibrary();
      const bits: string[] = [];
      if (result.added > 0) bits.push(`${result.added} added`);
      if (result.skipped.length > 0) {
        bits.push(fromFolder ? `${result.skipped.length} already here` : `${result.skipped.length} already here or not a comic`);
      }
      if (result.errors.length > 0) bits.push(result.errors.join(" · "));
      note = bits.join(" · ") || "Nothing to add";
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    } finally {
      progress = null;
      busy = false;
      setTimeout(() => (note = null), 8000);
    }
  }

  async function picked(event: Event): Promise<void> {
    const element = event.currentTarget as HTMLInputElement;
    const files = [...(element.files ?? [])];
    const fromFolder = element.hasAttribute("webkitdirectory");
    element.value = ""; // so picking the same file or folder twice fires again
    if (files.length === 0) return;
    await run(files, fromFolder);
  }
</script>

<div class="add">
  <button class="btn {look}" disabled={busy} onclick={() => input?.click()}>
    {busy ? busyLabel : label}
  </button>
  <button
    class="btn {look}"
    disabled={busy}
    title="Every comic inside a folder, subfolders included"
    onclick={() => folderInput?.click()}
  >
    Add folder
  </button>
</div>
<input
  bind:this={input}
  class="hidden-input"
  type="file"
  multiple
  accept=".cbz,.cbr,.zip,.pdf"
  onchange={(event) => void picked(event)}
  aria-label="Choose comic files"
/>
<input
  bind:this={folderInput}
  class="hidden-input"
  type="file"
  multiple
  webkitdirectory
  onchange={(event) => void picked(event)}
  aria-label="Choose a folder of comics"
/>
{#if progress !== null}
  <p class="note" role="status" aria-live="polite">{describeProgress(progress)}</p>
{:else if note !== null}
  <p class="note" role="status">{note}</p>
{/if}

<style>
  .add {
    display: flex;
    gap: var(--s1);
    flex-wrap: wrap;
  }

  .hidden-input {
    display: none;
  }

  .note {
    flex-basis: 100%;
    margin: var(--s1) 0 0;
    font-size: var(--t-xs);
    color: var(--text-2);
  }
</style>
