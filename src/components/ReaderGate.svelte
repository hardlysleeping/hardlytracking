<script lang="ts">
  import { library } from "../state/library.svelte";
  import { visibility } from "../state/visibility.svelte";
  import { go } from "../lib/nav";
  import Reader from "../views/Reader.svelte";

  let { seriesId, chapterId }: { seriesId: string; chapterId: string } = $props();
  $effect(() => {
    const store = library.profile?.store;
    if (store !== undefined) void visibility.load(store);
  });
</script>

{#if visibility.allows({ id: seriesId })}
  <Reader {seriesId} {chapterId} />
{:else}
  <!-- Unmount, do not cover a live reader: images, actions and pending work must leave the DOM. -->
  <section class="reader-curtain" role="status">
    <p>This title is hidden while the privacy lock is on.</p>
    <button class="btn" onclick={() => go("/library")}>Back to Library</button>
  </section>
{/if}

<style>
  .reader-curtain {
    box-sizing: border-box;
    min-height: 100dvh;
    display: grid;
    align-content: center;
    justify-items: center;
    gap: var(--s3);
    padding: calc(var(--safe-t) + var(--s4)) calc(var(--safe-r) + var(--s4)) calc(var(--safe-b) + var(--s4)) calc(var(--safe-l) + var(--s4));
    color: var(--text-2);
    text-align: center;
  }
  button { min-height: 44px; }
</style>
