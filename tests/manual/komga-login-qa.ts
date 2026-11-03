/** Open /tests/manual/komga-login.html on an isolated dev origin. No real server or credentials. */
import { mount, tick, unmount } from 'svelte';
import KomgaLogin from '../../src/components/KomgaLogin.svelte';
import { clearKomga, komgaConfigured, komgaSettings } from '../../src/lib/komga';
import '../../src/app.css';

const target = document.querySelector('#fixture')!;
const checks: string[] = [];
let refreshes = 0;
let mode: 'ok' | 'refused' | 'pending' = 'ok';
let release: (() => void) | undefined;
const originalFetch = globalThis.fetch;
const testSecret = crypto.randomUUID(); // Synthetic, never a real login.
const user = 'fixture-reader';
const base = 'http://fixture.tailnet.ts.net:25600';
const settle = async () => { await new Promise(resolve => setTimeout(resolve, 30)); await tick(); };
function check(condition: unknown, name: string): void {
  if (!condition) throw new Error(name);
  checks.push(name);
}
function button(text: string): HTMLButtonElement {
  const element = [...target.querySelectorAll('button')].find(b => b.textContent?.trim() === text);
  if (!element) throw new Error(`Missing button: ${text}`);
  return element;
}
async function fill(): Promise<void> {
  const inputs = target.querySelectorAll('input');
  [base, user, testSecret].forEach((value, i) => {
    inputs[i].value = value;
    inputs[i].dispatchEvent(new Event('input', { bubbles: true }));
  });
  await tick();
}
function submit(): void { target.querySelector('form')!.requestSubmit(); }

globalThis.fetch = async () => {
  if (mode === 'pending') await new Promise<void>(resolve => { release = resolve; });
  return mode === 'refused'
    ? new Response('{}', { status: 401 })
    : new Response('[]', { headers: { 'content-type': 'application/json' } });
};
let component: ReturnType<typeof mount>;
async function run(): Promise<void> {
  clearKomga();
  component = mount(KomgaLogin, { target, props: { onchange: async () => { refreshes++; } } });
  await tick();
  check(target.querySelectorAll('input').length === 0, 'signed-out card has no credential fields');
  button('Sign in').click(); await settle();
  check(target.querySelector('dialog')?.open, 'Sign in opens a modal dialog');
  check(target.querySelectorAll('input').length === 3, 'dialog has address, username and password');
  check(document.activeElement === target.querySelector('input'), 'focus enters the prompt');
  check(target.querySelector('input[type="password"]') !== null, 'password is masked');
  await fill();
  check(!komgaConfigured(), 'editing does not autosave credentials');
  button('Cancel').click(); await tick();
  check(target.querySelectorAll('input').length === 0 && !komgaConfigured(), 'Cancel removes drafts without saving');

  button('Sign in').click(); await settle(); await fill();
  mode = 'refused'; submit(); await settle();
  check(!!target.querySelector('[role="alert"]')?.textContent?.includes('401'), 'refused login remains in dialog with an error');
  check(!komgaConfigured(), 'failed authentication is never saved');
  check(target.querySelector<HTMLInputElement>('input[type="password"]')?.value === '', 'failure clears the password draft');

  mode = 'ok'; await fill(); submit(); await settle();
  check(komgaConfigured(), 'successful login is saved after verification');
  check(target.querySelectorAll('input').length === 0, 'successful login removes all credential fields from DOM');
  check(!target.textContent?.includes(user) && !target.textContent?.includes(testSecret), 'saved card exposes neither username nor password');
  check(button('Log out') !== null && refreshes === 1, 'successful login offers Log out and refreshes sources');

  await unmount(component);
  component = mount(KomgaLogin, { target, props: { onchange: async () => { refreshes++; } } });
  await tick();
  check(target.querySelectorAll('input').length === 0 && !!button('Log out'), 'reopening settings keeps stored credentials out of the form');
  button('Log out').click(); await settle();
  check(komgaSettings() === null && refreshes === 2, 'Log out forgets credentials and refreshes sources');

  button('Sign in').click(); await settle(); await fill();
  mode = 'pending'; submit(); await settle();
  check(button('Signing in…').disabled, 'duplicate submissions are disabled');
  button('Cancel').click(); await tick();
  mode = 'ok'; release!(); await settle();
  check(!komgaConfigured() && target.querySelectorAll('input').length === 0, 'cancelled in-flight login cannot save credentials later');
  button('Sign in').click(); await settle();
  target.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); await tick();
  check(!target.querySelector('dialog')!.open, 'Escape dismisses the prompt');

  // Leave an empty prompt ready for narrow/landscape visual inspection.
  button('Sign in').click(); await settle();
  (window as any).__komgaQA = { ok: true, checks };
  document.querySelector('#result')!.textContent = `${checks.length} checks passed`;
}
void run().catch(error => {
  (window as any).__komgaQA = { ok: false, checks, error: String(error) };
  document.querySelector('#result')!.textContent = `FAIL: ${String(error)}`;
}).finally(() => { globalThis.fetch = originalFetch; });
