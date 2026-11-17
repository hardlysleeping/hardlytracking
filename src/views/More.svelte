<script lang="ts">
  /**
   * More is the Settings page now.
   *
   * The page held four rows that each opened a page living nowhere else, plus the notice log. Those
   * rows are the Settings page's own rows, and the log sits under them, so `/more` and `/settings`
   * draw the same screen. This file stays as a thin import so the QA fixtures that still mount
   * `More` keep working; nothing here is a page of its own any more.
   */
  import Settings from "./Settings.svelte";
</script>

<Settings />