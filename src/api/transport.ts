/**
 * Picks a transport for the current runtime.
 *
 * Copied from HardlyReader (`~/apps/hardlyread/src/api/transport.ts`), which is
 * the one piece of that app's plumbing this project inherits unchanged: inside
 * Tauri the webview is a separate origin, so a plain `fetch` is blocked by CORS
 * and requests must go through the http plugin. In a browser (`vite dev`, tests,
 * the self-hosted build) `fetch` is the only option.
 */
export type Transport = (input: string, init?: RequestInit) => Promise<Response>;

export const transport: Transport = async (input, init) => {
  if ("__TAURI_INTERNALS__" in globalThis) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return tauriFetch(input, init);
  }
  return fetch(input, init);
};
