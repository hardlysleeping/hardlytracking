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
  }
  let { url }: Props = $props();
</script>

{#if url !== undefined && url !== ""}
  <a
    class="srclink"
    href={url}
    target="_blank"
    rel="noopener noreferrer"
    aria-label={`Open at source, ${hostOf(url)}`}
    onclick={(event) => {
      event.preventDefault();
      void openExternal(url);
    }}>Open at source · {hostOf(url)} ↗</a
  >
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
