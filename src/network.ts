/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import http, { type ClientRequest, type IncomingMessage } from 'node:http';
import https, { type RequestOptions } from 'node:https';
import { isIP, type LookupFunction, type Socket } from 'node:net';
import tls from 'node:tls';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';
import { SurfError } from './errors.ts';
import type { FetchOptions, FetchResult, PublicFetcher } from './types.ts';

type Address = { address: string; family: number };
type RequestFactory = (url: URL, options: RequestOptions, callback?: (response: IncomingMessage) => void) => ClientRequest;
/** Trusted test seams only: never accepted through tools, service input or configuration. */
export interface NetworkDependencies {
  lookup?: (hostname: string) => Promise<Address[]>;
  request?: RequestFactory;
  tlsConnect?: typeof tls.connect;
}

const nativeRequest: RequestFactory = (url, options, callback) =>
  (url.protocol === 'https:' ? https.request : http.request)(url, options, callback);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const LOCAL_SUFFIXES = ['localhost', 'local', 'internal', 'lan', 'home', 'home.arpa', 'invalid', 'test', 'example', 'onion'];

function publicAddress(address: string): boolean {
  if (!isIP(address)) return false;
  try {
    const parsed = ipaddr.parse(address);
    if (parsed.range() !== 'unicast') return false;
    if (parsed.kind() === 'ipv6') {
      // Permit globally allocated unicast space only, excluding newer documentation space.
      return parsed.match(ipaddr.parse('2000::'), 3) && !parsed.match(ipaddr.parse('3fff::'), 20);
    }
    return true;
  } catch { return false; }
}

function hostname(url: URL): string {
  return url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
}

/** Syntax and literal-address checks. Requests additionally validate and pin every DNS result. */
export function parsePublicUrl(raw: string): URL {
  if (typeof raw !== 'string' || raw.length > 8192 || !/^https?:\/\//i.test(raw) || /[\s\x00-\x1f\x7f\\]/.test(raw)) {
    throw new SurfError('unsafe_url');
  }
  let url: URL;
  try { url = new URL(raw); } catch { throw new SurfError('unsafe_url'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(raw)) {
    throw new SurfError('unsafe_url');
  }
  const host = hostname(url);
  if (!host) throw new SurfError('unsafe_url');
  if (isIP(host)) {
    if (!publicAddress(host)) throw new SurfError('unsafe_url');
  } else {
    if (!host.includes('.') || host.length > 253 || LOCAL_SUFFIXES.some(s => host === s || host.endsWith(`.${s}`)) ||
      !host.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new SurfError('unsafe_url');
    }
  }
  url.hash = '';
  return url;
}

function proxyAddress(raw: string): { url: URL; authorization?: string } {
  let url: URL;
  try { url = new URL(raw); } catch { throw new SurfError('config_invalid'); }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.search || url.hash || (url.pathname && url.pathname !== '/') || raw.length > 4096) {
    throw new SurfError('config_invalid');
  }
  let authorization: string | undefined;
  if (url.username || url.password) {
    try {
      authorization = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`, 'utf8').toString('base64')}`;
    } catch { throw new SurfError('config_invalid'); }
  }
  url.username = ''; url.password = '';
  return { url, authorization };
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener('abort', abort);
    const abort = () => { cleanup(); reject(new SurfError('cancelled')); };
    if (signal.aborted) { reject(new SurfError('cancelled')); return; }
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}

function requestHeaders(extra: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': 'WhaleLife-Surf/0.1.0 (public-page-reader)',
    'accept': 'text/html, text/plain;q=0.9, */*;q=0.5',
    'accept-encoding': 'gzip, deflate, br',
  };
  for (const [key, value] of Object.entries(extra ?? {})) {
    const name = key.toLowerCase();
    if (!['accept', 'accept-language', 'x-subscription-token'].includes(name) || typeof value !== 'string' || value.length > 4096 || /[\r\n\x00]/.test(value)) {
      throw new SurfError('invalid_input');
    }
    headers[name] = value;
  }
  return headers;
}

function responseHeaders(response: IncomingMessage): Record<string, string> {
  const result: Record<string, string> = {};
  for (const name of ['content-type', 'content-length', 'content-encoding', 'location', 'retry-after']) {
    const value = response.headers[name];
    if (typeof value === 'string') result[name] = value;
  }
  return result;
}

async function readBody(response: IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const length = response.headers['content-length'];
  if (length && /^\d+$/.test(length) && Number(length) > maxBytes) {
    response.destroy(); throw new SurfError('too_large');
  }
  const encoding = (response.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  const decoder = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip()
    : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
  if (!decoder && encoding !== 'identity' && encoding !== '') {
    response.destroy(); throw new SurfError('unsupported_content');
  }
  let transferred = 0;
  let expanded = 0;
  const chunks: Buffer[] = [];
  const wireLimit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    transferred += chunk.length;
    callback(transferred > maxBytes ? new SurfError('too_large') : null, chunk);
  } });
  const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
    expanded += chunk.length;
    if (expanded > maxBytes) { callback(new SurfError('too_large')); return; }
    chunks.push(Buffer.from(chunk)); callback();
  } });
  if (decoder) await pipeline(response, wireLimit, decoder, sink, { signal });
  else await pipeline(response, wireLimit, sink, { signal });
  return Buffer.concat(chunks, expanded);
}

async function openTunnel(
  target: URL, address: Address, proxy: string, signal: AbortSignal, request: RequestFactory, tlsConnect: typeof tls.connect,
): Promise<{ agent: http.Agent; close: () => void }> {
  const parsed = proxyAddress(proxy);
  const host = hostname(target);
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  // Resolve at the trusted client; CONNECT an already validated IP so the proxy cannot re-resolve the target.
  const authority = `${address.family === 6 ? `[${address.address}]` : address.address}:${port}`;
  const socket = await new Promise<Socket>((resolve, reject) => {
    const req = request(parsed.url, {
      method: 'CONNECT', path: authority, agent: false, signal, rejectUnauthorized: true,
      maxHeaderSize: 16 * 1024,
      headers: { host: authority, ...(parsed.authorization ? { 'proxy-authorization': parsed.authorization } : {}) },
    });
    req.once('error', reject);
    req.once('connect', (response, connected, head) => {
      if (signal.aborted || response.statusCode !== 200 || head.length) {
        connected.destroy(); reject(new SurfError(signal.aborted ? 'cancelled' : 'network_error')); return;
      }
      resolve(connected);
    });
    req.once('response', response => { response.destroy(); reject(new SurfError('network_error')); });
    req.end();
  });
  let connection: Socket = socket;
  const agent = target.protocol === 'https:' ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
  const abort = () => { connection.destroy(); socket.destroy(); agent.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { abort(); signal.removeEventListener('abort', abort); throw new SurfError('cancelled'); }
  if (target.protocol === 'https:') {
    try {
      connection = tlsConnect({
        socket, servername: isIP(host) ? undefined : host, rejectUnauthorized: true,
        checkServerIdentity: (_servername, certificate) => tls.checkServerIdentity(host, certificate),
      });
    } catch (error) { signal.removeEventListener('abort', abort); abort(); throw error; }
    // ClientRequest attaches its handler synchronously after this function resolves. Keep an error listener meanwhile.
    connection.on('error', () => {});
  }
  agent.createConnection = () => connection;
  return { agent, close() { signal.removeEventListener('abort', abort); abort(); } };
}

/** Anonymous, bounded GET transport. No browser, cookie jar, retries or environment proxy discovery. */
export function createPublicFetcher(dependencies: NetworkDependencies = {}): PublicFetcher {
  const lookup = dependencies.lookup ?? (host => dnsLookup(host, { all: true, verbatim: true }));
  const request = dependencies.request ?? nativeRequest;
  const active = new Set<AbortController>();
  let stopped = false;

  async function resolveAddress(url: URL, signal: AbortSignal): Promise<Address> {
    const host = hostname(url);
    const family = isIP(host);
    const addresses = family ? [{ address: host, family }] : await abortable(lookup(host), signal);
    if (!addresses.length || addresses.length > 64) throw new SurfError('network_error');
    if (addresses.some(a => !publicAddress(a.address) || isIP(a.address) !== a.family)) throw new SurfError('unsafe_url');
    return addresses.find(a => a.family === 4) ?? addresses[0];
  }

  async function requestOnce(url: URL, address: Address, options: FetchOptions, headers: Record<string, string>, signal: AbortSignal): Promise<FetchResult> {
    const tunnel = options.proxyUrl ? await openTunnel(url, address, options.proxyUrl, signal, request, dependencies.tlsConnect ?? tls.connect) : undefined;
    const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
      if (signal.aborted) { callback(new SurfError('cancelled'), '', address.family); return; }
      if (lookupOptions.all) callback(null, [address]);
      else callback(null, address.address, address.family);
    };
    try {
      return await new Promise<FetchResult>((resolve, reject) => {
        const req = request(url, {
          method: 'GET', signal, agent: tunnel?.agent ?? false, lookup: pinnedLookup,
          family: address.family, maxHeaderSize: 16 * 1024,
          rejectUnauthorized: true, headers,
        }, response => {
          const status = response.statusCode ?? 0;
          const resultHeaders = responseHeaders(response);
          if (status < 200 || status >= 300) {
            response.destroy();
            resolve({ url: url.href, status, headers: resultHeaders, body: Buffer.alloc(0) });
            return;
          }
          readBody(response, options.maxBytes, signal).then(body => {
            resolve({ url: url.href, status, headers: resultHeaders, body });
          }, reject);
        });
        req.once('error', reject);
        req.end();
      });
    } finally { tunnel?.close(); }
  }

  return {
    async get(rawUrl, options) {
      if (stopped) throw new SurfError('stopped');
      if (!options || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120_000 ||
        !Number.isInteger(options.maxBytes) || options.maxBytes < 1 || options.maxBytes > 64 * 1024 * 1024 ||
        (options.signal !== undefined && !(options.signal instanceof AbortSignal))) throw new SurfError('invalid_input');
      const controller = new AbortController();
      active.add(controller);
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; controller.abort(); }, options.timeoutMs);
      const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
      try {
        if (signal.aborted) throw new SurfError('cancelled');
        let url = parsePublicUrl(rawUrl);
        const headers = requestHeaders(options.headers);
        for (let redirects = 0; ; redirects++) {
          if (signal.aborted) throw new SurfError('cancelled');
          const address = await resolveAddress(url, signal);
          if (signal.aborted) throw new SurfError('cancelled');
          const response = await requestOnce(url, address, options, headers, signal);
          if (signal.aborted) throw new SurfError('cancelled');
          if (!REDIRECTS.has(response.status)) return response;
          if (options.allowRedirects === false) throw new SurfError('http_error');
          if (redirects >= 5) throw new SurfError('too_many_redirects');
          if (!response.headers.location) throw new SurfError('http_error');
          let next: URL;
          try { next = new URL(response.headers.location, url); } catch { throw new SurfError('unsafe_url'); }
          url = parsePublicUrl(next.href);
          delete headers['x-subscription-token'];
        }
      } catch (error) {
        if (stopped) throw new SurfError('stopped');
        if (timedOut) throw new SurfError('timeout');
        if (signal.aborted) throw new SurfError('cancelled');
        if (error instanceof SurfError) throw error;
        throw new SurfError('network_error');
      } finally {
        clearTimeout(timer); active.delete(controller);
      }
    },
    dispose() { stopped = true; for (const controller of active) controller.abort(); active.clear(); },
  };
}
