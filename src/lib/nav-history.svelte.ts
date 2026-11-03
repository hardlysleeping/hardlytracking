/**
 * Where the reader has been, for the floating back/forward pair.
 *
 * The router is a hash path, so the browser's own history is the real stack;
 * this only mirrors it well enough to know whether either button has somewhere
 * to go. Two lists: `stack` is everything up to the current entry, `ahead` is
 * what a Back left behind and a Forward can return to.
 *
 * A navigation that is not a Back or a Forward (a tap on a destination, a deep
 * link) drops `ahead`, which is what makes the forward button appear only after
 * the reader has actually gone back.
 */

const normalize = (hash: string): string => {
  const path = hash.replace(/^#/, "");
  return path === "" ? "/library" : path;
};

let stack = $state<string[]>([normalize(location.hash)]);
let ahead = $state<string[]>([]);

export const navHistory = {
  /** How many entries sit behind the current one. */
  get depth(): number {
    return stack.length - 1;
  },
  /** True only when a Back has happened and nothing has replaced it since. */
  get canForward(): boolean {
    return ahead.length > 0;
  },
};

const onHashChange = (): void => {
  const next = normalize(location.hash);
  const here = stack[stack.length - 1];
  if (next === here) return;

  const behind = stack.length > 1 ? stack[stack.length - 2] : null;
  if (behind !== null && next === behind) {
    ahead = [...ahead, here];
    stack = stack.slice(0, -1);
    return;
  }

  const forwardTo = ahead.length > 0 ? ahead[ahead.length - 1] : null;
  if (forwardTo !== null && next === forwardTo) {
    stack = [...stack, next];
    ahead = ahead.slice(0, -1);
    return;
  }

  stack = [...stack, next];
  ahead = [];
};

if (typeof window !== "undefined") {
  window.addEventListener("hashchange", onHashChange);
}
