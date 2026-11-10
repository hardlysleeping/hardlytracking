import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EXTENSION_PACKAGE_PREFIX,
  decodeBase64,
  deviceExtensionsOf,
  isExtensionPackage,
  listDeviceExtensions,
  readDeviceExtensionApk,
} from '../../src/lib/extensions/device.ts';
/** @typedef {import('../../src/lib/extensions/device.ts').DeviceExtensionBridge} DeviceExtensionBridge */

test('only extension packages are extension packages', () => {
  assert.equal(isExtensionPackage('eu.kanade.tachiyomi.extension.all.mangafire'), true);
  assert.equal(isExtensionPackage(EXTENSION_PACKAGE_PREFIX), true);
  // A different app whose id merely starts the same way is not an extension.
  assert.equal(isExtensionPackage('eu.kanade.tachiyomi.extensiontools'), false);
  assert.equal(isExtensionPackage('eu.kanade.tachiyomi'), false);
  assert.equal(isExtensionPackage('app.mihon'), false);
  assert.equal(isExtensionPackage(''), false);
});

test('rows are filtered, named, de-duplicated and sorted', () => {
  const rows = deviceExtensionsOf([
    { packageId: 'eu.kanade.tachiyomi.extension.en.mangadex', versionName: '1.4.36', versionCode: 36 },
    { packageId: 'eu.kanade.tachiyomi.extension.all.mangafire', versionName: '1.4.9', versionCode: 9 },
    { packageId: 'eu.kanade.tachiyomi.extensiontools', versionName: '9', versionCode: 9 },
    { packageId: 'app.mihon', versionName: '0.19.1', versionCode: 1901 },
    // Same package twice with different codes: the higher one wins.
    { packageId: 'eu.kanade.tachiyomi.extension.en.mangadex', versionName: '1.4.30', versionCode: 30 },
    { packageId: 42, versionName: 'nope' },
  ]);
  // Sorted by the name a person reads: Mangadex before Mangafire.
  assert.deepEqual(rows.map((row) => row.packageId), [
    'eu.kanade.tachiyomi.extension.en.mangadex',
    'eu.kanade.tachiyomi.extension.all.mangafire',
  ]);
  assert.deepEqual(rows.map((row) => row.name), ['Mangadex', 'Mangafire']);
  assert.equal(rows[0]?.versionCode, 36, 'the higher version code wins');
  assert.equal(rows[0]?.versionName, '1.4.36');
});

test('a missing or odd version code is 0, never "newer than what is installed"', () => {
  for (const value of [undefined, null, '', 'abc', -1, NaN, Infinity]) {
    const [row] = deviceExtensionsOf([{ packageId: 'eu.kanade.tachiyomi.extension.en.x', versionCode: value }]);
    assert.equal(row?.versionCode, 0);
  }
  const [row] = deviceExtensionsOf([{ packageId: 'eu.kanade.tachiyomi.extension.en.x', versionCode: '37' }]);
  assert.equal(row?.versionCode, 37, 'a numeric string is still a version');
});

test('base64 decodes to the same bytes, padding and line breaks included', () => {
  const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x7f, 0x10]);
  // "UEsDBP8AfxA=" — a zip header, then bytes that are not printable.
  assert.deepEqual([...decodeBase64('UEsDBP8AfxA=')], [...bytes]);
  assert.deepEqual([...decodeBase64('UEsD\nBP8A\nfxA=')], [...bytes]);
  assert.deepEqual([...decodeBase64('')], []);
  // A single trailing byte: the decoder must not emit a phantom one.
  assert.deepEqual([...decodeBase64('QQ==')], [0x41]);
});

const bridge = (rows, base64 = 'UEsDBA==') => ({
  list: async () => ({ extensions: rows }),
  apk: async ({ packageId }) => ({ base64: packageId.includes('missing') ? '' : base64 }),
});

test('the bridge is optional: no shell means no extensions and no throw', async () => {
  assert.deepEqual(await listDeviceExtensions(async () => null), []);
  await assert.rejects(() => readDeviceExtensionApk('eu.kanade.tachiyomi.extension.en.x', async () => null), /cannot read installed extensions/);
});

test('a listing answers rows, and a read answers the APK bytes', async () => {
  const rows = await listDeviceExtensions(async () => bridge([
    { packageId: 'eu.kanade.tachiyomi.extension.en.mangadex', versionName: '1.4.36', versionCode: 36 },
  ]));
  assert.deepEqual(rows.map((row) => row.packageId), ['eu.kanade.tachiyomi.extension.en.mangadex']);

  const bytes = await readDeviceExtensionApk('eu.kanade.tachiyomi.extension.en.mangadex', async () => bridge([]));
  assert.deepEqual([...bytes], [0x50, 0x4b, 0x03, 0x04]);
});

test('an empty read is an error that names the package, and a non-extension is refused unread', async () => {
  await assert.rejects(
    () => readDeviceExtensionApk('eu.kanade.tachiyomi.extension.en.missing', async () => bridge([])),
    /could not read the APK for eu\.kanade\.tachiyomi\.extension\.en\.missing/,
  );
  await assert.rejects(() => readDeviceExtensionApk('app.mihon', async () => bridge([])), /not an extension package/);
});

test('a throwing shell reads as "nothing on this device", not as a broken screen', async () => {
  const broken = {
    list: async () => {
      throw new Error('bridge wedged');
    },
    apk: async () => ({ base64: '' }),
  };
  assert.deepEqual(await listDeviceExtensions(async () => broken), []);
});
