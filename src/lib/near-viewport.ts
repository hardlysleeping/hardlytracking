/**
 * One observer for every cover on the shelf.
 *
 * A tile only fetches its cover once it is nearly on screen, which is the right rule — a 5 000-title
 * library was resolving every cover the moment the shelf opened. The wrong part was the shape: every
 * `Cover` built its own `IntersectionObserver`, so the shelf carried one observer per tile, each with
 * its own callback and its own bookkeeping, for a question one observer can answer for all of them.
 *
 * The observer is created on first use and shared; a cover stops being watched the moment it is seen
 * (it has what it came for) or when it unmounts. `rootMargin` is fixed at 200% — two screens either
 * way is the rule the covers were tuned against, and one shared observer cannot honour two margins.
 */

/** How far outside the viewport counts as "near". */
export const NEAR_MARGIN = "200% 0px";

type Near = () => void;

const watched = new Map<Element, Near>();
let observer: IntersectionObserver | null = null;

function shared(): IntersectionObserver {
  if (observer === null) {
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const near = watched.get(entry.target);
          // One shot: whatever the cover came here to do, it has done.
          watched.delete(entry.target);
          observer?.unobserve(entry.target);
          near?.();
        }
      },
      { rootMargin: NEAR_MARGIN },
    );
  }
  return observer;
}

/**
 * Call `onNear` once, when `target` comes within two screens of the viewport.
 *
 * Returns `stop`, which is safe to call before or after the callback fires and safe to call twice.
 */
export function watchNear(target: Element, onNear: Near): () => void {
  // A webview without an observer (or a test without a DOM) must not leave every cover a blank
  // rectangle: without a way to know what is near, everything is near.
  if (typeof IntersectionObserver === "undefined") {
    onNear();
    return () => {};
  }
  watched.set(target, onNear);
  shared().observe(target);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    watched.delete(target);
    observer?.unobserve(target);
  };
}

/** How many targets are waiting to be seen. */
export function watchedCount(): number {
  return watched.size;
}

/** Whether the shared observer has been created yet. At most one, ever. */
export function observersOpen(): number {
  return observer === null ? 0 : 1;
}

/** Tests only: forget the shared observer so a fresh one can be counted. */
export function resetNearViewport(): void {
  watched.clear();
  observer?.disconnect();
  observer = null;
}