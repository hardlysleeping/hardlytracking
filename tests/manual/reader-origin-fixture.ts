// The real router pieces, no app: `nav-history`'s markers, `nav`'s hash pushes and the reader-origin
// module, wired the way `App.svelte` wires them. The depth arithmetic is the part worth proving in a
// browser — a unit test can only assert what it was told.
import { noteRoute, readerOrigin, leaveReader } from '../../src/lib/reader-origin';
import { navHistory } from '../../src/lib/nav-history.svelte';

// App.svelte's `readRoute`: the route is noted synchronously, before anything renders.
function readRoute(): void {
  noteRoute(location.hash, location.hash.startsWith('#/read'));
}
addEventListener('hashchange', readRoute);
readRoute();

(window as any).readerOriginFixture = {
  noteRoute,
  readerOrigin,
  leaveReader,
  depth: () => navHistory.depth,
  canForward: () => navHistory.canForward,
  route: () => location.hash,
};
