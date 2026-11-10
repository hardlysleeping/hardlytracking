<script lang="ts">
  /**
   * The language filter, out of the list and into its own scrollable sheet.
   *
   * The chips used to sit in a wrapping row above the catalogue. A living repository publishes
   * twenty-odd languages, so that row became four or five lines of buttons and the extensions
   * themselves started below the fold — the filter looked like the content and the list looked empty.
   *
   * Toggling applies immediately: a language is a view of the index, not a form to submit, and the
   * list behind the sheet is where the result has to be seen.
   */
  import Sheet from "./Sheet.svelte";

  interface Props {
    open: boolean;
    /** Every language this index publishes, lower-case, already sorted. */
    codes: string[];
    /** How many entries publish in each code — so a row can say what picking it yields. */
    counts: Map<string, number>;
    /** The chosen codes. Empty means every language. */
    selected: string[];
    onclose: () => void;
    onchange: (next: string[]) => void;
  }
  let { open, codes, counts, selected, onclose, onchange }: Props = $props();

  function toggle(code: string): void {
    onchange(selected.includes(code) ? selected.filter((other) => other !== code) : [...selected, code]);
  }
</script>

<Sheet {open} title="Languages" {onclose}>
  <p class="lead">
    {#if selected.length === 0}
      Every language. Pick one or more to narrow the list.
    {:else}
      Showing {selected.length === 1 ? "one language" : `${selected.length} languages`} of {codes.length}.
    {/if}
  </p>
  <div class="list" role="group" aria-label="Languages in this repository">
    {#each codes as code (code)}
      <label class="langrow" class:on={selected.includes(code)}>
        <input type="checkbox" checked={selected.includes(code)} onchange={() => toggle(code)} />
        <span class="code">{code.toUpperCase()}</span>
        <span class="count">{counts.get(code) ?? 0}</span>
      </label>
    {/each}
  </div>
  <div class="acts">
    <button class="btn" disabled={selected.length === 0} onclick={() => onchange([])}>Show all languages</button>
  </div>
</Sheet>

<style>
  .lead {
    margin: 0;
    font-size: var(--t-sm);
    color: var(--text-2);
  }

  /*
   * Its own scroller, not the sheet's: the header and "show all" stay put while the list under them
   * scrolls, which is what makes forty languages usable on a phone.
   */
  .list {
    display: grid;
    gap: 2px;
    max-height: min(52dvh, 420px);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px;
    border: 1px solid var(--line);
    border-radius: var(--r2);
  }

  .langrow {
    display: flex;
    align-items: center;
    gap: var(--s2);
    min-height: 44px;
    padding: 0 var(--s3);
    border-radius: var(--r2);
    font-size: var(--t-md);
    color: var(--text-1);
  }

  .langrow.on {
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .langrow input {
    inline-size: 20px;
    block-size: 20px;
    accent-color: var(--accent);
    flex: none;
  }

  .code {
    flex: 1;
    min-width: 0;
  }

  .count {
    font-size: var(--t-xs);
    color: var(--text-3);
    font-variant-numeric: tabular-nums;
  }

  .acts {
    display: flex;
    justify-content: flex-end;
  }
</style>
