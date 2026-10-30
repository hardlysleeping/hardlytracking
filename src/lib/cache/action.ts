/**
 * `use:cacheImage` — put an image through the cache without changing how the element works.
 *
 * The reader renders pages as plain `<img src>` (an object URL from the cache is still just a src),
 * so the cache plugs in as an action instead of a wrapper component: one attribute, and a re-read
 * chapter comes off the disk instead of the network.
 */
import { imageCache } from "./images";

export function cacheImage(node: HTMLImageElement, url: string | undefined): { update: (next: string | undefined) => void; destroy: () => void } {
  let live = true;
  let current = url;

  const apply = (value: string | undefined): void => {
    if (value === undefined || value === "") return;
    node.src = value;
    void imageCache.resolve(value).then((resolved) => {
      if (live && resolved !== value) node.src = resolved;
    });
  };

  apply(url);

  return {
    update(next: string | undefined) {
      if (next === current) return;
      current = next;
      apply(next);
    },
    destroy() {
      live = false;
    },
  };
}
