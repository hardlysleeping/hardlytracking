import { mount } from 'svelte';
import CoverFixture from './CoverFixture.svelte';
import '../../src/app.css';
mount(CoverFixture, {target: document.querySelector('#app')!});
