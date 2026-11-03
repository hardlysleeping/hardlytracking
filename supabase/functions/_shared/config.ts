/**
 * What the deployment has to tell us, and what happens when it does not.
 *
 * `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `SUPABASE_ANON_KEY` are set by Supabase
 * itself for every function; they are read here anyway because this file is also the
 * place a local `supabase functions serve` gets them from. `CATALOGUE_APP_VERSION` is
 * ours: the release a submitted package is judged compatible with.
 *
 * None of these values is ever logged, echoed in a response, or put in a URL. A missing
 * one is a half-configured deployment, which is a 500 with a sentence and a *name* in
 * the log — never the value.
 */
import { HttpError } from "./http.ts";

/** The release `readManifest` compares `minAppVersion` against when nobody says otherwise. */
export const DEFAULT_APP_VERSION = "0.5.9";

export interface Project {
  /** No trailing slash: every caller appends a path. */
  readonly url: string;
  readonly serviceKey: string;
  readonly anonKey: string;
  /** The app version the catalogue is judged against. */
  readonly appVersion: string;
}

export function configuration(): Project {
  const url = (Deno.env.get("SUPABASE_URL") ?? "").trim().replace(/\/+$/, "");
  const serviceKey = (Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const anonKey = (Deno.env.get("SUPABASE_ANON_KEY") ?? "").trim();

  const missing = [
    url === "" ? "SUPABASE_URL" : "",
    serviceKey === "" ? "SUPABASE_SERVICE_ROLE_KEY" : "",
    anonKey === "" ? "SUPABASE_ANON_KEY" : "",
  ].filter((name) => name !== "");

  if (missing.length > 0) {
    console.error(`community: not configured — missing ${missing.join(", ")}`);
    throw new HttpError(500, "The catalogue backend is not configured.");
  }

  const appVersion = (Deno.env.get("CATALOGUE_APP_VERSION") ?? "").trim() || DEFAULT_APP_VERSION;
  return { url, serviceKey, anonKey, appVersion };
}
