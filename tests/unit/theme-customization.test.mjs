import test from 'node:test';
import assert from 'node:assert/strict';
import { COLOUR_KEYS, DEFAULT_THEME, THEME_KEY, LEGACY_THEME_KEY, parseTheme, readTheme, themeVariables, contrast } from '../../src/lib/theme-model.ts';

// Exercise the real synchronous paint/storage methods; browser QA separately checks compiled runes.
globalThis.$state = value => value;
const { appearance } = await import('../../src/lib/theme.svelte.ts');
const styles = new Map();
const stored = new Map();
globalThis.document = { documentElement: { dataset: {}, style: { setProperty: (key, value) => styles.set(key, value) } } };
globalThis.localStorage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) };

test('semantic colors preserve the requested red eye / blue pin defaults', () => {
  assert.equal(DEFAULT_THEME.hidden, '#e5484d');
  assert.equal(DEFAULT_THEME.pinned, '#0078e0');
  assert.equal(DEFAULT_THEME.monotoneActions, false);
  assert.equal(COLOUR_KEYS.length, 10);
});

test('invalid persisted appearance is validated field by field, not applied as CSS', () => {
  const parsed = parseTheme({ accent: 'url(https://example.test)', pinned: '#f00', hidden: '#123456', bgImage: 'https://example.test/image', bgBlur: 900, bgDim: -10, bgGlass: 'true' });
  assert.equal(parsed.accent, DEFAULT_THEME.accent);
  assert.equal(parsed.pinned, '#ff0000');
  assert.equal(parsed.hidden, '#123456');
  assert.equal(parsed.bgImage, null);
  assert.equal(parsed.bgBlur, 24);
  assert.equal(parsed.bgDim, 0);
  assert.equal(parsed.bgGlass, false);
});

test('legacy mode survives migration and malformed new storage', () => {
  const storage = { getItem: key => key === LEGACY_THEME_KEY ? 'oled' : '{invalid' };
  assert.equal(readTheme(storage).mode, 'oled');
});

test('every color updates its CSS token and persistence synchronously', () => {
  appearance.reset();
  for (const key of COLOUR_KEYS) {
    appearance.set(key, '#123456');
    const token = key === 'accent' ? '--accent' : `--tone-${key.replace(/[A-Z]/g, c => '-' + c.toLowerCase())}`;
    assert.equal(styles.get(token), '#123456', `${key} did not paint before set returned`);
    assert.equal(JSON.parse(stored.get(THEME_KEY))[key], '#123456');
  }
});

test('mode switches preserve chosen colors, and start restores persisted customization', () => {
  appearance.set('accent', '#abcdef');
  appearance.apply('light');
  assert.equal(appearance.current.accent, '#abcdef');
  appearance.start();
  assert.equal(appearance.theme, 'light');
  assert.equal(styles.get('--accent'), '#abcdef');
});

test('background, blur and dim sliders paint immediately; reset restores defaults', () => {
  appearance.set('bg', '#654321');
  appearance.set('bgBlur', 12);
  appearance.set('bgDim', 25);
  assert.equal(styles.get('--page-bg'), '#654321');
  assert.equal(styles.get('--bg-blur'), '12px');
  assert.equal(styles.get('--bg-dim'), '0.25');
  appearance.reset();
  assert.deepEqual(appearance.current, DEFAULT_THEME);
});

test('storage failure never prevents immediate preview', () => {
  const original = globalThis.localStorage;
  globalThis.localStorage = { ...original, setItem() { throw new Error('quota'); } };
  try {
    appearance.set('accent', '#987654');
    assert.equal(styles.get('--accent'), '#987654');
    assert.match(appearance.storageError, /Applied for this session/);
  } finally { globalThis.localStorage = original; appearance.reset(); }
});

test('text variants retain readable contrast across base modes and extreme chosen colors', () => {
  for (const mode of ['light', 'dark', 'oled', 'system']) {
    for (const color of ['#ffffff', '#000000', '#777777', '#00ff00', '#ff0000']) {
      const theme = parseTheme({ mode, accent: color, hidden: color, pinned: color });
      for (const systemLight of [true, false]) {
        const vars = themeVariables(theme, systemLight);
        const surface = mode === 'light' || mode === 'system' && systemLight ? '#ffffff' : mode === 'oled' ? '#0a0a0c' : '#15151b';
        for (const name of ['--accent-text', '--tone-hidden-text', '--tone-pinned-text']) assert.ok(contrast(vars[name], surface) >= 4.5, `${name} ${mode} ${color}`);
      }
    }
  }
});
