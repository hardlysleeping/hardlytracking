/**
 * The worker's own logic (package loading + call routing), kept separate from the Worker bootstrap
 * so it can be tested in Node with a plain message queue.
 *
 * A portable package is one ES module that default-exports an object of methods:
 *
 * ```js
 * export default {
 *   async sources() { return [{ id: "lib:1", name: "Comics", lang: "en" }]; },
 *   async popular(sourceId, page) { … },
 * }
 * ```
 *
 * It receives exactly one argument, `api`, holding `fetch` (always routed through the host),
 * `packageId` and `version` — through `api` passed to each method as its last argument, because a
 * module has no closure over the host. There is no `window`, no `document` and no `self`.
 *
 * **It is loaded as a module, never `eval`'d.** `src/lib/extensions` has one rule the whole app is
 * tested against: no `eval`, no `new Function`. A package arrives as text and becomes a module URL,
 * which is the same door every other script the platform loads comes through, and it keeps the code
 * inside the worker where the boundary is.
 */
import type { HostToWorker, PortableError, PortableFetchAnswer, PortableMethod, WorkerToHost } from "./protocol";

/** The methods a package may implement; `sources` is required, the rest are found by inspection. */
const METHODS: PortableMethod[] = [
  "sources",
  "trending",
  "popular",
  "latest",
  "search",
  "filters",
  "details",
  "chapters",
  "pages",
  "readState",
  "setRead",
];

/** What `api.fetch` hands a package: the bytes, decoded on demand. */
export interface PortableFetchResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
  bytes: () => Promise<Uint8Array>;
}

export interface PortableApi {
  packageId: string;
  version: string;
  /** Every request leaves the worker: the host owns cookies, tokens and transport. */
  fetch: (request: { url: string; method?: string; headers?: Record<string, string>; body?: string; bodyBase64?: boolean }) => Promise<PortableFetchResult>;
}

export interface WorkerCoreOptions {
  post: (message: WorkerToHost) => void;
}

export interface WorkerCore {
  handle(message: HostToWorker): void;
}

function errorOf(error: unknown, code: PortableError["code"]): PortableError {
  return { code, message: error instanceof Error ? error.message : String(error) };
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

export function createWorkerCore(options: WorkerCoreOptions): WorkerCore {
  let provider: Record<string, unknown> | null = null;
  let packageId = "";
  let version = "0";
  /** Fetch calls waiting for the host, keyed by the id we minted for them. */
  const pending = new Map<number, { resolve: (answer: PortableFetchResult) => void; reject: (error: Error) => void }>();
  let nextFetchId = 1;

  const api: PortableApi = {
    get packageId() {
      return packageId;
    },
    get version() {
      return version;
    },
    fetch: (request) =>
      new Promise((resolve, reject) => {
        const id = nextFetchId++;
        pending.set(id, { resolve, reject });
        options.post({ type: "fetch", id, request });
      }),
  };

  function methodsOf(value: Record<string, unknown>): PortableMethod[] {
    return METHODS.filter((method) => typeof value[method] === "function");
  }

  async function load(source: string, id: string, declaredVersion: string): Promise<void> {
    packageId = id;
    version = declaredVersion;
    try {
      // Running the package *is* the feature; it runs here, inside a worker with no DOM, no plugins
      // and no network of its own, and only after the repository's manifest checks passed. The module
      // is addressed as a data URL so there is no object URL to leak and no string-to-code call.
      const url = `data:text/javascript;base64,${btoa(unescape(encodeURIComponent(source)))}`;
      const module = (await import(/* @vite-ignore */ url)) as { default?: unknown };
      const value = module.default ?? module;
      if (value === null || typeof value !== "object") {
        throw new Error("provider.js must default-export an object of methods");
      }
      const record = value as Record<string, unknown>;
      for (const method of methodsOf(record)) {
        // Methods get `api` last, so a package can see the host without a module-level global.
        const fn = record[method] as (...args: unknown[]) => unknown;
        record[method] = (...args: unknown[]) => fn.apply(record, [...args, api]);
      }
      if (typeof record.sources !== "function") throw new Error("provider.js must define sources()");
      provider = record;
      options.post({ type: "ready", protocol: 1, methods: methodsOf(record) });
    } catch (error) {
      provider = null;
      options.post({ type: "failed", error: errorOf(error, "threw") });
    }
  }

  async function call(id: number, method: PortableMethod, args: unknown[]): Promise<void> {
    if (provider === null) {
      options.post({ type: "result", id, ok: false, error: { code: "threw", message: "the package is not loaded" } });
      return;
    }
    const fn = provider[method];
    if (typeof fn !== "function") {
      options.post({ type: "result", id, ok: false, error: { code: "unsupported", message: `${packageId} has no ${method}()` } });
      return;
    }
    try {
      const value = await (fn as (...a: unknown[]) => unknown).apply(provider, args);
      options.post({ type: "result", id, ok: true, value });
    } catch (error) {
      options.post({ type: "result", id, ok: false, error: errorOf(error, "threw") });
    }
  }

  function settle(id: number, ok: boolean, value?: PortableFetchAnswer, error?: PortableError): void {
    const waiting = pending.get(id);
    if (waiting === undefined) return;
    pending.delete(id);
    if (!ok) {
      waiting.reject(new Error(error?.message ?? "the host refused that request"));
      return;
    }
    const answer = value as PortableFetchAnswer;
    const bytes = () => Promise.resolve(decodeBase64(answer.bodyBase64));
    const text = async () => new TextDecoder().decode(await bytes());
    waiting.resolve({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: answer.headers,
      text,
      json: async () => JSON.parse(await text()) as unknown,
      bytes,
    });
  }

  return {
    handle(message) {
      switch (message.type) {
        case "load":
          void load(message.source, message.packageId, "0");
          return;
        case "call":
          void call(message.id, message.method, message.args);
          return;
        case "fetchResult":
          if (message.ok) settle(message.id, true, message.value);
          else settle(message.id, false, undefined, message.error);
          return;
        case "dispose":
          provider = null;
          for (const [, waiting] of pending) waiting.reject(new Error("the extension was closed"));
          pending.clear();
          return;
      }
    },
  };
}
