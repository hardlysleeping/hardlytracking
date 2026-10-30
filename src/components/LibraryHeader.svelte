<script lang="ts">
  /**
   * The library's top bar: a large title that gets out of the way, and the four things a reader
   * reaches for.
   *
   * The title is the screen's name and the count is its state — `12 of 340` while a collection,
   * a filter or a search narrows the shelf. Once the shelf is scrolled the title collapses to a
   * 44 px bar so the grid keeps the pixels; the count stays beside it in both states, because
   * losing the number is worse than losing the word.
   *
   * The three icons keep the `aria-label`s they have always had (the parity contract names them),
   * and `⋯` is the home of the rarer actions, not a replacement for them.
   */
  import type { SearchScope } from "../lib/library/search";

  interface Props {
    /** Rows on screen. */
    count: number;
    /** Rows in the library, before anything narrows them. */
    total: number;
    searching: boolean;
    text: string;
    scope: SearchScope;
    selecting: boolean;
    onsearch: () => void;
    onclosesearch: () => void;
    onselect: () => void;
    onrefresh: () => void;
    onoverflow: () => void;
    ontext: (value: string) => void;
    onscope: (scope: SearchScope) => void;
  }
  let {
    count,
    total,
    searching,
    text,
    scope,
    selecting,
    onsearch,
    onclosesearch,
    onselect,
    onrefresh,
    onoverflow,
    ontext,
    onscope,
  }: Props = $props();

  /** Collapsed once the shelf has moved: 24 px is a scroll, not a rubber-band bounce. */
  let collapsed = $state(false);

  $effect(() => {
    const read = (): void => {
      collapsed = window.scrollY > 24;
    };
    read();
    window.addEventListener("scroll", read, { passive: true });
    return () => window.removeEventListener("scroll", read);
  });
</script>

<header class="top" class:collapsed>
  <div class="titles">
    <h1>Library</h1>
    {#if total > 0}
      <span class="count">{count}{count !== total ? ` of ${total}` : ""}</span>
    {/if}
  </div>
  {#if total > 0}
    <div class="acts">
      <button
        class="btn ghost icon"
        aria-label="Search the library"
        aria-pressed={searching}
        onclick={onsearch}
      >
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
      </button>
      <button
        class="btn ghost icon"
        aria-label="Select series"
        aria-pressed={selecting}
        onclick={onselect}
      >
        <svg viewBox="0 0 24 24"><path d="M4 7h10M4 12h10M4 17h7M17 15l2 2 3-3" /></svg>
      </button>
      <button class="btn ghost icon" aria-label="Refresh" onclick={onrefresh}>
        <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v4h-4" /></svg>
      </button>
      <button class="btn ghost icon" aria-label="More library actions" onclick={onoverflow}>
        <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
      </button>
    </div>
  {/if}
</header>

{#if searching}
  <div class="searchbar">
    <button class="btn ghost icon" aria-label="Close search" onclick={onclosesearch}>
      <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
    </button>
    <input
      class="field"
      type="search"
      placeholder="Search library"
      aria-label="Search this library"
      value={text}
      oninput={(event) => ontext(event.currentTarget.value)}
    />
    <div class="scopes" role="group" aria-label="Search scope">
      <button
        class="chip"
        class:on={scope === "category"}
        aria-pressed={scope === "category"}
        onclick={() => onscope("category")}
      >
        This collection
      </button>
      <button
        class="chip"
        class:on={scope === "all"}
        aria-pressed={scope === "all"}
        onclick={() => onscope("all")}
      >
        All library
      </button>
    </div>
  </div>
{/if}

<style>
  .top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding-top: var(--safe-t);
    margin-bottom: var(--s3);
    min-height: 52px;
    transition: min-height var(--dur), padding var(--dur);
  }

  /* Collapsed: the name stays, the type gets small — a 44 px bar, measured on a phone. */
  .top.collapsed {
    min-height: 44px;
    margin-bottom: var(--s2);
  }

  .titles {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    min-width: 0;
  }

  h1 {
    font-size: var(--t-2xl);
    font-weight: 650;
    transition: font-size var(--dur);
  }

  .top.collapsed h1 {
    font-size: var(--t-lg);
  }

  .count {
    font-size: var(--t-sm);
    color: var(--text-3);
    white-space: nowrap;
  }

  .acts {
    display: flex;
    gap: 2px;
  }

  .acts svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .searchbar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s3);
    flex-wrap: wrap;
  }

  .searchbar .field {
    flex: 1;
    min-width: 140px;
    min-height: 38px;
  }

  .searchbar svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.6;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .scopes {
    display: flex;
    gap: var(--s1);
  }
</style>
