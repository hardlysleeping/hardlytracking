/** Scoped browser transport for a user-owned Suwayomi, never a general-purpose public proxy. */
import { isIP } from 'node:net';
import { lookup } from 'node:dns';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

export function privateSuwayomiAddress(value) {
  const host = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(host) === 4) {
    const [a,b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(host) === 6) {
    if (host.startsWith('::ffff:')) {
      const suffix = host.slice(7);
      if (isIP(suffix) === 4) return privateSuwayomiAddress(suffix);
      const parts = suffix.split(':');
      if (parts.length === 2) {
        const n = parts.map(p => parseInt(p, 16));
        return privateSuwayomiAddress(`${n[0] >> 8}.${n[0] & 255}.${n[1] >> 8}.${n[1] & 255}`);
      }
    }
    return host === '::1' || /^(fc|fd)[0-9a-f]{2}:|^fe[89ab][0-9a-f]:/.test(host);
  }
  return false;
}

export function suwayomiTarget(pathname, search = '') {
  const match = /^\/api\/suwayomi\/([A-Za-z0-9_-]+)(\/.*)$/.exec(pathname);
  if (!match) return { status: 400, error: 'missing or invalid Suwayomi address' };
  let base;
  try {
    const decoded = Buffer.from(match[1], 'base64url').toString('utf8');
    if (Buffer.from(decoded).toString('base64url') !== match[1]) throw Error();
    base = new URL(decoded);
  } catch { return { status: 400, error: 'bad Suwayomi address' }; }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) return { status: 400, error: 'only http(s), without embedded credentials' };
  const host = base.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!privateSuwayomiAddress(host) && host !== 'localhost' && !/\.(local|internal|lan|ts\.net)$/.test(host)) return { status: 403, error: 'only Suwayomi on your own network is proxied; installed apps connect directly' };
  const tail = match[2];
  if (!/^\/api\/(graphql|v1\/[^?#]*)$/.test(tail) || /%2f|%5c|%2e|\\|(?:^|\/)\.{1,2}(?:\/|$)/i.test(tail)) return { status: 400, error: 'only Suwayomi API paths are proxied' };
  const prefix = base.pathname.replace(/\/+$/, '');
  if (/%2f|%5c|%2e|\\/i.test(prefix)) return { status: 400, error: 'bad Suwayomi base path' };
  return { url: `${base.origin}${prefix}${tail}${search}` };
}

/** Check the actual DNS result on every connection, not only the user-supplied host name. */
function privateLookup(host, options, callback) {
  lookup(host, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    if (!addresses.length || addresses.some(row => !privateSuwayomiAddress(row.address))) return callback(new Error('Suwayomi resolved outside your own network'));
    callback(null, options?.all ? addresses : addresses[0].address, addresses[0].family);
  });
}

export async function serveSuwayomi(request, response) {
  const incoming = new URL(request.url ?? '/', 'http://localhost');
  const target = suwayomiTarget(incoming.pathname, incoming.search);
  if (!target.url) { response.writeHead(target.status); response.end(target.error); return; }
  if (!['GET','HEAD','POST'].includes(request.method) || (request.method === 'POST' && !new URL(target.url).pathname.endsWith('/api/graphql'))) {
    response.writeHead(405); response.end('unsupported Suwayomi method'); return;
  }
  // Explicit allowlist: never forward app cookies, app pairing tokens or the browser's Host.
  const headers = {};
  for (const name of ['authorization','content-type','accept','range','if-none-match']) if (request.headers[name]) headers[name] = request.headers[name];
  const url = new URL(target.url);
  const upstream = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: request.method, headers, lookup: privateLookup }, result => {
    // Do not follow redirects or return a Location that would bypass target validation/leak auth.
    if (result.statusCode >= 300 && result.statusCode < 400 && result.statusCode !== 304) {
      result.resume(); response.writeHead(502); response.end('Suwayomi redirects are not proxied'); return;
    }
    const out = {};
    for (const name of ['content-type','content-length','content-encoding','cache-control','etag','content-range','accept-ranges']) if (result.headers[name]) out[name] = result.headers[name];
    response.writeHead(result.statusCode ?? 502, out);
    result.on('error', () => response.destroy());
    result.pipe(response);
  });
  const deadline = setTimeout(() => upstream.destroy(new Error('Suwayomi deadline exceeded')), 30_000);
  upstream.on('close', () => clearTimeout(deadline));
  upstream.on('error', () => {
    if (!response.headersSent) { response.writeHead(502); response.end('Suwayomi is not answering on your network'); }
    else response.destroy();
  });
  let size = 0;
  request.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) upstream.destroy(new Error('request too large')); });
  request.on('aborted', () => upstream.destroy());
  response.on('close', () => { if (!response.writableFinished) upstream.destroy(); });
  request.pipe(upstream);
}
