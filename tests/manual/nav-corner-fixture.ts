// Synthetic fixture: where the floating Back/Forward pair sits, and that the setting moves it.
// Uses the real AppShell at a phone viewport; opens no library, no source and no user data.
import { mount, tick, unmount } from 'svelte';
import AppShell from '../../src/components/AppShell.svelte';
import '../../src/app.css';
import { DEFAULT_THEME, themeVariables } from '../../src/lib/theme-model';
import { settings } from '../../src/state/settings.svelte';
import { viewport } from '../../src/lib/layout.svelte';

for (const [key, value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key, value);
viewport.start();

const target = document.querySelector('#shell') as HTMLElement;
const result = document.querySelector('#result') as HTMLElement;
const report = { ok: true as boolean, device: '', checks: [] as string[], errors: [] as string[] };
function check(condition: unknown, name: string): void {
  if (!condition) { report.ok = false; report.errors.push(name); } else report.checks.push(name);
}
const settle = async () => { await tick(); await new Promise((r) => setTimeout(r, 60)); await tick(); };

let mounted: Record<string, unknown> | null = null;
function paint(): void {
  if (mounted !== null) { unmount(mounted as never); mounted = null; target.replaceChildren(); }
  mounted = mount(AppShell, {
    target,
    props: { active: 'library', children: (anchor: unknown) => { void anchor; return undefined; } },
  }) as Record<string, unknown>;
}

function navRect(): DOMRect | null {
  const element = document.querySelector('.history-nav');
  return element === null ? null : element.getBoundingClientRect();
}

async function run(): Promise<void> {
  // Two hash entries so `navHistory.depth > 0` and the pair is actually drawn.
  location.hash = '#/library';
  location.hash = '#/browse';
  await settle();
  paint();
  await settle();
  report.device = document.documentElement.dataset.device ?? '';

  settings.set('historyNavCorner', 'bottom-right');
  await settle();
  let rect = navRect();
  check(rect !== null, 'the pair is drawn once there is history to move through');
  if (rect !== null) {
    check(rect.right > innerWidth * 0.6, 'it starts on the right half by default');
    check(rect.bottom > innerHeight * 0.6, 'and low on the screen, above the phone bar');
    check(Math.abs(innerWidth - rect.right) < 40, 'it keeps clear of the right safe edge');
  }

  for (const corner of ['bottom-left', 'top-left', 'top-right'] as const) {
    settings.set('historyNavCorner', corner);
    await settle();
    rect = navRect();
    check(rect !== null, `${corner}: still drawn`);
    if (rect === null) continue;
    const leftHalf = rect.left < innerWidth / 2;
    const topHalf = rect.top < innerHeight / 2;
    check(corner.startsWith('bottom') ? !topHalf : topHalf, `${corner}: correct vertical half`);
    check(corner.endsWith('left') ? leftHalf : !leftHalf, `${corner}: correct horizontal half`);
  }

  settings.set('historyNavCorner', 'bottom-right');
  result.textContent = JSON.stringify(report);
  result.dataset.done = 'true';
}

void run().catch((error) => {
  report.ok = false;
  report.errors.push(error instanceof Error ? error.message : String(error));
  result.textContent = JSON.stringify(report);
  result.dataset.done = 'true';
});
