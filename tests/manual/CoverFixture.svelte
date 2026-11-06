<script lang="ts">
  import Cover from '../../src/components/Cover.svelte';
  import GlobalWarning from '../../src/components/GlobalWarning.svelte';
  import AppShell from '../../src/components/AppShell.svelte';
  let dismissed = $state(false);
  import { imageCache } from '../../src/lib/cache/images';
  const rows = new Map();
  imageCache.attach({ get: async (_s: string, k: string) => rows.get(k), put: async (_s: string, v: any) => { rows.set(v.key, v); }, all: async () => [...rows.values()], remove: async () => true } as any);
  (window as any).coverResolutions = 0;
  const png = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30"><rect width="20" height="30" fill="red"/></svg>');
  const original = fetch;
  window.fetch = async (url, init) => String(url).includes('fixture-cover') ? new Response(await (await original(png)).blob(), { headers: { 'content-type': 'image/svg+xml' } }) : original(url, init);
</script>
<AppShell active="library">
  {#if !dismissed}<GlobalWarning message={'Fixture host error ' + 'long-unbroken-detail'.repeat(20)} ondismiss={() => { dismissed = true; }} />{/if}
  <header class="pin">Fixture heading</header>
  <div style="display:flex;gap:12px">
    <div style="width:128px" data-case="callback"><Cover series={{ title: 'Fixture cover', cover: '/fixture-cover.svg', coverHeaders: { Authorization: 'fixture' } }} onresolve={() => { (window as any).coverResolutions += 1; }} /></div>
    <div style="width:128px" data-case="plain"><Cover series={{ title: 'Plain cover', cover: '/fixture-cover.svg' }} /></div>
    <div style="width:128px" data-case="authenticated"><Cover series={{ title: 'Authenticated cover', cover: '/fixture-cover.svg', coverHeaders: { Authorization: 'fixture' } }} /></div>
  </div>
</AppShell>
