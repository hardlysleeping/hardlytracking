<script lang="ts">
  /**
   * Display-switching fixture: the Display row and a grid of synthetic titles, nothing else.
   *
   * Only the pieces that decide layout are mounted — no library, no network — so a click on a chip
   * is the only thing that can change the class on the grid.
   */
  import BrowseDisplay from "../../src/components/BrowseDisplay.svelte";
  import SeriesGrid from "../../src/components/SeriesGrid.svelte";
  import { settings } from "../../src/state/settings.svelte";
  import type { Series } from "../../src/api/source";

  const rows: Series[] = Array.from({ length: 12 }, (_, index) => ({
    id: `fixture:${index}`,
    provider: "local",
    title: `Fixture title ${index + 1}`,
    author: "Fixture Author",
    status: "ongoing",
  }));

  const view = $derived(settings.libraryView);
</script>

<div class="screen">
  <BrowseDisplay />
  <SeriesGrid series={rows} view={view} columns={settings.browseColumns} density={settings.browseDensity} horizontal={settings.browseHorizontal} />
</div>

<style>
  .screen {
    padding: 8px;
  }
</style>
