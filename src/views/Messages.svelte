<script lang="ts">
  /**
   * Messages: the page behind the bell in Settings.
   *
   * One list, newest first, and nothing to press: opening this screen is what
   * marks the list read, so there is no per-message control to miss and no badge
   * to clear by hand. A message is the app's author writing to an account — an
   * outage, a promotion, "your lifetime upgrade is on the account" — so a row is
   * a title, a date, and the words.
   *
   * Two things it refuses to do:
   *
   * - **Never draw an empty list where the truth is "could not ask".** A failed
   *   fetch with no cached copy says why it failed; a cached copy is drawn with
   *   the sentence that says it is the last one this device saw.
   * - **Never draw "no messages" for a signed-out device.** Messages belong to an
   *   account; without one the page says so rather than pretending the inbox is
   *   empty, and Settings does not link here at all.
   */
  import { inbox } from "../state/inbox.svelte";
  import { go } from "../lib/nav";

  /**
   * The date, short and without a time of day — the same shape the history
   * screen uses for a row's own timestamp.
   */
  function when(ms: number): string {
    return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function isoOf(ms: number): string {
    return new Date(ms).toISOString();
  }

  /**
   * Opening the page is reading it.
   *
   * `load()` is awaited first so the ids marked read are the ones actually on
   * screen — and it shares the in-flight promise with Settings' own count fetch,
   * so arriving here costs one request at most, never a second copy of the list.
   */
  $effect(() => {
    void (async () => {
      await inbox.load();
      await inbox.readAll();
    })();
  });
</script>

<section class="view">
  <!-- The pinned band owns the status-bar inset, like every other screen's header: without it this
       one started at y=0, under the clock, and shoved the list down by the height of a second bar. -->
  <div class="pin">
    <header class="bar">
      <button class="btn ghost icon" aria-label="Back" onclick={() => go("/settings")}>
        <svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7" /></svg>
      </button>
      <h1>Messages</h1>
    </header>
  </div>

  {#if inbox.status === "loading" && inbox.messages.length === 0}
    <p class="hint">Checking for messages…</p>
  {:else if inbox.status === "failed"}
    <p class="hint">{inbox.reason}</p>
  {:else if !inbox.signedIn}
    <p class="hint">
      Messages come with a HardlySyncing account: they are addressed to you, so there has to be an
      account to address. Sign in on the HardlySyncing row in Settings and this page fills itself.
    </p>
  {:else if inbox.messages.length === 0}
    <p class="hint">
      No messages. Notes about HardlyTracking, your account, or a promotion will appear here —
      nothing pops up on screen when one arrives.
    </p>
  {:else}
    {#if inbox.reason !== null}
      <p class="hint" role="status">{inbox.reason}</p>
    {/if}
    <ul class="msgs">
      {#each inbox.messages as message (message.id)}
        <li class="msg" class:unread={message.readAt === null}>
          <p class="head">
            {#if message.readAt === null}<span class="dot" aria-label="Unread"></span>{/if}
            <span class="title">{message.title}</span>
            <time class="when" datetime={isoOf(message.publishedAt)}>{when(message.publishedAt)}</time>
          </p>
          <p class="body">{message.body}</p>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .view {
    padding: var(--s3) var(--s4) var(--s7);
    max-width: 720px;
    /* The shell's main has no top padding — the pinned band adds the safe area itself. */
    --pad-x: var(--s4);
    --pad-y: var(--s3);
  }

  .bar {
    display: flex;
    align-items: center;
    gap: var(--s2);
    padding-bottom: var(--s3);
  }

  .bar svg {
    width: 18px;
    height: 18px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.7;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  h1 {
    font-size: var(--t-xl);
    font-weight: 650;
  }

  .msgs {
    display: grid;
    gap: var(--s3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .msg {
    padding-bottom: var(--s3);
    border-bottom: 1px solid var(--line);
  }

  .msg:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }

  .head {
    display: flex;
    align-items: baseline;
    gap: var(--s2);
    margin: 0 0 var(--s1) 0;
    min-width: 0;
  }

  .dot {
    flex: 0 0 auto;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    transform: translateY(-1px);
  }

  .title {
    flex: 1 1 auto;
    min-width: 0;
    font-size: var(--t-md);
    font-weight: 600;
  }

  .when {
    flex: 0 0 auto;
    font-size: var(--t-xs);
    color: var(--text-3);
    white-space: nowrap;
  }

  .body {
    margin: 0;
    font-size: var(--t-sm);
    line-height: 1.6;
    color: var(--text-2);
    /* A message is prose: a line break the author wrote is a line break. */
    white-space: pre-line;
    max-width: 62ch;
  }

  .hint {
    margin: 0 0 var(--s2) 0;
    font-size: var(--t-sm);
    color: var(--text-3);
    line-height: 1.6;
    max-width: 62ch;
  }
</style>
