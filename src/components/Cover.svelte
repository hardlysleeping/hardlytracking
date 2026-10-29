<script lang="ts">
  /** A cover, with the honest fallback: a title, not a broken image icon. */
  interface Props {
    series: { title: string; cover?: string };
    size?: "grid" | "hero";
  }
  let { series, size = "grid" }: Props = $props();
  let broken = $state(false);
</script>

<div class="cover {size}">
  {#if series.cover && !broken}
    <img src={series.cover} alt="" loading="lazy" onerror={() => (broken = true)} />
  {:else}
    <span class="fallback">{series.title}</span>
  {/if}
</div>

<style>
  .cover {
    position: relative;
    overflow: hidden;
    border-radius: 10px;
    background: #1c1c22;
    display: grid;
    place-items: center;
  }
  .cover.grid {
    aspect-ratio: 2 / 3;
  }
  .cover.hero {
    width: 132px;
    aspect-ratio: 2 / 3;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .fallback {
    padding: 10px;
    font-size: 12px;
    line-height: 1.3;
    color: #9a9aa5;
    text-align: center;
  }
</style>
