// The reader fixture, plus the router wiring the app gives it — so the header's exit door can be
// pressed in a browser and its destination read off the address bar. The reader stubs (generated
// pages, in-memory profile) all come from `reader-fixture`, which this page loads first.
import './reader-fixture';
import { noteRoute } from '../../src/lib/reader-origin';

// Exactly App.svelte's `readRoute`: noted synchronously with the route, not in an effect.
function readRoute(): void {
  noteRoute(location.hash, location.hash.startsWith('#/read'));
}
addEventListener('hashchange', readRoute);
readRoute();

(window as any).readerDoor = { route: () => location.hash };
