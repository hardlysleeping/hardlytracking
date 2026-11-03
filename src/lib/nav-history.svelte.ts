/** Mirror entry identities, never guess Back/Forward from matching route strings. */
const KEY = '__hardlytrackingNavigation';
let position = $state(0);
let last = $state(0);
const session = (() => {
  try {
    const saved = sessionStorage.getItem(KEY);
    if (saved) return JSON.parse(saved) as { id: string; last: number };
  } catch { /* Storage may be unavailable. */ }
  return { id: crypto.randomUUID(), last: 0 };
})();
last = session.last;
function remember(): void {
  try { sessionStorage.setItem(KEY, JSON.stringify({ id: session.id, last })); } catch { /* Optional. */ }
}
function marker(): { id: string; index: number } | undefined {
  return history.state?.[KEY];
}
const initial = marker();
if (initial?.id === session.id) position = initial.index;
else {
  position = 0;
  last = 0;
  history.replaceState({ ...history.state, [KEY]: { id: session.id, index: position } }, '');
}
remember();
function changed(): void {
  const entry = marker();
  if (entry?.id === session.id) {
    position = entry.index;
  } else {
    // A newly pushed hash entry truncates the browser's forward branch, even when its URL
    // happens to match the previous entry. Traversal keeps its own marker instead.
    position += 1;
    last = position;
    history.replaceState({ ...history.state, [KEY]: { id: session.id, index: position } }, '');
    remember();
  }
}
window.addEventListener('popstate', changed);
window.addEventListener('hashchange', changed);
export const navHistory = {
  get depth(): number { return position; },
  get canForward(): boolean { return position < last; },
};
