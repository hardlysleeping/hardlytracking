// The screen-curtain PIN, end to end in a browser: lock without a PIN opens the prompt, setting
// then locking works, a wrong PIN keeps the curtain up, the right one raises it, and Settings'
// change/remove refuse a wrong current PIN. Memory database and synthetic digits only.
//
// Run against this worktree's Vite on :5217:
//   PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node tests/manual/pin-browser.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const browser = await chromium.launch({ headless: true });
const out = new URL('../../data/pin-qa/', import.meta.url);
await mkdir(out, { recursive: true });
const evidence = [];
const errors = [];

const page = await browser.newPage({ viewport: { width: 440, height: 956 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/*', (route) => (new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort()));

try {
  await page.goto('http://127.0.0.1:5217/tests/manual/pin-fixture.html');
  await page.waitForFunction(() => window.pinFixture);

  const state = () => page.evaluate(() => ({
    locked: window.pinFixture.privacy.locked,
    pin: window.pinFixture.settings.privacyPin,
    folded: window.pinFixture.privacy.bandCollapsed,
  }));
  const dialog = () => page.getByRole('dialog');
  const status = () => dialog().getByRole('status').innerText();
  const type = async (pin) => {
    const sheet = dialog();
    for (const digit of pin) await sheet.getByRole('button', { name: digit, exact: true }).click();
  };
  const act = (name) => dialog().getByRole('button', { name, exact: true }).click();
  const lockSeat = () => page.getByRole('button', { name: 'Lock local privacy screen', exact: true }).click();
  const unlockSeat = () => page.getByRole('button', { name: 'Unlock local privacy screen', exact: true }).click();
  const savedPref = () => page.evaluate(() => window.pinFixture.store.getPref('settings.privacyPin'));
  const verify = (pin) => page.evaluate((value) => window.pinFixture.verify(value), pin);
  const panel = page.getByRole('region', { name: 'Privacy settings' });

  // 1. No PIN: the Lock seat asks for one instead of lowering a curtain nobody can raise.
  assert.equal((await state()).pin, '', 'a fresh profile has no PIN');
  assert.equal(await dialog().count(), 0);
  await lockSeat();
  await page.getByRole('dialog', { name: 'Set a PIN' }).waitFor();
  assert.equal((await state()).locked, false, 'lock refused while no PIN is set');
  assert.match(await dialog().innerText(), /salted hash/, 'the sheet says how it is stored');
  evidence.push({ check: 'lock with no PIN opens the Set a PIN prompt and does not lock', pass: true });

  // 2. Set and confirm: the PIN is stored as a hash on the preference the export/sync carry.
  await type('1234');
  await act('Continue');
  await page.getByRole('dialog', { name: 'Confirm the PIN' }).waitFor();
  await type('1234');
  await act('Set PIN');
  await dialog().waitFor({ state: 'detached' });
  let now = await state();
  assert.equal(now.locked, true, 'setting a PIN locks in the same press');
  assert.equal(now.folded, true, 'locking folds the band');
  assert.match(now.pin, /^sha256:[0-9a-f]{32}:[0-9a-f]{64}$/);
  assert.equal(await verify('1234'), true);
  assert.equal(await verify('4321'), false);
  await page.waitForTimeout(150);
  assert.equal(await savedPref(), now.pin, 'the hash is the stored preference, not the digits');
  evidence.push({ check: 'setting then locking stores sha256:<salt>:<hash> in settings.privacyPin', pass: true });

  // 3. Wrong PIN keeps the curtain up, and says how many tries are left.
  await page.getByRole('button', { name: 'Show visibility controls', exact: true }).click();
  await unlockSeat();
  await page.getByRole('dialog', { name: 'Enter your PIN' }).waitFor();
  await type('0000');
  await act('Unlock');
  assert.match(await status(), /That PIN is not right — 4 tries left\./);
  assert.equal((await state()).locked, true, 'a wrong PIN does not unlock');
  assert.equal(await dialog().count(), 1, 'the keypad stays open');
  evidence.push({ check: 'wrong PIN keeps the curtain up and reports the tries left', pass: true });

  // 4. The right PIN raises it.
  await type('1234');
  await act('Unlock');
  await dialog().waitFor({ state: 'detached' });
  assert.equal((await state()).locked, false);
  evidence.push({ check: 'the right PIN raises the curtain', pass: true });

  // 5. Settings copy: one PIN across devices, hash only, not encryption.
  const copy = await panel.innerText();
  for (const phrase of ['salted hash', 'HardlySync', 'not encryption']) assert.ok(copy.includes(phrase), `missing "${phrase}"`);

  // 6. Change PIN refuses a wrong current PIN and writes nothing.
  await panel.getByRole('button', { name: 'Change PIN' }).click();
  await page.getByRole('dialog', { name: 'Enter the current PIN' }).waitFor();
  await type('0000');
  await act('Continue');
  assert.match(await status(), /That PIN is not right\./);
  assert.equal(await verify('1234'), true, 'a wrong current PIN leaves the old one in place');
  assert.equal(await page.getByRole('dialog', { name: 'Enter the current PIN' }).count(), 1);
  evidence.push({ check: 'change PIN requires the current PIN', pass: true });

  // 7. With the current PIN, a new one is stored and the old one stops working.
  await type('1234');
  await act('Continue');
  await page.getByRole('dialog', { name: 'Choose a new PIN' }).waitFor();
  await type('5678');
  await act('Continue');
  await page.getByRole('dialog', { name: 'Confirm the new PIN' }).waitFor();
  await type('5678');
  await act('Change PIN');
  await dialog().waitFor({ state: 'detached' });
  await page.waitForTimeout(150);
  assert.equal(await verify('5678'), true);
  assert.equal(await verify('1234'), false);
  assert.equal(await savedPref(), (await state()).pin);
  evidence.push({ check: 'change PIN with the current PIN replaces the hash', pass: true });

  // 8. Remove PIN requires the current PIN, then the curtain refuses to lock again.
  await panel.getByRole('button', { name: 'Remove PIN' }).click();
  await page.getByRole('dialog', { name: 'Remove the PIN' }).waitFor();
  await type('0000');
  await act('Remove PIN');
  assert.match(await status(), /That PIN is not right\./);
  assert.notEqual((await state()).pin, '', 'a wrong current PIN does not remove it');
  await type('5678');
  await act('Remove PIN');
  await dialog().waitFor({ state: 'detached' });
  await page.waitForTimeout(150);
  assert.equal((await state()).pin, '');
  assert.equal(await savedPref(), '');
  assert.equal(await verify('5678'), false);
  evidence.push({ check: 'remove PIN requires the current PIN', pass: true });

  await lockSeat();
  await page.getByRole('dialog', { name: 'Set a PIN' }).waitFor();
  assert.equal((await state()).locked, false, 'with no PIN the curtain still refuses');
  await act('Cancel');
  await dialog().waitFor({ state: 'detached' });
  evidence.push({ check: 'after removal, Lock asks for a PIN again', pass: true });

  await page.screenshot({ path: new URL('pin-final.png', out).pathname, fullPage: false });
  assert.deepEqual(errors, []);
  await writeFile(new URL('evidence.json', out), JSON.stringify({ kind: 'Chromium browser emulation, not physical device proof', evidence, errors }, null, 2));
  console.log(JSON.stringify({ pass: true, evidence, errors, artifacts: out.pathname }, null, 2));
} finally {
  await browser.close();
}
