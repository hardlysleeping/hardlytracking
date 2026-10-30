/**
 * The upstream path for a proxied request: the app's own prefix is swapped for the runtime's.
 *
 * For the Mihon runtime that swap is `/api/mihon/...` -> `/api/...`, not `-> /...`. Suwayomi serves
 * `/api/graphql` and `/api/v1/...`, so dropping the whole prefix lands on a 404 whose body says
 * "Endpoint POST /graphql not found" — which reads like a dead runtime and is really a wrong URL.
 */
export function upstreamPath(pathname, prefix, replacement = "") {
  return pathname.replace(prefix, replacement);
}
