<script lang="ts">
  /**
   * Display-switching fixture: the Display row and a grid of synthetic titles, nothing else.
   *
   * Only the pieces that decide layout are mounted — no library, no network — so a click in the
   * display menu is the only thing that can change the class on the grid.
   */
  import BrowseDisplay from "../../src/components/BrowseDisplay.svelte";
  import SeriesGrid from "../../src/components/SeriesGrid.svelte";
  import { settings } from "../../src/state/settings.svelte";
  import type { Series } from "../../src/api/source";

  const rows: Series[] = Array.from({ length: 12 }, (_, index) => ({
    id: `fixture:${index}`,
    provider: index % 2 === 0 ? "local" : "mihon",
    title: `Fixture title ${index + 1}`,
    author: "Fixture Author",
    status: index % 3 === 0 ? "completed" : "ongoing",
    description:
      "A sentence of the blurb so the row shapes have something to differ over: one long enough to be clamped, because that is what a real library holds.",
  }));

  const view = $derived(settings.libraryView);
  const unread = new Map(rows.map((row, index) => [row.id, index % 4 === 0 ? 0 : index + 1]));
  const totals = new Map(rows.map((row, index) => [row.id, 12 + index]));
  const sizes = new Map(rows.map((row, index) => [row.id, (index + 1) * 12_345_678]));
</script>

<div class="screen">
  <BrowseDisplay />
  <SeriesGrid
    series={rows}
    {view}
    rowStyle={settings.rowStyle}
    titlePlacement={settings.browseTitle}
    {unread}
    {totals}
    {sizes}
    current={rows[0].id}
  />
</div>

<style>
  .screen {
    padding: 8px;
  }
</style>
