// Synthetic rows only; nothing here touches a real library or the network.
//
// The preferences are parked in sessionStorage so a reload can be used to prove that the *component*
// writes the choice to a pref and reads it back. The real store path (IndexedDB via
// `Settings.load`/`set`) is asserted where it lives, in `tests/unit/browse-display.test.mjs`.
import { mount } from 'svelte';
import Fixture from './DisplaySwitchFixture.svelte';
import '../../src/app.css';
import { DEFAULT_THEME, themeVariables } from '../../src/lib/theme-model';
for (const [key, value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key, value);

import { settings } from '../../src/state/settings.svelte';

const KEY = 'display-fixture-prefs';
const saved = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
for (const [key, value] of Object.entries(saved)) {
  (settings as unknown as Record<string, unknown>)[key] = value;
}
settings.set = ((key: string, value: unknown) => {
  (settings as unknown as Record<string, unknown>)[key] = value;
  const stored = JSON.parse(sessionStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
  stored[key] = value;
  sessionStorage.setItem(KEY, JSON.stringify(stored));
}) as typeof settings.set;

mount(Fixture, { target: document.getElementById('app')! });
