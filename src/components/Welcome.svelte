<script lang="ts">
  /**
   * The first run — three doors, and the sentence that answers "what is this app for".
   *
   * App Store review reads the first screen before it reads anything else, so the first screen says
   * what the app is *not*: it ships no comics and no list of sites. The three things it does do are
   * the three buttons, in the order they matter — a file you already own needs no server and no
   * network, your own server is your own login, and the Internet Archive is the only public
   * collection it knows about.
   *
   * Deliberately absent: an "add a repository" door. The extension flow belongs in Extensions,
   * where it is discoverable and where it reads as an optional plugin system rather than the front
   * door of a piracy client.
   */
  import AddFiles from "./AddFiles.svelte";
  import { settings } from "../state/settings.svelte";
  import { go } from "../lib/nav";

  /** Write the flag and land somewhere — the screen is a start, not a gate. */
  function done(then?: () => void): void {
    settings.set("welcomed", true);
    then?.();
  }
</script>

<div class="welcome" role="dialog" aria-modal="true" aria-labelledby="welcome-title">
  <div class="sheet">
    <p class="kicker">HardlyTracking</p>
    <h1 id="welcome-title">Where do your comics come from?</h1>
    <p class="lede">
      HardlyTracking has no comics of its own. You choose every source, and you can remove it at any
      time.
    </p>

    <div class="doors">
      <div class="door">
        <p class="door-name">Files on this device</p>
        <p class="door-hint">CBZ, CBR or PDF you bought and downloaded. No server, no network.</p>
        <AddFiles look="primary" label="Add comic files" onimport={() => done()} />
      </div>

      <button class="door" onclick={() => done(() => go("/extensions"))}>
        <p class="door-name">My own server</p>
        <p class="door-hint">Komga or Suwayomi on your machine, your login. Nothing is sent anywhere else.</p>
        <span class="door-go">Set up a server →</span>
      </button>

      <button class="door" onclick={() => done(() => go("/browse"))}>
        <p class="door-name">Internet Archive</p>
        <p class="door-hint">Public-domain and openly licensed scans, already built in.</p>
        <span class="door-go">Browse the Archive →</span>
      </button>
    </div>

    <button class="skip" onclick={() => done()}>Open the library</button>
  </div>
</div>

<style>
  .welcome {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: calc(var(--safe-t) + 16px) var(--pad-x) calc(var(--safe-b) + 16px);
    background: var(--bg);
    overflow: auto;
  }
  .sheet {
    width: min(560px, 100%);
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .kicker {
    margin: 0;
    font-size: var(--t-xs);
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
  }
  h1 {
    margin: 0;
    font-size: var(--t-xl);
    line-height: 1.15;
  }
  .lede {
    margin: 0;
    color: var(--muted);
    font-size: var(--t-md);
    line-height: 1.5;
  }
  .doors {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 4px;
  }
  .door {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
    width: 100%;
    padding: 14px;
    text-align: left;
    background: var(--surface);
    border: 1px solid var(--line);
    border-radius: var(--r);
    color: var(--fg);
    font: inherit;
    cursor: pointer;
  }
  .door:hover,
  .door:focus-visible {
    border-color: var(--line-strong);
  }
  .door-name {
    margin: 0;
    font-size: var(--t-md);
    font-weight: 600;
  }
  .door-hint {
    margin: 0;
    color: var(--muted);
    font-size: var(--t-sm);
    line-height: 1.45;
  }
  .door-go {
    /* The doors are white cards in every theme, so this cannot take the theme's
       text accent: in dark that is #7aa2ff, 2.5:1 on white. */
    color: #2a63f0;
    font-size: var(--t-sm);
  }
  .skip {
    align-self: center;
    margin-top: 6px;
    padding: 10px 14px;
    background: none;
    border: none;
    color: var(--muted);
    font: inherit;
    font-size: var(--t-sm);
    cursor: pointer;
    text-decoration: underline;
  }
</style>
