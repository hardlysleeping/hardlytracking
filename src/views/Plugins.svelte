<script lang="ts">
  /**
   * Plugin Manager.
   *
   * What it is careful about: a plugin is a program someone else wrote that you chose to run. So the
   * screen shows the four things that decision depends on — what it is, which version, what it may
   * read, and whether it is on — and nothing else. Enable, disable, remove: the three verbs a person
   * actually needs, each in one tap and each reversible except the last.
   *
   * Installing is a file picker, because a `.htp` a person downloaded is the only thing this build
   * can trust: there is no store to fetch from until the community catalogue ships, and no network
   * request happens while a package is being read.
   */
  import { PLUGIN_STORAGE_LIMIT_BYTES, PERMISSION_LABELS, type Permission } from "../plugins/index";
  import { plugins } from "../state/plugins.svelte";
  import { go } from "../lib/nav";

  let picker: HTMLInputElement | null = $state(null);
  let notice = $state("");
  let error = $state("");

  const installed = $derived(plugins.list);

  async function pick(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (file === undefined) return;
    notice = "";
    error = "";
    plugins.busy = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const outcome = await plugins.install(bytes);
      if (outcome !== null && !outcome.ok) error = outcome.problem;
      else if (outcome !== null) notice = outcome.updated ? "Updated." : "Installed.";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      plugins.busy = false;
    }
  }

  function label(permission: string): string {
    return PERMISSION_LABELS[permission as Permission] ?? permission;
  }
</script>

<section class="view">
  <header class="top">
    <h1>Plugins</h1>
    <button class="btn" onclick={() => picker?.click()} disabled={plugins.busy}>
      {plugins.busy ? "Reading…" : "Install .htp"}
    </button>
    <input bind:this={picker} type="file" accept=".htp,.zip" hidden onchange={pick} />
  </header>

  {#if plugins.approval !== null}
    <!--
      The permission prompt. It names what is new, not what is total: a person deciding whether to
      run an update needs to see the difference from what they already allowed.
    -->
    <div class="approval" role="dialog" aria-label="New permissions">
      <p class="atitle">{plugins.approval.name} {plugins.approval.version} asks for:</p>
      <ul>
        {#each plugins.approval.fresh as permission (permission)}
          <li>{label(permission)}</li>
        {/each}
      </ul>
      <div class="row">
        <button class="btn primary" onclick={() => plugins.approval?.resolve(true)}>Allow and install</button>
        <button class="btn ghost" onclick={() => plugins.approval?.resolve(false)}>Cancel</button>
      </div>
    </div>
  {/if}

  {#if plugins.error !== "" || error !== ""}
    <p class="banner">{plugins.error || error}</p>
  {/if}
  {#if plugins.notice !== "" || notice !== ""}
    <p class="notice" role="status">{plugins.notice || notice}</p>
  {/if}

  {#if installed.length === 0}
    <div class="blank">
      <p class="blankline">No plugins installed.</p>
      <p class="blanksub">
        A plugin is a small program someone wrote for this app — an extra menu entry, a panel, a
        setting of its own. It runs sandboxed: it can read the titles you have and its own settings,
        and nothing else. Installing one is picking a <code>.htp</code> file you trust.
      </p>
      <button class="btn primary" onclick={() => picker?.click()}>Install a plugin</button>
    </div>
  {:else}
    <ul class="list">
      {#each installed as plugin (plugin.id)}
        <li class="card" class:off={!plugin.enabled}>
          <div class="head">
            <div class="names">
              <span class="t">{plugin.name}</span>
              <span class="s">{plugin.id} · {plugin.version}</span>
            </div>
            <button
              class="btn ghost"
              aria-pressed={plugin.enabled}
              onclick={() => (plugin.enabled ? plugins.disable(plugin.id) : plugins.enable(plugin.id))}
            >
              {plugin.enabled ? "Turn off" : "Turn on"}
            </button>
          </div>

          {#if plugin.manifest.description !== undefined}
            <p class="desc">{plugin.manifest.description}</p>
          {/if}

          <div class="perms">
            <span class="label">May</span>
            {#each plugin.grantedPermissions as permission (permission)}
              <span class="chip on">{label(permission)}</span>
            {/each}
          </div>

          {#if plugin.failures > 0}
            <p class="note warn">
              It did not start {plugin.failures} time{plugin.failures === 1 ? "" : "s"} in a row{plugin.lastKnownGoodVersion !== undefined
                ? `, and ${plugin.lastKnownGoodVersion} is installed in its place`
                : ""}.
            </p>
          {/if}

          <div class="row">
            <button
              class="btn ghost"
              onclick={() => {
                if (confirm(`Remove ${plugin.name} and everything it stored?`)) void plugins.uninstall(plugin.id);
              }}
            >
              Remove
            </button>
            <span class="muted small">Stores at most {PLUGIN_STORAGE_LIMIT_BYTES / 1024} KB of its own settings</span>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <p class="footer muted small">
    Plugins are not comics sources — those are extensions, under
    <button class="link" onclick={() => go("/extensions")}>Extensions</button>.
  </p>
</section>

<style>
  .top {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-bottom: var(--s4);
  }

  .top h1 {
    margin-right: auto;
  }

  .approval {
    display: grid;
    gap: var(--s2);
    padding: var(--s4);
    margin-bottom: var(--s4);
    border: 1px solid var(--line-strong);
    border-radius: var(--r2);
    background: var(--surface);
  }

  .atitle {
    font-weight: 650;
  }

  .approval ul {
    display: grid;
    gap: var(--s1);
    margin: 0;
    padding-left: var(--s5);
    color: var(--text-2);
    font-size: var(--t-sm);
  }

  .list {
    display: grid;
    gap: var(--s3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .card {
    display: grid;
    gap: var(--s3);
    padding: var(--s4);
    border: 1px solid var(--line);
    border-radius: var(--r2);
    background: var(--surface);
  }

  .card.off {
    opacity: 0.7;
  }

  .head {
    display: flex;
    align-items: start;
    gap: var(--s2);
  }

  .names {
    display: grid;
    gap: 2px;
    margin-right: auto;
    min-width: 0;
  }

  .t {
    font-weight: 650;
  }

  .s {
    color: var(--text-2);
    font-size: var(--t-xs);
    overflow-wrap: anywhere;
  }

  .desc {
    margin: 0;
    color: var(--text-2);
    font-size: var(--t-sm);
  }

  .perms {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    align-items: center;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s2);
    align-items: center;
  }

  .small {
    font-size: var(--t-xs);
  }

  .footer {
    margin-top: var(--s5);
  }

  .link {
    padding: 0;
    border: 0;
    background: none;
    color: var(--tone-pinned);
    font: inherit;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
