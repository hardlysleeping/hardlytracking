<script lang="ts">
  import { imageCache } from "../lib/cache/images";
  /**
   * A cover, with an honest fallback: the title, not a broken-image icon.
   *
   * `loading="lazy"` plus `decoding="async"` is what keeps a 5 000-title library from opening
   * every image at once; the fixed aspect ratio means nothing reflows when they arrive.
   */
  interface Props {
    series: { title: string; cover?: string; coverHeaders?: Record<string, string> };
    size?: "grid" | "hero" | "row";
  }
  let { series, size = "grid" }: Props = $props();
  let broken = $state(false);

  /**
   * The cover through the image cache: a cached copy renders instantly and works offline, an
   * uncached one renders from the network and is stored for next time. `series.cover` stays the
   * source of truth — the cache never invents a URL.
   */
  let src = $state<string | undefined>(series.cover);
  $effect(() => {
    const url = series.cover;
    if (url === undefined || url === "") {
      src = undefined;
      return;
    }
    let live = true;
    src = url;
    const headers = series.coverHeaders;
    void imageCache.resolve(url, headers === undefined ? {} : { headers }).then((resolved) => {
      if (live && resolved !== url) src = resolved;
    });
    return () => {
      live = false;
    };
  });
</script>

<div class="cover {size}">
  {#if series.cover && !broken}
    <img src={src} alt="" loading="lazy" decoding="async" onerror={() => (broken = true)} />
  {:else}
    <span class="fallback">{series.title}</span>
  {/if}
</div>

<style>
  .cover {
    position: relative;
    overflow: hidden;
    border-radius: var(--r2);
    background: var(--surface-2);
    display: grid;
    place-items: center;
  }
  .cover.grid {
    aspect-ratio: 2 / 3;
  }
  .cover.hero {
    width: 128px;
    aspect-ratio: 2 / 3;
  }
  .cover.row {
    width: 42px;
    aspect-ratio: 2 / 3;
    border-radius: var(--r1);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .fallback {
    padding: var(--s2);
    font-size: var(--t-xs);
    line-height: 1.3;
    color: var(--text-3);
    text-align: center;
  }
</style>
