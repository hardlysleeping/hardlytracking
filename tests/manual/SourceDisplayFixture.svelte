<script lang="ts">
  /**
   * The Discover page (one source's listing) with synthetic rows, mounted on its own.
   *
   * `sourceId` exists so a fixture can mount a source that declares its own listing row (the
   * Archive's Trending/Popular/Latest) without the real provider or its network.
   */
  import Source from "../../src/views/Source.svelte";

  let { sourceId = "local:src:library" }: { sourceId?: string } = $props();
</script>

<Source {sourceId} />
