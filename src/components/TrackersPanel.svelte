<script lang="ts">
  import { library } from "../state/library.svelte";
  import KomgaLogin from "./KomgaLogin.svelte";
  import SuwayomiLogin from "./SuwayomiLogin.svelte";
  const catalogueTrackers = ["MyAnimeList", "AniList", "Kitsu", "Shikimori", "Bangumi", "MangaUpdates"];
</script>

<section class="trackers" aria-label="Trackers and reading sync">
  <h2>Reading sync</h2>
  <p class="intro">Connect your own server to keep reading progress and read marks in sync. Komga and Suwayomi are built in; no extension installation is needed.</p>
  <article>
    <h3>Komga</h3>
    <p>Two-way read-state sync for books from your Komga server.</p>
    <KomgaLogin onchange={() => library.refreshKomga()} />
  </article>
  <article>
    <h3>Suwayomi</h3>
    <p>Two-way read-state sync for titles from your Suwayomi server.</p>
    <SuwayomiLogin onchange={() => library.refreshSuwayomi()} />
  </article>
  <h2>Catalogue trackers</h2>
  <p class="intro">Sign-in for these services is not implemented yet.</p>
  <ul>
    {#each catalogueTrackers as name}
      <li><span>{name}</span><span class="unavailable">Not available yet</span></li>
    {/each}
  </ul>
</section>

<style>
  .trackers { min-width: 0; }
  h2 { font-size: var(--t-sm); color: var(--text-2); margin: var(--s4) 0 var(--s2); }
  h3 { font-size: var(--t-lg); margin: 0 0 var(--s1); }
  .intro, article p { color: var(--text-2); font-size: var(--t-sm); line-height: 1.6; margin: 0; overflow-wrap: anywhere; }
  article { margin-top: var(--s3); padding: var(--s4); background: var(--surface); border: 1px solid var(--line); border-radius: var(--r3); min-width: 0; }
  ul { margin: var(--s2) 0 0; padding: 0; list-style: none; }
  li { display: flex; justify-content: space-between; flex-wrap: wrap; align-items: center; gap: var(--s2); padding: var(--s3) 0; border-bottom: 1px solid var(--line); font-size: var(--t-md); }
  .unavailable { color: var(--text-2); font-size: var(--t-sm); }
</style>
