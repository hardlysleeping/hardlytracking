<script lang="ts">
  import { privacy } from "../state/privacy.svelte";
  import { library } from "../state/library.svelte";
  import { categories } from "../state/categories.svelte";
  import { sourceMarks } from "../state/source-marks.svelte";
  import { settings } from "../state/settings.svelte";
  import { aggregateReadingStats, loadReadingStats, type ReadingStatsData } from "../lib/reading-stats";

  let data = $state<ReadingStatsData | null>(null);
  let loading = $state(true);
  let error = $state("");
  let revision = $state(0);
  $effect(() => {
    const store = library.profile?.store;
    revision;
    let cancelled = false;
    data = null;
    error = "";
    loading = store !== undefined;
    if (store !== undefined) {
      void loadReadingStats(store).then((snapshot) => {
        if (!cancelled) data = snapshot;
      }).catch(() => {
        if (!cancelled) error = "Could not load reading stats. Your library has not been changed.";
      }).finally(() => { if (!cancelled) loading = false; });
    }
    return () => { cancelled = true; };
  });
  const stats = $derived(data === null || (privacy.locked && (!categories.loaded || !sourceMarks.loaded)) ? null : aggregateReadingStats(data, { categories: categories.items, sources: sourceMarks.marks }));
  function time(seconds: number): string {
    if (seconds === 0) return "0m";
    if (seconds < 60) return "<1m";
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
</script>

<section class="view" aria-label="Reading stats">
  <header class="top">
    <h1>Stats</h1>
    <button class="btn ghost" disabled={loading} onclick={() => revision++}>Refresh</button>
  </header>
  {#if loading}
    <p class="notice" role="status">Loading reading stats…</p>
  {:else if error}
    <p class="notice" role="alert">{error}</p>
  {:else if stats === null}
    <p class="notice">Open a library to see reading stats.</p>
  {:else}
    <p class="intro">Your saved reading state and retained history. Hidden sources and categories are excluded.</p>
    {#if settings.historyPaused}<p class="notice">History recording is paused. Read marks and saved progress still count; new sessions will not be recorded.</p>{/if}
    {#if !stats.hasActivity}
      <div class="blank">
        <h2>No reading activity yet</h2>
        <p>Read an issue or mark one read to start. Opening a title does not mark it completed.</p>
      </div>
    {/if}
    <div class="cards">
      <article><h2>Issues read</h2><strong>{stats.readIssues.toLocaleString()}</strong><p>Unique issues currently read, including manual marks. Rereads count once; mark unread removes one.</p></article>
      <article><h2>In progress</h2><strong>{stats.inProgressIssues.toLocaleString()}</strong><p>Unread issues with a saved position beyond the first page.</p></article>
      <article><h2>Saved page positions</h2><strong>{stats.savedPages.toLocaleString()} <small>/ {stats.knownProgressPages.toLocaleString()}</small></strong><p>Across {stats.progressIssues} issues with known progress totals. Positions, not measured pages read; skipped pages and manual marks are not reading evidence.</p></article>
      <article><h2>Recorded session time</h2><strong>{time(stats.recordedSeconds)}</strong><p>From {stats.closedSessions} closed sessions. {stats.openSessions} open/interrupted and {stats.unmeasuredSessions} without measured duration add no time.</p></article>
      <article><h2>Series started</h2><strong>{stats.startedSeries.toLocaleString()}</strong><p>With read marks, advanced progress, or retained issue activity. {stats.seriesWithReads} have at least one read issue.</p></article>
      <article><h2>Caught up with known issues</h2><strong>{stats.caughtUpSeries.toLocaleString()}</strong><p>All locally known issues are read. This is not series completion: a cached chapter list may be incomplete or new issues may exist.</p></article>
    </div>
    <section class="block" aria-labelledby="daily-heading">
      <h2 id="daily-heading">Recent days</h2>
      <p class="hint">Local calendar days, sessions assigned to their start day. Last-opened counts are retained latest visits, not every visit or daily completions.</p>
      {#if stats.days.length === 0}<p class="notice">No dated history retained.</p>{:else}
        <div class="table-wrap"><table>
          <thead><tr><th scope="col">Day</th><th scope="col">Sessions</th><th scope="col">Time</th><th scope="col">Last-opened issues</th></tr></thead>
          <tbody>{#each stats.days.slice(0, 14) as day (day.day)}<tr><th scope="row">{day.day}</th><td>{day.sessions}</td><td>{time(day.seconds)}</td><td>{day.lastOpenedIssues}</td></tr>{/each}</tbody>
        </table></div>
        {#if stats.days.length > 14}<p class="hint">Showing the latest 14 recorded days. Cards include all retained records.</p>{/if}
      {/if}
    </section>
    <section class="block" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recently opened</h2>
      {#if stats.recent.length === 0}<p class="notice">No recent issue history retained. Manual read marks do not record a visit.</p>{:else}
        <ul class="recent">{#each stats.recent.slice(0, 10) as row (row.chapterId)}<li><div><b>{row.title}</b><span>{row.chapterName}</span></div><time datetime={new Date(row.at).toISOString()}>{new Date(row.at).toLocaleDateString()}</time></li>{/each}</ul>
      {/if}
    </section>
    <aside class="limits" aria-label="Measurement limits">
      <h2>What these numbers can tell you</h2>
      <p>Read marks are current state, not a lifetime completion log. Manual marks have no completion timestamp. History keeps only the latest visit per issue. Deleted, expired, paused or never-recorded activity cannot be reconstructed.</p>
      <p>Session time uses stored durations only, never time elapsed since opening this page. Older reader versions may have included idle/background time in those durations; that cannot be separated retrospectively. This is recorded time, not a verified active-reading stopwatch.</p>
      <p>Closed sessions store {stats.sessionPageSpans.toLocaleString()} page spans (endpoint distance plus one, including rereads), not individual page turns or unique pages. Missing page totals are not estimated. Records with no attributable series are excluded so source/category privacy is not bypassed. Provider availability is not required.</p>
    </aside>
  {/if}
</section>

<style>
  .view { max-width: 1120px; padding: var(--s4) var(--s4) var(--s7); }
  .top { display: flex; justify-content: space-between; align-items: center; gap: var(--s3); padding-bottom: var(--s3); margin-bottom: var(--s3); }
  h1 { font-size: var(--t-2xl); font-weight: 650; }
  h2 { font-size: var(--t-md); font-weight: 650; }
  p { line-height: 1.55; }
  .intro, .hint, .notice, article p, .limits { color: var(--text-2); font-size: var(--t-sm); }
  .intro { margin-bottom: var(--s4); }
  .notice { margin: var(--s3) 0; }
  .blank { padding: var(--s4); border: 1px dashed var(--line); border-radius: var(--r2); margin-bottom: var(--s4); }
  .blank p { color: var(--text-2); margin-top: var(--s2); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: var(--s3); }
  article { border: 1px solid var(--line); border-radius: var(--r2); padding: var(--s4); background: var(--surface); min-width: 0; }
  article strong { display: block; font-size: var(--t-2xl); margin: var(--s2) 0; overflow-wrap: anywhere; }
  small { font-size: var(--t-sm); color: var(--text-2); font-weight: 400; }
  .block { margin-top: var(--s6); }
  .hint { margin: var(--s2) 0 var(--s3); }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: var(--t-sm); }
  th, td { padding: var(--s3) var(--s2); text-align: right; border-bottom: 1px solid var(--line); }
  th:first-child { text-align: left; white-space: nowrap; }
  .recent { list-style: none; padding: 0; margin-top: var(--s3); }
  .recent li { display: flex; justify-content: space-between; align-items: center; gap: var(--s3); padding: var(--s3) 0; border-bottom: 1px solid var(--line); }
  .recent li div { min-width: 0; overflow-wrap: anywhere; }
  .recent span { display: block; color: var(--text-2); font-size: var(--t-sm); margin-top: var(--s1); }
  time { flex-shrink: 0; color: var(--text-2); font-size: var(--t-xs); }
  .limits { margin-top: var(--s6); padding-top: var(--s4); border-top: 1px solid var(--line); }
  .limits p { margin-top: var(--s2); }
</style>
