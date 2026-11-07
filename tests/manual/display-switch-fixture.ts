// Synthetic rows only; nothing here touches a real library or the network.
import { mount } from 'svelte';
import Fixture from './DisplaySwitchFixture.svelte';
import '../../src/app.css';
import { DEFAULT_THEME, themeVariables } from '../../src/lib/theme-model';
for (const [key, value] of Object.entries(themeVariables(DEFAULT_THEME))) document.documentElement.style.setProperty(key, value);
mount(Fixture, { target: document.getElementById('app')! });
