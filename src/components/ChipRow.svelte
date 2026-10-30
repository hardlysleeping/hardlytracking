<script lang="ts">
  /**
   * The active filters, as chips you can take back.
   *
   * A filter the user cannot see is a filter they will blame the app for. Each chip is one
   * question the grid is answering, and the `×` is the answer to "why is this row missing?" —
   * the row disappears entirely when there is nothing to say.
   */
  import type { FilterChip } from "../lib/library/filter";

  interface Props {
    chips: FilterChip[];
    onremove: (key: string) => void;
  }
  let { chips, onremove }: Props = $props();
</script>

{#if chips.length > 0}
  <div class="chips" role="group" aria-label="Active filters">
    {#each chips as chip (chip.key)}
      <button class="chip on" onclick={() => onremove(chip.key)} aria-label={`Remove filter: ${chip.label}`}>
        <span>{chip.label}</span>
        <span class="x" aria-hidden="true">×</span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .chips {
    display: flex;
    gap: var(--s2);
    overflow-x: auto;
    padding-bottom: var(--s1);
    margin-bottom: var(--s3);
    scrollbar-width: none;
  }

  .chips::-webkit-scrollbar {
    display: none;
  }

  .chip {
    flex: none;
  }

  .x {
    font-size: var(--t-md);
    line-height: 1;
    color: var(--text-3);
  }

  .chip:hover .x {
    color: var(--text-1);
  }
</style>
