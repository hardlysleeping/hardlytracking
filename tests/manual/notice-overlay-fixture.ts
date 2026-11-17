// Synthetic fixture: proves the notice is an overlay (the page does not move) and that it leaves on
// its own, and that the Settings page shows what it said. Never opens the owner's library or a source.
import { mount, tick, unmount } from 'svelte';
import GlobalWarning from '../../src/components/GlobalWarning.svelte';
import More from '../../src/views/More.svelte';
import '../../src/app.css';
import { DEFAULT_THEME, themeVariables } from '../../src/lib/theme-model';
import { notices } from '../../src/state/notices.svelte';
import { library } from '../../src/state/library.svelte';

for (const [key, value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key, value);

const host = document.querySelector('#notice')!;
const moreHost = document.querySelector('#more')!;
const result = document.querySelector('#result') as HTMLElement;

let mounted: Record<string, unknown> | null = null;
let shownAt = 0;
const report = { ok: true as boolean, checks: [] as string[], errors: [] as string[] };
function check(condition: unknown, name: string): void {
  if (!condition) {
    report.ok = false;
    report.errors.push(name);
  } else report.checks.push(name);
}
const settle = async () => { await tick(); await new Promise((r) => setTimeout(r, 40)); await tick(); };

/**
 * Draw what the app's own `{#if notices.current !== null}` would draw: nothing while there is no
 * notice, one warning otherwise. Remounting rather than leaving a stale component behind is what
 * makes "it left on its own" observable at all — a mounted copy keeps its last props.
 */
function paint(): void {
  if (mounted !== null) {
    unmount(mounted as never);
    mounted = null;
    host.replaceChildren();
  }
  if (notices.current === null) return;
  mounted = mount(GlobalWarning, {
    target: host,
    props: {
      message: notices.current,
      sticky: notices.sticky,
      ondismiss: () => { notices.dismiss(); paint(); },
    },
  }) as Record<string, unknown>;
}

// The bar that must not move: a stand-in header at the top of the page, in normal flow.
library.ready = true;
library.library = [];
mount(More, { target: moreHost });

async function run(): Promise<void> {
  await settle();
  const before = moreHost.getBoundingClientRect().top;
  const beforeHeader = document.querySelector('#more .pagemenu')!.getBoundingClientRect().top;

  shownAt = Date.now();
  notices.show('the extension host did not start');
  paint();
  await settle();

  const overlay = document.querySelector('.global-warning') as HTMLElement | null;
  check(overlay !== null, 'a notice is drawn');
  check(getComputedStyle(overlay!).position === 'fixed', 'the notice is fixed, not a bar in the layout');
  check(Math.abs(moreHost.getBoundingClientRect().top - before) < 0.5, 'the page below it does not move');
  check(Math.abs(document.querySelector('#more .pagemenu')!.getBoundingClientRect().top - beforeHeader) < 0.5, 'the header does not move');
  check(overlay!.getBoundingClientRect().bottom <= 140, 'the overlay sits at the top of the screen');

  const logged = notices.log.some((row) => row.text === 'the extension host did not start');
  check(logged, 'the log kept the sentence');
  await settle();
  check(moreHost.innerText.includes('the extension host did not start'), 'the Settings page shows the log inline');

  // The 7s timer: wait for it rather than trusting a fake clock, because the timer lives in the state.
  await new Promise((r) => setTimeout(r, 7000 - (Date.now() - shownAt) + 350));
  paint();
  await settle();
  check(document.querySelector('.global-warning') === null, 'the notice leaves on its own after about seven seconds');

  // A sticky notice has no X and stays.
  notices.show('Device storage is unavailable', { sticky: true });
  paint();
  await settle();
  const stickyEl = document.querySelector('.global-warning');
  check(stickyEl !== null, 'a sticky notice is drawn');
  check(stickyEl!.querySelector('button') === null, 'a sticky notice has no dismiss button');
  await new Promise((r) => setTimeout(r, 2000));
  check(document.querySelector('.global-warning') !== null, 'a sticky notice does not time out');
  notices.resolve();
  paint();
  await settle();
  check(document.querySelector('.global-warning') === null, 'resolving its cause takes it away');

  check(notices.log.length >= 2, 'both notices are in the log');
  result.textContent = JSON.stringify(report);
  result.dataset.done = 'true';
}

void run().catch((error) => {
  report.ok = false;
  report.errors.push(error instanceof Error ? error.message : String(error));
  result.textContent = JSON.stringify(report);
  result.dataset.done = 'true';
});
