// Synthetic APK bytes and in-memory profile only: no real repository, runtime or installed source.
import { library } from '../../src/state/library.svelte';
const state = library as any;
const checks: string[] = [];
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
function check(value: unknown, name: string) { if (!value) throw new Error(name); checks.push(name); }
let ready = false, installed = 0, downloads = 0;
const profile: any = { dalvik: null, extensionWhere: 'device', providers: [], listExtensions: async () => [], installApk: async () => {
  if (!ready) throw new Error('no extension host answered /capabilities, so there is nothing to install onto');
  installed++;
  return {extensionId:'fixture:installed',packageId:'fixture.extension',sources:[]};
}};
state.profile = profile;
const originalEnsure = state.ensureExtensionHost;
const originalRun = state.runAttachHost;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { downloads++; return new Response(new Uint8Array([0,1,2,3])); };
const entry: any = {pkg:'fixture.extension',name:'Fixture extension',version:'1.0',versionCode:1,apkUrl:'https://fixture.example/fixture.apk'};
async function run() {
  for (const kind of ['repository','file']) {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    ready = false; installed = 0; downloads = 0;
    state.ensureExtensionHost = async () => { await waiting; };
    let outcome = 'pending';
    const install = (kind === 'file' ? library.installApk(new File([new Uint8Array([0])], 'fixture.apk')) : library.installEntry(entry, 'https://fixture.example/index.json'))
      .then(() => { outcome = 'installed'; }, error => { outcome = String(error); });
    await pause();
    check(outcome === 'pending' && installed === 0 && downloads === 0, `${kind}: waits for host before downloading or installing`);
    ready = true; release(); await install;
    check(outcome === 'installed' && installed === 1, `${kind}: continues after host readiness`);
  }
  downloads = 0; installed = 0;
  state.ensureExtensionHost = async () => { throw new Error('Native start refused: fixture diagnostic'); };
  const error = await library.installEntry(entry, 'https://fixture.example/index.json').then(() => '', cause => cause.message);
  check(error.includes('fixture diagnostic') && downloads === 0 && installed === 0, 'native failure is preserved and prevents APK download');

  // Use the actual startup coalescer while isolating only its native work.
  state.ensureExtensionHost = originalEnsure;
  let release!: () => void;
  let starts = 0;
  profile.dalvik = null;
  state.runAttachHost = async () => { starts++; await new Promise<void>(resolve => { release = resolve; }); profile.dalvik = {}; };
  const startup = state.attachHost(true);
  const second = state.attachHost(true);
  const installerWait = state.ensureExtensionHost();
  await pause();
  check(starts === 1, 'background startup and install share one host attachment');
  release(); await Promise.all([startup, second, installerWait]);
  check(profile.dalvik !== null, 'shared startup completion is visible to installer');

  state.runAttachHost = async () => { throw new Error('fixture first startup failure'); };
  profile.dalvik = null;
  await state.attachHost(true).catch(() => {});
  starts = 0;
  state.runAttachHost = async () => { starts++; profile.dalvik = {}; };
  await state.attachHost(true);
  check(starts === 1, 'a failed startup does not poison later install retries');
  (window as any).__installQA = {ok:true,checks};
  document.querySelector('#result')!.textContent = `${checks.length} checks passed`;
}
void run().catch(error => {
  (window as any).__installQA = {ok:false,checks,error:String(error)};
  document.querySelector('#result')!.textContent = String(error);
}).finally(() => { globalThis.fetch=originalFetch;state.ensureExtensionHost=originalEnsure;state.runAttachHost=originalRun; });
