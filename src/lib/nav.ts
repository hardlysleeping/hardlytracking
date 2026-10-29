/** The whole router: a hash path. No dependency, and a self-hosted static build needs no rewrites. */
export function go(path: string): void {
  location.hash = path.startsWith("#") ? path : `#${path}`;
}

export interface Route {
  name: string;
  id: string | null;
  chapterId: string | null;
}

export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  return { name: parts[0] ?? "library", id: parts[1] ?? null, chapterId: parts[2] ?? null };
}
