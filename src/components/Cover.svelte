<script lang="ts">
  import { untrack } from "svelte";
  import { imageCache } from "../lib/cache/images";
  import { isCoverKey } from "../lib/files/cover";
  /**
   * A cover, with an honest fallback: the title, not a broken-image icon.
   *
   * `loading="lazy"` plus `decoding="async"` is what keeps a 5 000-title library from opening
   * every image at once; the fixed aspect ratio means nothing reflows when they arrive.
   */
  interface Props {
    series: { title: string; cover?: string; coverHeaders?: Record<string, string> };
    size?: "grid" | "hero" | "row";
    /**
     * The URL this tile actually resolved to, for a caller that wants the same picture elsewhere.
     *
     * Reporting the resolved value (not `series.cover`) is the point: a login-protected or owned
     * cover only exists as a cache blob URL, and re-resolving it separately would double the work
     * and could disagree with what is on screen. Decorative use only — the tile stays the source.
     */
    onresolve?: (src: string | undefined) => void;
  }
  let { series, size = "grid", onresolve }: Props = $props();
  let broken = $state(false);

  /**
   * The cover through the image cache: a cached copy renders instantly and works offline, an
   * uncached one renders from the network and is stored for next time. `series.cover` stays the
   * source of truth — the cache never invents a URL.
   *
   * A book the user owns has no URL at all: its cover is keyed `book:<id>#cover` and served out of
   * the cache, so the key must not reach an `<img>` — a browser would ask the network for it and
   * draw its own broken-image icon. Until the blob URL arrives the tile shows the title, which is
   * what it showed before covers existed.
   */
  /**
   * A cover a browser can load as it stands: a URL it can fetch *without a header*.
   *
   * A cache key is not a URL, and neither is a cover that needs the login (`coverHeaders`): handing
   * Komga's thumbnail to an `<img>` asks for it anonymously, gets a 401, and the tile falls back to
   * the title for good — while the image cache, which does send the header, has the picture. So a
   * cover with headers only ever arrives as the resolved blob.
   */
  function loadable(cover: string | undefined, needsLogin: boolean): string | undefined {
    return cover === undefined || needsLogin || isCoverKey(cover) ? undefined : cover;
  }
  // Set by the effect below, never captured at construction: `series` is a prop and may change.
  let src = $state<string | undefined>(undefined);
  let tile = $state<HTMLElement | null>(null);

  /**
   * A failed draw is about one URL, not about the title.
   *
   * The first attempt may be the plain network URL and the second the cached blob (or the reverse,
   * once the cache has it): keeping `broken` from the first attempt left a working picture hidden
   * behind the title for the rest of the session.
   */
  $effect(() => {
    void src;
    broken = false;
  });

  $effect(() => {
    const url = series.cover;
    if (url === undefined || url === "") {
      src = undefined;
      untrack(() => onresolve?.(undefined));
      return;
    }
    let live = true;
    const needsLogin = series.coverHeaders !== undefined;
    const initial = loadable(url, needsLogin);
    src = initial;
    // Do not read `src` here: that subscribes this loader to its own async result, resetting
    // the blob to the network URL (or undefined for authenticated covers) on every resolution.
    untrack(() => onresolve?.(initial));
    // A cover that failed anonymously can still be fetched with the login, so a changed series must
    // not stay broken from the previous attempt.
    broken = false;
    const headers = series.coverHeaders;
    // Only a tile that is (nearly) on screen is worth fetching: a 5 000-title library was resolving
    // every cover the moment the shelf opened, which is thousands of images for the forty visible.
    const target = tile;
    if (target === null) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void imageCache.resolve(url, headers === undefined ? {} : { headers }).then((resolved) => {
          if (live && resolved !== url) {
            src = resolved;
            onresolve?.(resolved);
          }
        });
      },
      { rootMargin: "200% 0px" },
    );
    observer.observe(target);
    return () => {
      live = false;
      observer.disconnect();
    };
  });
</script>

<div class="cover {size}" bind:this={tile}>
  {#if series.cover && !broken && src !== undefined}
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
