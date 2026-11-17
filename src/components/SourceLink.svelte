<script lang="ts">
  /**
   * "Open at source": one door to the page this title lives on.
   *
   * A source that has a web page (Internet Archive, Komga, any Mihon extension that declares its
   * site) gets one link to it. A local folder or an API-only source has no page, so the link is
   * absent rather than a dead button. Same component in the search card and the series page so the
   * words and the glyph cannot drift apart.
   */
  import { hostOf, openExternal } from "../lib/external";

  interface Props {
    url?: string;
    /** A glyph seat, for a row of actions; the words stay for the card that has room. */
    icon?: boolean;
  }
  let { url, icon = false }: Props = $props();
</script>

{#if url !== undefined && url !== ""}
  <a
    class:icon
    class:btn={icon}
    class:srclink={!icon}
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={`Open at source, ${hostOf(url)}`}
    title={`Open at source · ${hostOf(url)}`}
    onclick={(event) => {
      event.preventDefault();
      void openExternal(url);
    }}
  >
    {#if icon}
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5" /></svg>
    {:else}
      Open at source · {hostOf(url)} ↗
    {/if}
  </a>
{/if}

<style>
  .srclink {
    display: inline-block;
    margin-top: var(--s2);
    font-size: var(--t-xs);
    color: var(--text-3);
    text-decoration: none;
  }

  .srclink:hover {
    color: var(--text);
  }
</style>
