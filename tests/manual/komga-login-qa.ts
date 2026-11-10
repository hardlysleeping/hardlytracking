/** Open /tests/manual/komga-login.html on an isolated dev origin. No real server or credentials. */
import { mount, tick, unmount } from 'svelte';
import KomgaLogin from '../../src/components/KomgaLogin.svelte';
import { addKomgaServer, clearKomga, komgaConfigured, komgaServers, komgaSettings } from '../../src/lib/komga';
import '../../src/app.css';

const target = document.querySelector('#fixture')!;
const checks: string[] = [];
let refreshes = 0;
let mode: 'ok' | 'refused' | 'pending' | 'libraries-down' = 'ok';
let release: (() => void) | undefined;
const originalFetch = globalThis.fetch;
const testSecret = crypto.randomUUID(); // Synthetic, never a real login.
const user = 'fixture-reader';
const base = 'http://fixture.tailnet.ts.net:25600';
const pickerLibraries = [
  { id: 'lib-comics', name: 'Comics' },
  { id: 'lib-mags', name: 'Magazines' },
];
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

globalThis.fetch = async (input) => {
  if (mode === 'pending') await new Promise<void>(resolve => { release = resolve; });
  if (mode === 'refused') return new Response('{}', { status: 401 });
  const url = String(input);
  if (mode === 'libraries-down' && url.includes('/api/v1/libraries')) throw new TypeError('Failed to fetch');
  if (url.includes('/api/v1/libraries')) {
    return new Response(JSON.stringify(pickerLibraries), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('[]', { headers: { 'content-type': 'application/json' } });
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

  // The aggregate source's picker: All plus the libraries that server reports.
  const picker = target.querySelector('select')!;
  check(picker !== null, 'a saved server draws a Library picker');
  check(
    [...picker.options].map(option => option.textContent?.trim()).join('|') === 'All libraries|Comics|Magazines',
    'the picker offers All and every library the server reports',
  );
  check(picker.value === '', 'a server without a saved choice sits on All');
  picker.value = 'lib-comics';
  picker.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  check(komgaServers()[0]?.libraryId === 'lib-comics', 'choosing a library saves it on that server');
  check(target.querySelector<HTMLSelectElement>('select')?.value === 'lib-comics', 'the saved choice is reflected without a relaunch');
  check(refreshes >= 2, 'choosing a library refreshes the sources');

  const cleared = target.querySelector('select')!;
  cleared.value = '';
  cleared.dispatchEvent(new Event('change', { bubbles: true })); await settle();
  check(komgaServers()[0]?.libraryId === undefined, 'choosing All clears the saved library');

  button('Test').click(); await settle();
  const testResult = target.querySelector('.result')?.textContent ?? '';
  check(testResult.includes('Signed in'), 'Test reports what that login can see');
  check(testResult.includes('Comics'), 'Test names the libraries the picker offers');
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

  // A second server is nearly always the same box and login, read for another library. The dialog
  // copies the saved one so the only thing to type is the name.
  button('Add server').click(); await settle();
  check(
    [...target.querySelectorAll<HTMLInputElement>('dialog input')].slice(1).map(input => input.value).join('|') === [base, user, testSecret].join('|'),
    'a new server starts with the saved address and login',
  );
  check(
    target.querySelector<HTMLInputElement>('dialog input')?.value === 'Komga 2',
    'the name counts up so two entries on one box stay apart',
  );
  check(!!target.querySelector('.seeded')?.textContent?.includes('Renamed'), 'the dialog names the server it copied');
  button('Cancel').click(); await tick();

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

  // A server that cannot be reached must say so where its picker is, not draw an empty list.
  await unmount(component);
  clearKomga();
  addKomgaServer({ label: 'Offline', baseUrl: base, username: user, password: testSecret });
  mode = 'libraries-down';
  component = mount(KomgaLogin, { target, props: { onchange: async () => { refreshes++; } } });
  await settle();
  const offline = target.querySelector<HTMLSelectElement>('select')!;
  check(offline !== null, 'an unreachable server still draws its Library picker');
  check([...offline.options].map(option => option.textContent?.trim()).join('|') === 'All libraries', 'an unreachable server cannot invent library choices');
  check(!!target.textContent?.includes('Komga is not answering'), 'an unreachable server names the failure beside the picker');

  // Leave one empty prompt ready for narrow/landscape visual inspection.
  await unmount(component);
  clearKomga();
  mode = 'ok';
  component = mount(KomgaLogin, { target, props: { onchange: async () => { refreshes++; } } });
  await tick();
  button('Add server').click(); await settle();
  (window as any).__komgaQA = { ok: true, checks };
  document.querySelector('#result')!.textContent = `${checks.length} checks passed`;
}
void run().catch(error => {
  (window as any).__komgaQA = { ok: false, checks, error: String(error) };
  document.querySelector('#result')!.textContent = `FAIL: ${String(error)}`;
}).finally(() => { globalThis.fetch = originalFetch; });
