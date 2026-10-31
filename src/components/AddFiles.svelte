<script lang="ts">
  /**
   * "Add files" — the comics the user already owns.
   *
   * This is the one button in the app that needs no server, no extension and no network: a bought
   * CBZ, CBR or PDF becomes a normal library row, and everything the library does works on it. It is
   * deliberately a plain file picker — a folder on a phone is a picker result, not a path to type.
   */
  import { library } from "../state/library.svelte";
  import { importComicFiles } from "../lib/files/import";

  interface Props {
    /** `primary` where it is the only thing to do (an empty library), `ghost` in a toolbar. */
    look?: "primary" | "ghost";
    label?: string;
  }
  let { look = "ghost", label = "Add files" }: Props = $props();

  let busy = $state(false);
  let note = $state<string | null>(null);
  let input = $state<HTMLInputElement | null>(null);

  async function picked(event: Event): Promise<void> {
    const element = event.currentTarget as HTMLInputElement;
    const files = [...(element.files ?? [])];
    element.value = ""; // so picking the same file twice fires again
    if (files.length === 0 || library.profile === null) return;
    busy = true;
    note = null;
    try {
      const result = await importComicFiles(library.profile.store, files);
      await library.refreshLibrary();
      const bits: string[] = [];
      if (result.added > 0) bits.push(`${result.added} added`);
      if (result.skipped.length > 0) bits.push(`${result.skipped.length} already here or not a comic`);
      if (result.errors.length > 0) bits.push(result.errors.join(" · "));
      note = bits.join(" · ") || "Nothing to add";
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    } finally {
      busy = false;
      setTimeout(() => (note = null), 6000);
    }
  }
</script>

<button class="btn {look}" disabled={busy} onclick={() => input?.click()}>
  {busy ? "Adding…" : label}
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
{#if note !== null}
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
