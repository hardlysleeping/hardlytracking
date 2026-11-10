/**
 * The host half of a portable extension: it spawns the Worker, loads the package and answers the
 * package's network requests.
 *
 * Everything that decides *whether* a request may happen lives here, on this side of the boundary,
 * not in downloaded code: cookies and tokens are applied by `transport`, a redirect leaves for a
 * different origin the same way every other source's does, and the worker never sees a header the
 * host did not put there.
 *
 * `spawn` is injectable so the whole message dance can be exercised in Node against the real core.
 */
import type { Transport } from "../../../api/transport";
import { transport } from "../../../api/transport";
import type { PortableRuntime } from "../portable-provider";
import {
  PORTABLE_CALL_DEADLINE_MS,
  PORTABLE_FETCH_DEADLINE_MS,
  type HostToWorker,
  type PortableError,
  type PortableFetchRequest,
  type PortableMethod,
  type WorkerToHost,
} from "./protocol";

/** The slice of `Worker` this module uses, so a test can stand in for it. */
export interface WorkerLike {
  postMessage(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  terminate(): void;
}

export interface OpenPortableWorkerOptions {
  packageId: string;
  /** The text of `provider.js`, already fetched and signature-checked by the caller. */
  source: string;
  /** Defaults to the app's own transport, so a package inherits the app's cookie/token handling. */
  request?: Transport;
  spawn?: () => WorkerLike;
  deadlineMs?: number;
  /** For messages and for the fetch policy a package must not decide for itself. */
  onWarning?: (message: string) => void;
}

function defaultSpawn(): WorkerLike {
  // Vite rewrites this specifier into the emitted worker chunk in the build and serves it as a
  // module in dev; under Capacitor that is a file inside the app bundle, which is why it works
  // offline and why a package can never be fetched as a worker URL by itself.
  return new Worker(new URL("./provider-worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let at = 0; at < bytes.length; at += 1) binary += String.fromCharCode(bytes[at]);
  return btoa(binary);
}

function bodyBytes(request: PortableFetchRequest): BodyInit | undefined {
  if (request.body === undefined) return undefined;
  if (request.bodyBase64 !== true) return request.body;
  const binary = atob(request.body);
  const bytes = new Uint8Array(binary.length);
  for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
  return bytes;
}

function withDeadline<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} did not answer in ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Start a package and hand back the runtime the provider needs.
 *
 * Rejects when the package does not load: a broken package must fail its *card*, never the boot of
 * the app that lists it.
 */
export async function openPortableWorker(options: OpenPortableWorkerOptions): Promise<PortableRuntime> {
  const spawn = options.spawn ?? defaultSpawn;
  const request = options.request ?? transport;
  const deadline = options.deadlineMs ?? PORTABLE_CALL_DEADLINE_MS;
  const worker = spawn();

  let methods = new Set<PortableMethod>();
  let nextId = 1;
  const calls = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  let settleReady: (value: void) => void = () => undefined;
  let failReady: (error: Error) => void = () => undefined;
  const ready = new Promise<void>((resolve, reject) => {
    settleReady = resolve;
    failReady = reject;
  });
  // A load failure that nobody is waiting on must not surface as an unhandled rejection.
  ready.catch(() => undefined);

  const post = (message: HostToWorker): void => worker.postMessage(message);

  async function answerFetch(id: number, fetchRequest: PortableFetchRequest): Promise<void> {
    try {
      const response = await withDeadline(
        request(fetchRequest.url, {
          method: fetchRequest.method ?? "GET",
          headers: fetchRequest.headers,
          body: bodyBytes(fetchRequest),
          redirect: "follow",
        }),
        PORTABLE_FETCH_DEADLINE_MS,
        `${options.packageId} fetching ${new URL(fetchRequest.url).host}`,
      );
      const bytes = new Uint8Array(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });
      post({ type: "fetchResult", id, ok: true, value: { status: response.status, headers, bodyBase64: encodeBase64(bytes) } });
    } catch (error) {
      const portable: PortableError = { code: "threw", message: error instanceof Error ? error.message : String(error) };
      post({ type: "fetchResult", id, ok: false, error: portable });
    }
  }

  worker.addEventListener("message", (event) => {
    const message = event.data as WorkerToHost;
    switch (message.type) {
      case "ready":
        methods = new Set(message.methods);
        settleReady();
        return;
      case "failed":
        failReady(new Error(message.error.message));
        return;
      case "result": {
        const waiting = calls.get(message.id);
        if (waiting === undefined) return;
        calls.delete(message.id);
        if (message.ok) waiting.resolve(message.value);
        else waiting.reject(new Error(message.error.message));
        return;
      }
      case "fetch":
        void answerFetch(message.id, message.request);
        return;
    }
  });

  post({ type: "load", protocol: 1, packageId: options.packageId, source: options.source });
  try {
    await withDeadline(ready, deadline, `${options.packageId} loading`);
  } catch (error) {
    worker.terminate();
    throw error;
  }

  return {
    supports: (method) => methods.has(method),
    call: <T>(method: PortableMethod, args: readonly unknown[]): Promise<T> => {
      if (!methods.has(method)) {
        return Promise.reject(new Error(`${options.packageId} has no ${method}()`));
      }
      const id = nextId++;
      const answer = new Promise<unknown>((resolve, reject) => {
        calls.set(id, { resolve, reject });
      });
      post({ type: "call", id, method, args: [...args] });
      return withDeadline(answer, deadline, `${options.packageId} ${method}()`) as Promise<T>;
    },
    close: () => {
      for (const [, waiting] of calls) waiting.reject(new Error(`${options.packageId} was closed`));
      calls.clear();
      post({ type: "dispose" });
      worker.terminate();
    },
  };
}
