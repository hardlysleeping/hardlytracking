/** Open /tests/manual/komga-login.html on an isolated dev origin. No real server or credentials. */
import { mount, tick, unmount } from 'svelte';
import KomgaLogin from '../../src/components/KomgaLogin.svelte';
import { clearKomga, komgaConfigured, komgaServers, komgaSettings } from '../../src/lib/komga';
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
/** Name, address, username, password — the order the dialog draws them. */
async function fill(values: [string, string, string, string] = ['Fixture', base, user, testSecret]): Promise<void> {
  const inputs = target.querySelectorAll('dialog input');
  values.forEach((value, i) => {
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
  check(target.querySelectorAll('input').length === 0, 'an empty card has no credential fields');
  check(button('Add server') !== null, 'the card offers Add server');

  button('Add server').click(); await settle();
  check(target.querySelector('dialog')?.open, 'Add server opens a modal dialog');
  check(target.querySelectorAll('input').length === 4, 'dialog asks for name, address, username and password');
  check(document.activeElement === target.querySelector('input'), 'focus enters the prompt');
  check(target.querySelector('input[type="password"]') !== null, 'password is masked');
  await fill();
  check(!komgaConfigured(), 'editing does not autosave credentials');
  button('Cancel').click(); await tick();
  check(target.querySelectorAll('input').length === 0 && !komgaConfigured(), 'Cancel removes drafts without saving');

  button('Add server').click(); await settle(); await fill();
  mode = 'refused'; submit(); await settle();
  check(!!target.querySelector('[role="alert"]')?.textContent?.includes('401'), 'refused login remains in dialog with an error');
  check(!komgaConfigured(), 'failed authentication is never saved');
  check(target.querySelector<HTMLInputElement>('input[type="password"]')?.value === '', 'failure clears the password draft');

  mode = 'ok'; await fill(); submit(); await settle();
  check(komgaConfigured(), 'successful login is saved after verification');
  check(komgaServers().length === 1, 'the saved login becomes entry one');
  check(target.querySelectorAll('input[type="password"]').length === 0, 'a saved server keeps no password field in the DOM');
  check(!target.textContent?.includes(user) && !target.textContent?.includes(testSecret), 'saved card exposes neither username nor password');
  check(button('Test') !== null && button('Edit') !== null && button('Remove') !== null, 'each server offers Test, Edit and Remove');
  check(refreshes >= 1, 'saving refreshes the sources');

  button('Test').click(); await settle();
  check(!!target.textContent?.includes('no libraries are visible'), 'Test reports what that login can see');
  check(!!target.textContent?.includes('Fixture'), 'the server label is shown on its row');

  button('Edit').click(); await settle();
  check(target.querySelector('dialog')?.open, 'Edit opens the same dialog');
  check(
    [...target.querySelectorAll<HTMLInputElement>('dialog input')].map(input => input.value).join('|') === ['Fixture', base, user, ''].join('|'),
    'Edit prefills name, address and username but never the password',
  );
  await fill(['Renamed', base, user, '']);
  submit(); await settle();
  check(komgaServers()[0]?.label === 'Renamed', 'Edit renames the server');
  check(komgaServers()[0]?.password === testSecret, 'a blank password keeps the saved one');

  await unmount(component);
  component = mount(KomgaLogin, { target, props: { onchange: async () => { refreshes++; } } });
  await tick();
  check(target.querySelectorAll('input[type="password"]').length === 0, 'reopening settings keeps stored credentials out of the form');
  button('Remove').click(); await settle();
  check(komgaSettings() === null && komgaServers().length === 0, 'Remove forgets that server and refreshes sources');

  button('Add server').click(); await settle(); await fill();
  mode = 'pending'; submit(); await settle();
  check(button('Signing in…').disabled, 'duplicate submissions are disabled');
  button('Cancel').click(); await tick();
  mode = 'ok'; release!(); await settle();
  check(!komgaConfigured() && target.querySelectorAll('input[type="password"]').length === 0, 'cancelled in-flight login cannot save credentials later');

  button('Add server').click(); await settle();
  target.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true })); await tick();
  check(!target.querySelector('dialog')!.open, 'Escape dismisses the prompt');

  // Fill the list to its limit, then prove the refusal is on screen and not only in the model.
  for (const name of ['One', 'Two', 'Three']) {
    button('Add server').click(); await settle();
    await fill([name, base, `${user}-${name}`, testSecret]);
    submit(); await settle();
  }
  check(komgaServers().length === 3, 'three servers are allowed');
  button('Add server').click(); await settle();
  check(!target.querySelector('dialog')!.open, 'a fourth server does not open the prompt');
  check(!!target.querySelector('[role="alert"]')?.textContent?.includes('supports 3 Komga servers'), 'a fourth server is refused in words');

  // Leave one empty prompt ready for narrow/landscape visual inspection.
  button('Remove').click(); await settle();
  button('Add server').click(); await settle();
  (window as any).__komgaQA = { ok: true, checks };
  document.querySelector('#result')!.textContent = `${checks.length} checks passed`;
}
void run().catch(error => {
  (window as any).__komgaQA = { ok: false, checks, error: String(error) };
  document.querySelector('#result')!.textContent = `FAIL: ${String(error)}`;
}).finally(() => { globalThis.fetch = originalFetch; });
