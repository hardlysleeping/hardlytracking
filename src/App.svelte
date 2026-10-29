<script lang="ts">
  import { onMount } from "svelte";
  import Library from "./views/Library.svelte";
  import Browse from "./views/Browse.svelte";
  import Series from "./views/Series.svelte";
  import Reader from "./views/Reader.svelte";
  import { library } from "./state/library.svelte";
  import { go, parseRoute } from "./lib/nav";

  let route = $state(parseRoute(location.hash));

  onMount(() => {
    const onHash = () => (route = parseRoute(location.hash));
    addEventListener("hashchange", onHash);
    void library.open();
    return () => removeEventListener("hashchange", onHash);
  });
</script>

<div class="shell">
  <nav>
    <button class="brand" onclick={() => go("/library")}>HardlyTracking</button>
    <button class="tab" class:on={route.name === "library"} onclick={() => go("/library")}>Library</button>
    <button class="tab" class:on={route.name === "browse"} onclick={() => go("/browse")}>Browse</button>
    <span class="spacer"></span>
    <span class="profile">{library.profile?.label ?? "opening…"}</span>
  </nav>

  <main>
    {#if route.name === "browse"}
      <Browse />
    {:else if route.name === "series" && route.id !== null}
      <Series seriesId={route.id} />
    {:else if route.name === "read" && route.id !== null && route.chapterId !== null}
      <Reader seriesId={route.id} chapterId={route.chapterId} />
    {:else}
      <Library />
    {/if}
  </main>
</div>

<style>
  .shell {
    max-width: 1100px;
    margin: 0 auto;
    padding: 18px 20px 60px;
  }
  nav {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 26px;
  }
  .brand {
    all: unset;
    cursor: pointer;
    font-weight: 600;
    font-size: 14px;
    letter-spacing: 0.01em;
    margin-right: 14px;
  }
  .tab {
    all: unset;
    cursor: pointer;
    font-size: 13px;
    color: #8a8a96;
    padding: 5px 10px;
    border-radius: 999px;
  }
  .tab.on {
    color: #e6e6ee;
    background: #1c1c22;
  }
  .spacer {
    flex: 1;
  }
  .profile {
    font-size: 12px;
    color: #6f6f7c;
  }
</style>
