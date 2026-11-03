<script lang="ts">
  import { onDestroy } from "svelte";
  import { appearance, THEME_OPTIONS } from "../lib/theme.svelte";
  import { MAX_BG_BLUR, MAX_BG_DIM, type ColourKey } from "../lib/theme-model";
  import { backgroundFromFile } from "../lib/theme-background";
  let error = $state("");
  let busy = $state(false);
  let generation = 0;
  const colours: { key: ColourKey; label: string; help: string }[] = [
    { key: "accent", label: "Accent", help: "Focus and selected controls" },
    { key: "hidden", label: "Hidden", help: "Hidden items and eye controls" },
    { key: "pinned", label: "Pinned", help: "Pins and pinned collections" },
    { key: "lockOpen", label: "Lock open", help: "An open lock" },
    { key: "lockClosed", label: "Lock closed", help: "A locked control" },
    { key: "unlock", label: "Unlock", help: "Unlock confirmation" },
    { key: "sync", label: "Sync", help: "Sync actions and progress" },
    { key: "trim", label: "Trim", help: "Read marks and quiet edges" },
    { key: "link", label: "Link", help: "Open-at-source actions" },
    { key: "star", label: "Star", help: "Starred marks" },
  ];
  async function pick(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    const request = ++generation;
    busy = true; error = "";
    try {
      const url = await backgroundFromFile(file);
      if (request === generation) appearance.set("bgImage", url);
    } catch (e) { if (request === generation) error = e instanceof Error ? e.message : "Could not load image."; }
    finally { if (request === generation) busy = false; }
  }
  function clearImage() { generation++; busy = false; error = ""; appearance.set("bgImage", null); }
  function reset() { generation++; busy = false; error = ""; appearance.reset(); }
  onDestroy(() => { generation++; });
</script>

<section class="theme-panel" aria-label="Theme customization">
  <fieldset>
    <legend>Theme mode</legend>
    <div class="modes" role="group" aria-label="Base theme">
      {#each THEME_OPTIONS as mode}
        <button class="chip" class:on={appearance.theme === mode.id} aria-pressed={appearance.theme === mode.id} onclick={() => appearance.apply(mode.id)}>{mode.label}</button>
      {/each}
    </div>
    <label class="toggle"><input type="checkbox" checked={appearance.current.accentEdges} onchange={e => appearance.set("accentEdges", e.currentTarget.checked)} />Accent-colored edges</label>
    <label class="toggle"><input type="checkbox" checked={appearance.current.monotoneActions} onchange={e => appearance.set("monotoneActions", e.currentTarget.checked)} />Monotone actions <span class="muted">(read, link and star only)</span></label>
  </fieldset>
  <fieldset>
    <legend>Meaningful colors</legend>
    <p>Each mark keeps its own color. Text shades adjust for readability.</p>
    <div class="palette">
      {#each colours as item}
        <label class="swatch" title={item.help}>
          <span>{item.label}<small>{appearance.current[item.key]}</small></span>
          <input type="color" aria-label={`${item.label} color`} value={appearance.current[item.key]} oninput={e => appearance.set(item.key, e.currentTarget.value)} />
        </label>
      {/each}
    </div>
    <div class="preview" aria-label="Action color preview">
      {#each colours.filter(c => c.key !== "accent") as item}
        <span data-tone={item.key.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}>{item.label}</span>
      {/each}
      <span class="theme-action-star">★ Star action</span><span class="theme-action-read">✓ Read action</span><span class="theme-action-link">↗ Link action</span>
    </div>
  </fieldset>
  <fieldset>
    <legend>Page background</legend>
    <div class="row">
      <label class="page-color">Page color <input type="color" aria-label="Page background color" value={appearance.current.bg ?? "#0e0e12"} oninput={e => appearance.set("bg", e.currentTarget.value)} /></label>
      <button class="btn" disabled={appearance.current.bg === null} onclick={() => appearance.set("bg", null)}>Default</button>
    </div>
    <div class="row">
      <label class="file btn">{busy ? "Preparing…" : appearance.current.bgImage ? "Replace background image" : "Choose background image"}<input aria-label="Background image" type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" onchange={pick} disabled={busy} /></label>
      <button class="btn" disabled={!appearance.current.bgImage && !busy} onclick={clearImage}>Clear image</button>
    </div>
    <p>Local to this device. Images are resized before saving; no upload. Solid reading layers keep text readable over any color or photo.</p>
    <label class="slider">Blur <output>{appearance.current.bgBlur}px</output><input aria-label="Background blur" type="range" min="0" max={MAX_BG_BLUR} step="1" value={appearance.current.bgBlur} oninput={e => appearance.set("bgBlur", +e.currentTarget.value)} /></label>
    <label class="slider">Dim <output>{appearance.current.bgDim}%</output><input aria-label="Background dim" type="range" min="0" max={MAX_BG_DIM} step="1" value={appearance.current.bgDim} oninput={e => appearance.set("bgDim", +e.currentTarget.value)} /></label>
    <label class="toggle"><input type="checkbox" checked={appearance.current.bgGlass} onchange={e => appearance.set("bgGlass", e.currentTarget.checked)} />Glass panels</label>
  </fieldset>
  {#if error || appearance.storageError}<p role="alert">{error || appearance.storageError}</p>{/if}
  <button class="btn" onclick={reset}>Reset all theme settings</button>
</section>

<style>
  .theme-panel { min-width: 0; max-width: 760px; color: var(--text-1); background: var(--bg); padding: var(--s3); border-radius: var(--r2); }
  fieldset { min-width: 0; margin: 0 0 var(--s4); padding: var(--s3); border: 1px solid var(--line); border-radius: var(--r2); }
  legend { font-weight: 600; padding: 0 var(--s2); }
  p { color: var(--text-2); font-size: var(--t-sm); margin: var(--s2) 0 var(--s3); }
  .modes, .row, .toggle, .preview { display: flex; align-items: center; gap: var(--s2); flex-wrap: wrap; }
  .toggle { margin-top: var(--s3); }
  .toggle input { width: 20px; height: 20px; flex: none; }
  .palette { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: var(--s2); }
  .swatch { min-width: 0; display: flex; justify-content: space-between; align-items: center; gap: var(--s2); padding: var(--s2); background: var(--surface); border-radius: var(--r1); }
  small { display: block; color: var(--text-2); font-size: var(--t-sm); }
  input[type="color"] { width: 48px; height: 40px; flex: none; border: 1px solid var(--line-strong); border-radius: var(--r1); background: var(--surface); }
  input { accent-color: var(--accent); }
  .row { margin: var(--s3) 0; }
  .page-color { display: flex; align-items: center; gap: var(--s2); }
  .file { position: relative; white-space: normal; overflow: hidden; }
  .file input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
  .file:focus-within { outline: 2px solid var(--accent-text); outline-offset: 2px; }
  .slider { display: grid; grid-template-columns: 1fr auto; gap: var(--s2); margin-top: var(--s3); }
  .slider input { grid-column: 1 / -1; width: 100%; min-width: 0; margin: 0; min-height: 32px; }
  output { color: var(--text-2); }
  .preview { margin-top: var(--s3); background: var(--surface); padding: var(--s2); border-radius: var(--r1); font-size: var(--t-sm); }
  .theme-panel > .btn { white-space: normal; }
</style>
