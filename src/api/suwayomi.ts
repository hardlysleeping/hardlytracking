/** User-owned Suwayomi transport. Provider IDs and read-state stay on the existing Mihon seam. */
import { createMihonProvider, type MihonTransport } from "./mihon";
import type { SourceProvider, Series, Paged } from "./source";
import { transport } from "./transport";
import { hasLocalServer } from "../lib/host";
import { RUNTIME_DEADLINE_MS, withDeadline } from "../lib/deadline";
import type { SuwayomiSettings } from "../lib/suwayomi";

export function normalizeSuwayomiBase(value: string): string {
  const url = new URL(value.trim());
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Suwayomi needs an http(s) address without embedded credentials, query or fragment");
  }
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/api$/i, "");
  return url.toString().replace(/\/+$/, "");
}

function encodeBase(value: string): string {
  let bytes = "";
  for (const byte of new TextEncoder().encode(value)) bytes += String.fromCharCode(byte);
  return btoa(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Never attach a saved password to an absolute asset on a different origin. */
export function suwayomiUrl(
  baseUrl: string, path: string, proxied = hasLocalServer(),
  origin = typeof location === "undefined" ? "" : location.origin,
): string {
  const base = normalizeSuwayomiBase(baseUrl);
  const root = new URL(base);
  const apiRoot = `${root.pathname.replace(/\/+$/, "")}/api/`;
  let target: URL;
  if (/^https?:\/\//i.test(path)) target = new URL(path);
  else if (path.startsWith("/api/")) target = new URL(`${root.pathname.replace(/\/+$/, "")}${path}`, root.origin);
  else target = new URL(path.replace(/^\//, ""), `${base}/api/`);
  if (target.origin !== root.origin || !target.pathname.startsWith(apiRoot) || target.username || target.password) {
    throw new Error("Suwayomi asset must stay on its configured origin and API path");
  }
  const tail = `${target.pathname.slice(root.pathname.replace(/\/+$/, "").length)}${target.search}`;
  return proxied ? `${origin}/api/suwayomi/${encodeBase(base)}${tail}` : target.href;
}

export function suwayomiAuthHeaders(settings: SuwayomiSettings): Record<string, string> {
  if (settings.username === "" && settings.password === "") return {};
  let bytes = "";
  for (const byte of new TextEncoder().encode(`${settings.username}:${settings.password}`)) bytes += String.fromCharCode(byte);
  return { authorization: `Basic ${btoa(bytes)}` };
}

export interface SuwayomiOptions extends SuwayomiSettings {
  fetchImpl?: typeof fetch;
  proxied?: boolean;
  origin?: string;
  deadlineMs?: number;
}

export function suwayomiTransport(options: SuwayomiOptions): MihonTransport {
  const headers = suwayomiAuthHeaders(options);
  const request = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => transport(String(input), init));
  const asset = (path: string) => suwayomiUrl(options.baseUrl, path, options.proxied, options.origin);
  return {
    asset,
    async gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
      // The deadline includes body parsing: a server may send headers and never finish its JSON.
      return withDeadline((async () => {
        const response = await request(asset("graphql"), {
          method: "POST", headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ query, variables }), redirect: "error",
        });
        if (response.status === 401 || response.status === 403) throw new Error(`Suwayomi refused that login (${response.status})`);
        if (!response.ok) throw new Error(`Suwayomi answered ${response.status}`);
        const body = await response.json() as { data?: T; errors?: Array<{ message?: string }> };
        if (body.errors?.length) throw new Error(body.errors[0]?.message ?? "Suwayomi GraphQL error");
        if (body.data === undefined || body.data === null) throw new Error("Suwayomi returned no data");
        return body.data;
      })(), options.deadlineMs ?? RUNTIME_DEADLINE_MS, "your Suwayomi server");
    },
  };
}

/** Decorate only image credentials; browsing, chapters, readState and setRead remain Mihon's. */
export function createSuwayomiProvider(options: SuwayomiOptions): SourceProvider {
  const provider = createMihonProvider(suwayomiTransport(options));
  const headers = suwayomiAuthHeaders(options);
  const decorate = (series: Series): Series => series.cover && Object.keys(headers).length ? { ...series, coverHeaders: headers } : series;
  const decoratePage = (page: Paged<Series>): Paged<Series> => ({ ...page, items: page.items.map(decorate) });
  return {
    ...provider,
    details: async (id) => decorate(await provider.details(id)),
    popular: async (id, page) => decoratePage(await provider.popular(id, page)),
    latest: async (id, page) => decoratePage(await provider.latest(id, page)),
    search: async (id, query, page, filters) => decoratePage(await provider.search(id, query, page, filters)),
    pages: async (id) => (await provider.pages(id)).map(page => Object.keys(headers).length ? { ...page, headers } : page),
  };
}
