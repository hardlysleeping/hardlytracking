import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startNativeRuntimeDetailed, NATIVE_RUNTIME_PORT } from '../../src/lib/mihon-runtime.ts';
const deadlines = {load:20,status:20,start:20};

test('missing runtime plugin has a distinct diagnostic instead of a generic capability failure', async () => {
  const result = await startNativeRuntimeDetailed(NATIVE_RUNTIME_PORT, async () => null, deadlines);
  assert.equal(result.baseUrl, null);
  assert.match(result.error, /no registered.*runtime plugin/);
});

test('native JVM refusal retains its reason and startup stage', async () => {
  const result = await startNativeRuntimeDetailed(NATIVE_RUNTIME_PORT, async () => ({
    status: async () => ({running:false,port:0}),
    start: async () => { throw new Error('fixture: missing runtime resource'); },
  }), deadlines);
  assert.equal(result.baseUrl, null);
  assert.match(result.error, /Starting the on-device extension runtime: fixture: missing runtime resource/);
});

test('bridge import refusal is preserved rather than escaping or becoming null silently', async () => {
  const result = await startNativeRuntimeDetailed(NATIVE_RUNTIME_PORT, async () => { throw new Error('fixture bridge import failed'); }, deadlines);
  assert.equal(result.baseUrl, null);
  assert.match(result.error, /Loading.*fixture bridge import failed/);
});

test('startup timeout and status timeout are named separately and bounded', async () => {
  const hanging = () => new Promise(() => {});
  const status = await startNativeRuntimeDetailed(NATIVE_RUNTIME_PORT, async () => ({status:hanging}), deadlines);
  assert.match(status.error, /Checking.*status.*20 ms/);
  const start = await startNativeRuntimeDetailed(NATIVE_RUNTIME_PORT, async () => ({status:async()=>({running:false,port:0}),start:hanging}), deadlines);
  assert.match(start.error, /Starting.*20 ms/);
});

test('resolved start without a running server is not reported ready', async () => {
  const result = await startNativeRuntimeDetailed(NATIVE_RUNTIME_PORT, async () => ({
    status:async()=>({running:false,port:0}), start:async()=>({port:NATIVE_RUNTIME_PORT}),
  }), deadlines);
  assert.equal(result.baseUrl,null);
  assert.match(result.error,/server is not running/);
});

test('both APK install paths wait for host readiness before consuming bytes', () => {
  const source=readFileSync(new URL('../../src/state/library.svelte.ts',import.meta.url),'utf8');
  for (const [method,byteRead] of [['async installApk(file:', 'file.arrayBuffer()'],['async installEntry(entry:', 'downloadApk(entry)']]) {
    const start=source.indexOf(method);
    const end=source.indexOf('\n  }',start);
    const body=source.slice(start,end);
    assert.ok(body.indexOf('await this.ensureExtensionHost()')>=0);
    assert.ok(body.indexOf('await this.ensureExtensionHost()')<body.indexOf(byteRead));
  }
  assert.match(source,/hostAttachments = new WeakMap/);
});
