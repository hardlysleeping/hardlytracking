<script lang="ts">
  /**
   * "Add files" — the comics the user already owns.
   *
   * This is the one button in the app that needs no server, no extension and no network: a bought
   * CBZ, CBR or PDF becomes a normal library row, and everything the library does works on it. It is
   * deliberately a plain file picker — a folder on a phone is a picker result, not a path to type.
   *
   * A real file is allowed to be slow; it is not allowed to be silent. The label counts the files and
   * the line under it says what is being done to the one in hand ("Reading Saga v01.pdf"), so
   * "Adding…" can no longer mean both *working* and *hung*. When the import ends, the same line says
   * what happened — including anything it had to leave out, and why.
   */
  import { library } from "../state/library.svelte";
  import { describeProgress, importComicFiles, type ImportProgress } from "../lib/files/import";

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

  /** The count, once there is more than one file to count. */
  const busyLabel = $derived(
    progress !== null && progress.total > 1 ? `Adding ${progress.index} of ${progress.total}…` : "Adding…",
  );

  async function picked(event: Event): Promise<void> {
    const element = event.currentTarget as HTMLInputElement;
    const files = [...(element.files ?? [])];
    element.value = ""; // so picking the same file twice fires again
    if (files.length === 0 || library.profile === null) return;
    busy = true;
    note = null;
    progress = null;
    try {
      const result = await importComicFiles(library.profile.store, files, {
        onProgress: (next) => (progress = next),
      });
      await library.refreshLibrary();
      const bits: string[] = [];
      if (result.added > 0) bits.push(`${result.added} added`);
      if (result.skipped.length > 0) bits.push(`${result.skipped.length} already here or not a comic`);
      if (result.errors.length > 0) bits.push(result.errors.join(" · "));
      note = bits.join(" · ") || "Nothing to add";
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    } finally {
      progress = null;
      busy = false;
      setTimeout(() => (note = null), 6000);
    }
  }
</script>

<button class="btn {look}" disabled={busy} onclick={() => input?.click()}>
  {busy ? busyLabel : label}
</button>
<input
  bind:this={input}
  class="hidden-input"
  type="file"
  multiple
  accept=".cbz,.cbr,.zip,.pdf"
  onchange={(event) => void picked(event)}
  aria-label="Choose comic files"
/>
{#if progress !== null}
  <p class="note" role="status" aria-live="polite">{describeProgress(progress)}</p>
{:else if note !== null}
  <p class="note" role="status">{note}</p>
{/if}

<style>
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
