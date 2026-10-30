<script lang="ts">
  /**
   * One source's own settings, in the app instead of in the runtime.
   *
   * A self-hosted source keeps its address and login in its preference screen — Komga and Suwayomi
   * both do — so a reader that cannot show that screen cannot use them at all. The values are
   * stored on this device and sent with every call (see `wirePreferences`), which also survives a
   * runtime restart: the runtime's own store is memory-only.
   *
   * When the schema cannot be built the sheet says so with the runtime's words and offers named
   * rows instead. That is not a fallback nobody asked for: some extension builds crash the
   * runtime's bytecode verifier while constructing the screen, and a blank panel would read as
   * "this source has no settings".
   */
  import Sheet from "./Sheet.svelte";
  import { library } from "../state/library.svelte";
  import {
    applyStored,
    manualField,
    readPrefSchema,
    storedFields,
    type PrefField,
  } from "../lib/extensions/prefs";

  interface Props {
    open: boolean;
    sourceId: string;
    onclose: () => void;
  }
  let { open, sourceId, onclose }: Props = $props();

  let fields = $state<PrefField[]>([]);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let saved = $state(false);
  /** A key the user typed, for a source whose screen the runtime could not build. */
  let manualKey = $state("");
  let manualValue = $state("");

  /** `dalvik:src:<id>` -> `<id>`, the id the runtime and the extension both use. */
  const bare = $derived(sourceId.replace(/^dalvik:src:/, ""));

  const host = $derived(library.profile?.dalvik ?? null);
  const extension = $derived(host?.extensions.find((row) => row.sources.some((source) => source.id === bare)) ?? null);

  $effect(() => {
    if (open) void load();
  });

  async function load(): Promise<void> {
    fields = [];
    error = null;
    saved = false;
    if (host === null || extension === null) {
      error = "This source is not served by the extension runtime.";
      return;
    }
    busy = true;
    try {
      const stored = await library.profile?.store.getSourcePrefs(bare);
      // A schema that fails must not lose what the user already saved: the stored fields stand in.
      try {
        const raw = await host.client.preferences(extension.extensionId, bare);
        fields = applyStored(readPrefSchema(raw), snapshotOf(stored));
        if (fields.length === 0) error = "This extension declares no settings.";
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
        fields = stored ?? [];
      }
    } finally {
      busy = false;
    }
  }

  /** Stored fields as the loose map `applyStored` reads. */
  function snapshotOf(stored: PrefField[] | undefined): Record<string, unknown> | undefined {
    if (stored === undefined) return undefined;
    const map: Record<string, unknown> = {};
    for (const field of stored) map[field.key] = field.value;
    return map;
  }

  function addManual(): void {
    const key = manualKey.trim();
    if (key === "") return;
    const at = fields.findIndex((field) => field.key === key);
    const field = manualField(key, manualValue);
    fields = at >= 0 ? fields.map((row, index) => (index === at ? { ...row, value: manualValue } : row)) : [...fields, field];
    manualKey = "";
    manualValue = "";
  }

  async function save(): Promise<void> {
    const store = library.profile?.store;
    if (store === undefined) return;
    try {
      await store.setSourcePrefs(bare, storedFields(fields));
    } catch (cause) {
      // A write that fails must say so: a sheet that closes on a failed save looks like it worked.
      error = cause instanceof Error ? cause.message : String(cause);
      return;
    }
    error = null;
    saved = true;
    // The next call reads the new values; the sheet stays open so a second field can be fixed
    // without hunting for the button again.
    fields = storedFields(fields);
  }
</script>

<Sheet {open} title="Source settings" {onclose}>
  {#if busy}
    <p class="muted">Asking the extension for its settings…</p>
  {:else}
    {#if error !== null}
      <p class="banner">{error}</p>
      <p class="muted small">
        The runtime could not build this extension's settings screen. Its keys are still usable: add them by name.
      </p>
    {:else if fields.length === 0}
      <p class="muted">This source has no settings.</p>
    {/if}

    {#each fields as field (field.key)}
      <div class="row">
        <div class="label">
          <span>{field.title}</span>
          {#if field.summary}<span class="muted small">{field.summary}</span>{/if}
          {#if field.kind === "text"}<span class="muted small mono">{field.key}</span>{/if}
        </div>
        {#if field.kind === "switch"}
          <button
            class="switch"
            class:on={field.value === true}
            aria-label={field.title}
            aria-pressed={field.value === true}
            onclick={() => (fields = fields.map((row) => (row.key === field.key ? { ...row, value: !(row.value === true) } : row)))}
          ><span></span></button>
        {:else if field.kind === "select"}
          <select
            aria-label={field.title}
            value={String(field.value)}
            onchange={(event) => {
              const next = (event.currentTarget as HTMLSelectElement).value;
              fields = fields.map((row) => (row.key === field.key ? { ...row, value: next } : row));
            }}
          >
            {#each field.entryValues ?? [] as value, index (value)}
              <option {value}>{field.entries?.[index] ?? value}</option>
            {/each}
          </select>
        {:else if field.kind === "multi"}
          <div class="chips">
            {#each field.entryValues ?? [] as value, index (value)}
              <button
                class="chip"
                class:on={Array.isArray(field.value) && field.value.includes(value)}
                onclick={() => {
                  const current = Array.isArray(field.value) ? field.value : [];
                  const chosen = current.includes(value);
                  const next = chosen ? current.filter((item) => item !== value) : [...current, value];
                  fields = fields.map((row) => (row.key === field.key ? { ...row, value: next } : row));
                }}
              >{field.entries?.[index] ?? value}</button>
            {/each}
          </div>
        {:else}
          <input
            type={/pass/i.test(field.key) ? "password" : "text"}
            aria-label={field.title}
            value={String(field.value)}
            placeholder={field.title}
            oninput={(event) => {
              const next = (event.currentTarget as HTMLInputElement).value;
              fields = fields.map((row) => (row.key === field.key ? { ...row, value: next } : row));
            }}
          />
        {/if}
      </div>
    {/each}

    <div class="manual">
      <input placeholder="Key" bind:value={manualKey} aria-label="Setting key" />
      <input placeholder="Value" bind:value={manualValue} aria-label="Setting value" />
      <button class="btn ghost" onclick={addManual} disabled={manualKey.trim() === ""}>Add</button>
    </div>

    <div class="actions">
      <button class="btn" onclick={() => void save()} disabled={fields.length === 0}>Save</button>
      {#if saved}<span class="muted small">Saved. The next page uses it.</span>{/if}
    </div>
  {/if}
</Sheet>

<style>
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--s3);
    padding: var(--s2) 0;
    border-bottom: 1px solid var(--line);
  }
  .label {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .small {
    font-size: var(--t-xs);
  }
  .mono {
    font-family: var(--mono, monospace);
    opacity: 0.7;
  }
  input,
  select {
    max-width: 55%;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--s1);
    justify-content: flex-end;
  }
  .switch {
    width: 44px;
    height: 26px;
    border-radius: 999px;
    border: 1px solid var(--line);
    background: var(--surface-2, transparent);
    padding: 2px;
    flex: none;
  }
  .switch span {
    display: block;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: currentColor;
    transition: transform 120ms ease;
  }
  .switch.on span {
    transform: translateX(18px);
  }
  .manual {
    display: flex;
    gap: var(--s1);
    margin-top: var(--s3);
  }
  .manual input {
    max-width: none;
    flex: 1;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: var(--s2);
    margin-top: var(--s3);
  }
</style>
