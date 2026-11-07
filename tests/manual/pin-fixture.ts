// Synthetic memory database only. Never call library.open(); nothing here touches a real library.
import { mount } from 'svelte';
import Fixture from './PinFixture.svelte';
import '../../src/app.css';
import { DEFAULT_THEME, themeVariables } from '../../src/lib/theme-model';
for (const [key, value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key, value);
import { memoryDatabase } from '../../src/lib/db/open';
import { LibraryStore } from '../../src/lib/db/store';
import { settings } from '../../src/state/settings.svelte';
import { privacy } from '../../src/state/privacy.svelte';
import { categories } from '../../src/state/categories.svelte';
import { verifyPin } from '../../src/lib/pin';

const store = new LibraryStore(memoryDatabase());
// The app's own load path: an empty database leaves privacyPin "" and gives `set` its store, so a
// legitimate PIN write is proven to land in `settings.privacyPin` (the key an export and the
// HardlySync document read).
await settings.load(store);
await categories.load(store);

(window as any).pinFixture = {
  settings,
  privacy,
  categories,
  store,
  verify: (pin: string) => verifyPin(settings.privacyPin, pin),
};

mount(Fixture, { target: document.body });
