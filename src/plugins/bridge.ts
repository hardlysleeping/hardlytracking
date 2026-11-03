/**
 * The wire between the app and a plugin running in a sandboxed iframe.
 *
 * `sandbox="allow-scripts"` without `allow-same-origin` gives the frame an **opaque origin**: it can
 * run code and nothing else — no cookies, no `localStorage`, no reaching into `window.parent`, no
 * `fetch` to anywhere (its CSP forbids it). That isolation is real, and it is also why the origin
 * cannot be used to authenticate a message: every such frame has the origin `null`.
 *
 * So the sender is identified three other ways, and all three must hold:
 *
 * 1. **The channel.** A random 128-bit string, generated per instance, sent only inside that
 *    instance's document. A message from another instance cannot guess it.
 * 2. **The plugin id.** The manifest id, matched against the record the channel belongs to.
 * 3. **The `WindowProxy`.** The host remembers the `source` object it created for this instance and
 *    refuses a message whose `source` is a different window — so a plugin cannot relay another
 *    plugin's traffic, and a stray frame cannot speak as one.
 *
 * Everything else is refused by shape: unknown kinds, unknown methods, oversized payloads, missing
 * ids. Refusals are silent to the plugin (it gets no answer and its call times out) and logged to the
 * host's own diagnostics, because telling a hostile frame *why* it failed is a debugging tool for it.
 */

/** No message may exceed this once serialised. A plugin talks in data, not in files. */
export const MAX_MESSAGE_BYTES = 64 * 1024;

/** A call that has not answered by then is abandoned, and the plugin is told so. */
export const RPC_TIMEOUT_MS = 5_000;

/** A plugin that speaks more often than this is flooding the host, not using it. */
export const RATE_LIMIT = { windowMs: 1_000, messages: 120 } as const;

export type MessageKind = "hello" | "request" | "response" | "event";

/** A message that survived validation. */
export interface Envelope {
  readonly channel: string;
  readonly plugin: string;
  readonly kind: MessageKind;
  /** Present on requests and responses; a correlation id the plugin owns. */
  readonly id?: string;
  /** Present on requests. One of `METHODS`. */
  readonly method?: string;
  /** Present on responses and events. */
  readonly ok?: boolean;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: string;
  readonly event?: string;
  readonly at?: number;
}

export type EnvelopeProblem =
  | "not_an_object"
  | "not_json"
  | "too_large"
  | "wrong_channel"
  | "wrong_plugin"
  | "unknown_kind"
  | "unknown_method"
  | "missing_id"
  | "missing_method";

export type EnvelopeResult =
  | { readonly ok: true; readonly message: Envelope }
  | { readonly ok: false; readonly problem: EnvelopeProblem };

/**
 * A 128-bit channel, hex.
 *
 * `crypto.getRandomValues` in every shell this app runs in — a webview, a browser, a Tauri webview.
 * Not `Math.random`: a guessable channel is the same as no channel.
 */
export function newChannel(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The methods a plugin may call, and the permission each one needs. */
export const METHODS: Record<string, string | null> = {
  "plugin.ready": null,
  "storage.get": "plugin.storage",
  "storage.set": "plugin.storage",
  "storage.delete": "plugin.storage",
  "library.getSeries": "library.read",
  "library.query": "library.read",
  "ui.toast": null,
  "ui.confirm": null,
  "ui.openPanel": null,
  "actions.registerSeriesAction": "ui.series",
  "actions.registerReaderAction": "ui.reader",
  "actions.registerLibraryAction": "ui.library",
};

/** Events the host may push. A plugin cannot subscribe to anything not in this list. */
export const EVENTS = ["library.opened", "library.added", "library.removed"] as const;

export type HostEvent = (typeof EVENTS)[number];

export interface ValidationContext {
  readonly channel: string;
  readonly pluginId: string;
}

/**
 * Validates one `message` event's data.
 *
 * Size is checked first: a 40 MB string has already cost the host the memory to receive it, but
 * refusing before `JSON.parse` at least stops the host from building an object graph on top of it.
 */
export function readEnvelope(raw: unknown, context: ValidationContext): EnvelopeResult {
  if (typeof raw === "string") {
    if (raw.length > MAX_MESSAGE_BYTES) return { ok: false, problem: "too_large" };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, problem: "not_json" };
    }
    return readEnvelope(parsed, context);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, problem: "not_an_object" };
  }
  const value = raw as Record<string, unknown>;
  const channel = value.channel;
  if (typeof channel !== "string" || channel !== context.channel) {
    return { ok: false, problem: "wrong_channel" };
  }
  const plugin = value.plugin;
  if (typeof plugin !== "string" || plugin !== context.pluginId) {
    return { ok: false, problem: "wrong_plugin" };
  }
  const kind = value.kind;
  if (kind !== "hello" && kind !== "request" && kind !== "response" && kind !== "event") {
    return { ok: false, problem: "unknown_kind" };
  }

  const id = typeof value.id === "string" ? value.id : undefined;
  if ((kind === "request" || kind === "response") && id === undefined) {
    return { ok: false, problem: "missing_id" };
  }

  if (kind === "request") {
    const method = value.method;
    if (typeof method !== "string") return { ok: false, problem: "missing_method" };
    // `hasOwn`, not `in`: `"__proto__" in METHODS` is true through the prototype chain, which would
    // let a plugin ask for a method the host never declared.
    if (!Object.hasOwn(METHODS, method)) return { ok: false, problem: "unknown_method" };
  }

  // The size of the *payload*, once parsed: an object can arrive small as text and still be large.
  let measured = 0;
  try {
    measured = JSON.stringify(value).length;
  } catch {
    return { ok: false, problem: "not_an_object" };
  }
  if (measured > MAX_MESSAGE_BYTES) return { ok: false, problem: "too_large" };

  const message: Envelope = {
    channel,
    plugin,
    kind,
    ...(id === undefined ? {} : { id }),
    ...(typeof value.method === "string" && Object.hasOwn(METHODS, value.method) ? { method: value.method } : {}),
    ...(typeof value.ok === "boolean" ? { ok: value.ok } : {}),
    ...(value.params === undefined ? {} : { params: value.params }),
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(typeof value.error === "string" ? { error: value.error.slice(0, 500) } : {}),
    ...(typeof value.event === "string" && (EVENTS as readonly string[]).includes(value.event)
      ? { event: value.event }
      : {}),
    ...(typeof value.at === "number" ? { at: value.at } : {}),
  };
  return { ok: true, message };
}

/** A response envelope for one correlation id. */
export function responseOf(
  context: ValidationContext,
  id: string,
  result: unknown,
): Envelope {
  return { channel: context.channel, plugin: context.pluginId, kind: "response", id, ok: true, result };
}

/** A refusal the plugin can display, in one short sentence. */
export function errorOf(context: ValidationContext, id: string, error: string): Envelope {
  return {
    channel: context.channel,
    plugin: context.pluginId,
    kind: "response",
    id,
    ok: false,
    error: error.slice(0, 500),
  };
}

/**
 * The document a plugin runs in.
 *
 * A frame with `sandbox="allow-scripts"` only, plus a CSP that permits the *inline* bootstrap and
 * nothing else: no `connect-src`, no frames, no images from anywhere, no forms, no base URL. The
 * plugin's own source is inlined, so there is no second request and nothing to load after the frame
 * exists — "only the selected plugin is loaded" is a property of the document, not a promise.
 *
 * Two failures this prevents, both of which happened in the wild to other apps' plugin hosts: a
 * plugin opening a connection to its author's server (`connect-src 'none'`), and a plugin navigating
 * its own frame to a page that then speaks to the host (`navigate-to`/`form-action` refused, and the
 * host refuses messages from a document it no longer has).
 */
export function pluginDocument(options: {
  channel: string;
  pluginId: string;
  apiVersion: number;
  source: string;
}): string {
  const bootstrap = `(() => {
  "use strict";
  const CHANNEL = ${jsLiteral(options.channel)};
  const PLUGIN = ${jsLiteral(options.pluginId)};
  const API = ${String(options.apiVersion)};
  let sequence = 0;
  const pending = new Map();
  const actions = { series: [], reader: [], library: [] };
  const listeners = new Map();
  const send = (message) => parent.postMessage({ ...message, channel: CHANNEL, plugin: PLUGIN }, "*");
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = PLUGIN + ":" + (++sequence);
    pending.set(id, { resolve, reject });
    send({ kind: "request", id, method, params });
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("ht." + method + " did not answer"));
    }, ${String(RPC_TIMEOUT_MS)});
  });
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.plugin !== PLUGIN) return;
    if (message.kind === "response") {
      const waiting = pending.get(message.id);
      if (!waiting) return;
      pending.delete(message.id);
      if (message.ok) waiting.resolve(message.result);
      else waiting.reject(new Error(String(message.error || "refused")));
      return;
    }
    if (message.kind === "event") {
      // The host's own dispatch: run the callback this plugin registered for that action id.
      if (message.event === "action") {
        const id = message.params && message.params.id;
        const found = [...actions.series, ...actions.reader, ...actions.library].find((one) => one.id === id);
        if (found) {
          try { found.callback(); } catch (error) { send({ kind: "event", event: "plugin.error", error: String(error) }); }
        }
        return;
      }
      const handler = listeners.get(message.event);
      if (handler) handler(message.params);
      return;
    }
  });
  const ht = {
    plugin: { id: PLUGIN, version: "0.0.0" },
    storage: {
      get: (key) => call("storage.get", { key }),
      set: (key, value) => call("storage.set", { key, value }),
      delete: (key) => call("storage.delete", { key }),
    },
    library: {
      getSeries: (id) => call("library.getSeries", { id }),
      query: (options) => call("library.query", options || {}),
    },
    ui: {
      toast: (message) => call("ui.toast", { message }),
      confirm: (message) => call("ui.confirm", { message }),
      openPanel: (panelId) => call("ui.openPanel", { panelId }),
    },
    actions: {
      registerSeriesAction: (action) => { actions.series.push(action); return call("actions.registerSeriesAction", { id: action.id, title: action.title }); },
      registerReaderAction: (action) => { actions.reader.push(action); return call("actions.registerReaderAction", { id: action.id, title: action.title }); },
      registerLibraryAction: (action) => { actions.library.push(action); return call("actions.registerLibraryAction", { id: action.id, title: action.title }); },
    },
    events: {
      on: (event, callback) => { listeners.set(event, callback); },
    },
    invoke: (actionId) => {
      const found = [...actions.series, ...actions.reader, ...actions.library].find((one) => one.id === actionId);
      if (!found) return;
      try { found.callback(); } catch (error) { send({ kind: "event", event: "plugin.error", error: String(error) }); }
    },
  };
  Object.freeze(ht);
  globalThis.ht = ht;
  send({ kind: "hello", at: Date.now() });
  void API;
})();`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; navigate-to 'none'">
<title>${escapeHtml(options.pluginId)}</title></head>
<body>
<script>${inlineScript(bootstrap)}</script>
<script>${inlineScript(options.source)}</script>
</body></html>`;
}

/**
 * A string, as a JavaScript literal that cannot close the script element it sits in.
 *
 * `</script>` ends an inline script no matter that it is inside a string literal, so every `<` in a
 * value this file embeds becomes `\u003c`. A plugin id of `</title><script>` was a real escape
 * before this; it is now just a string that names nothing.
 */
function jsLiteral(value: string): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * Raw plugin source, made safe to inline.
 *
 * `<\/script` is the same characters to JavaScript (inside a string or a regular expression) and
 * simply not a closing tag to the HTML parser. The source is already trusted to run code — this only
 * stops it from *ending* its own element and continuing as markup.
 */
function inlineScript(code: string): string {
  return code.replace(/<\/script/gi, "<\\/script");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) =>
    character === "&" ? "&amp;" : character === "<" ? "&lt;" : character === ">" ? "&gt;" : character === '"' ? "&quot;" : "&#39;",
  );
}
