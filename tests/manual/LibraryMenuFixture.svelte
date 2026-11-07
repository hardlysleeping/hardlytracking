<script lang="ts">
  import Library from "../../src/views/Library.svelte";
</script>

<main>
  <Library />
</main>

<style>
  :global(body) {
    margin: 0;
    padding: var(--safe-t) var(--safe-r) var(--safe-b) var(--safe-l);
    box-sizing: border-box;
    min-height: 100dvh;
    overflow: auto;
  }
  main {
    min-width: 0;
  }
</style>
