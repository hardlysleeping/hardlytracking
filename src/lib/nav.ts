/** The whole router: a hash path. No dependency, and a self-hosted static build needs no rewrites. */
export function go(path: string): void {
  location.hash = path.startsWith("#") ? path : `#${path}`;
}

/**
 * A route path built from ids.
 *
 * Ids are not path-safe: a dalvik series id is `dalvik:<sourceId>:/manga/<uuid>`, and its own
 * slashes used to split the route, so `#/series/dalvik:1:/manga/x` arrived as id
 * `dalvik:1:` with the rest silently dropped (the series page then asked the host for an empty
 * url). Every segment is escaped here, and `parseRoute` unescapes it — one place, so no call
 * site has to remember.
 */
export function pathTo(name: string, ...ids: Array<string | null | undefined>): string {
  return [name, ...ids.filter((id): id is string => typeof id === "string")].map(encodeURIComponent).join("/");
}

export interface Route {
  name: string;
  id: string | null;
  chapterId: string | null;
  /**
   * The repository a package belongs to, for `#/software/<repo>/<pkg>`.
   *
   * Only a software route carries it: two repositories can publish the same package id, and the
   * detail page has to say which one a link meant. Every other route leaves it `null`.
   */
  repo: string | null;
}

function decode(part: string | undefined): string | null {
  if (part === undefined || part === "") return null;
  try {
    return decodeURIComponent(part);
  } catch {
    // A hand-written hash can hold a stray `%`; a broken escape is not worth a blank page.
    return part;
  }
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  const name = parts[0] ?? "library";
  const first = decode(parts[1]);
  const second = decode(parts[2]);

  // `#/software/<pkg>` and `#/software/<repo>/<pkg>`: the long form names the repository first,
  // because the package id is what identifies the thing being shown.
  if (name === "software") {
    if (second !== null) return { name, id: second, chapterId: null, repo: first };
    return { name, id: first, chapterId: null, repo: null };
  }
  return { name, id: first, chapterId: second, repo: null };
}
