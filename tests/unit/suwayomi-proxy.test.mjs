import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { suwayomiTarget, privateSuwayomiAddress, serveSuwayomi } from '../../server/suwayomi-target.mjs';
import { createSuwayomiProvider, suwayomiUrl } from '../../src/api/suwayomi.ts';

const encoded = base => Buffer.from(base).toString('base64url');
const path = (base, tail = '/api/graphql') => '/api/suwayomi/' + encoded(base) + tail;

test('proxy accepts private LAN/tailnet hosts but rejects public, deceptive names, credentials, traversal and non-API paths', () => {
  for (const host of ['127.0.0.1', '192.168.1.2', '100.100.1.2', '[::1]', '[fd00::1]', 'reader.local', 'reader.tail.ts.net']) {
    assert.equal(suwayomiTarget(path(`http://${host}:4567`)).url, `http://${host}:4567/api/graphql`);
  }
  for (const host of ['8.8.8.8', '127.evil.test', 'localhost.evil.test', 'fcevil.test', 'public.example', '[::ffff:808:808]']) {
    assert.equal(suwayomiTarget(path(`http://${host}`)).status, 403, host);
  }
  for (const base of ['ftp://127.0.0.1', 'http://u:p@127.0.0.1', 'http://127.0.0.1/?q=1']) assert.equal(suwayomiTarget(path(base)).status, 400);
  for (const tail of ['/api/v1/%2e%2e/secret', '//evil.test/api/graphql', '/api/v1/../graphql', '/capabilities', '/api/graphql/extra']) assert.equal(suwayomiTarget(path('http://127.0.0.1', tail)).status, 400);
  assert.equal(suwayomiTarget(path('http://127.0.0.1/suwayomi', '/api/v1/page'), '?x=1').url, 'http://127.0.0.1/suwayomi/api/v1/page?x=1');
  assert.equal(privateSuwayomiAddress('::ffff:7f00:1'), true);
  assert.equal(privateSuwayomiAddress('fe80::1'), true);
  assert.equal(privateSuwayomiAddress('fdpublic.test'), false);
});

async function listen(server) {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }

test('production proxy dispatch serves the scoped route and remains alive after denied targets', async () => {
  const reserve = createServer();
  const origin = await listen(reserve);
  const port = new URL(origin).port;
  await close(reserve);
  const child = spawn(process.execPath, ['server/proxy.mjs'], {
    cwd: new URL('../..', import.meta.url),
    env: { ...process.env, PORT: port, HOST: '127.0.0.1', HARDLYTRACKING_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const upstream = createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"data":{"sources":{"nodes":[]}}}'); });
  const base = await listen(upstream);
  try {
    await Promise.race([
      new Promise((resolve, reject) => {
        child.stdout.on('data', chunk => { if (String(chunk).includes('HardlyTracking on')) resolve(); });
        child.once('error', reject); child.once('exit', code => reject(Error('proxy exited ' + code)));
      }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('proxy startup timeout')), 5000); timer.unref(); }),
    ]);
    const response = await fetch(origin + path(base), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { data: { sources: { nodes: [] } } });
    assert.equal((await fetch(origin + path('http://8.8.8.8'))).status, 403);
    assert.equal((await fetch(origin + path(base), { method: 'POST', body: '{}' })).status, 200);
  } finally {
    child.kill('SIGTERM'); await once(child, 'exit'); await close(upstream);
  }
});

test('real browser proxy wire: GraphQL Basic auth, anonymous access, cover/page bytes, denied login, no redirect or app-token leaks', async () => {
  const seen = [];
  const upstream = createServer(async (req,res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ url: req.url, headers: req.headers, body });
    if (req.headers.authorization === 'Basic YmFkOmJhZA==') { res.writeHead(401, { 'www-authenticate': 'Basic realm="test"' }); res.end('Denied'); return; }
    if (req.url.endsWith('/redirect')) { res.writeHead(302, { location: 'http://8.8.8.8/' }); res.end(); return; }
    if (req.url.endsWith('/graphql')) {
      const query = JSON.parse(body).query;
      const data = query.includes('query Manga') ? { manga: { id: 1, title: 'Fixture', thumbnailUrl: '/api/v1/cover' } }
        : query.includes('mutation Pages') ? { fetchChapterPages: { pages: ['/api/v1/page'] } }
        : { sources: { nodes: [{ id: '123', name: 'Fixture', lang: 'en' }] } };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data })); return;
    }
    res.setHeader('content-type', 'image/png'); res.end(Buffer.from([1,2,3,4]));
  });
  const baseUrl = await listen(upstream);
  const proxy = createServer(serveSuwayomi);
  const origin = await listen(proxy);
  try {
    const p = createSuwayomiProvider({ baseUrl: baseUrl + '/api', username: 'reader', password: 'pass', proxied: true, origin });
    assert.equal((await p.sources())[0].id, 'mihon:src:123');
    const series = await p.details('mihon:1');
    assert.ok(series.cover.startsWith(origin + '/api/suwayomi/'));
    const cover = await fetch(series.cover, { headers: { ...series.coverHeaders, cookie: 'app=secret', 'x-hardlytracking-token': 'app-token' } });
    assert.deepEqual(new Uint8Array(await cover.arrayBuffer()), new Uint8Array([1,2,3,4]));
    const pages = await p.pages('mihon:ch:2');
    assert.equal((await fetch(pages[0].url, { headers: pages[0].headers })).status, 200);
    for (const req of seen) {
      assert.equal(req.headers.authorization, 'Basic cmVhZGVyOnBhc3M=');
      assert.equal(req.headers.cookie, undefined);
      assert.equal(req.headers['x-hardlytracking-token'], undefined);
    }
    const anonymous = createSuwayomiProvider({ baseUrl, username: '', password: '', proxied: true, origin });
    await anonymous.sources(); assert.equal(seen.at(-1).headers.authorization, undefined);
    const denied = await fetch(suwayomiUrl(baseUrl, 'graphql', true, origin), { method: 'POST', headers: { authorization: 'Basic YmFkOmJhZA==' }, body: '{}' });
    assert.equal(denied.status, 401); assert.equal(denied.headers.get('www-authenticate'), null);
    const redirect = await fetch(suwayomiUrl(baseUrl, '/api/v1/redirect', true, origin));
    assert.equal(redirect.status, 502); assert.equal(redirect.headers.get('location'), null);
    assert.equal((await fetch(origin + path('http://8.8.8.8'))).status, 403);
  } finally { await close(proxy); await close(upstream); }
});
