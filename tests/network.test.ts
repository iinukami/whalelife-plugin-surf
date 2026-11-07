/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, type Socket } from 'node:net';
import tls from 'node:tls';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';
import { createPublicFetcher, parsePublicUrl, type NetworkDependencies } from '../src/network.ts';
import { SurfError } from '../src/errors.ts';
import type { FetchOptions, PublicFetcher } from '../src/types.ts';

const PUBLIC = '93.184.216.34';
const options: FetchOptions = { timeoutMs: 2000, maxBytes: 1024 * 1024 };

async function server(t: TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const instance = http.createServer(handler);
  const sockets = new Set<Socket>();
  instance.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    if (instance.listening) await new Promise<void>((resolve, reject) => instance.close(error => error ? reject(error) : resolve()));
  });
  await new Promise<void>(resolve => instance.listen(0, '127.0.0.1', resolve));
  const address = instance.address();
  assert(address && typeof address !== 'string');
  return { instance, port: address.port };
}

/** Only the test transport connects to loopback, after exercising production destination validation and lookup pinning. */
function localFetcher(t: TestContext, port: number, hooks: {
  lookup?: NonNullable<NetworkDependencies['lookup']>;
  pinned?: (address: string) => void;
  requested?: (url: URL) => void;
} = {}): PublicFetcher {
  const fetcher = createPublicFetcher({
    lookup: hooks.lookup ?? (async () => [{ address: PUBLIC, family: 4 }]),
    request(url, requestOptions, callback) {
      hooks.requested?.(url);
      if (requestOptions.method === 'CONNECT' || (requestOptions.agent && typeof requestOptions.agent === 'object')) {
        return http.request(url, requestOptions, callback);
      }
      assert.equal(requestOptions.rejectUnauthorized, true);
      const mapped = new URL(url);
      mapped.port = String(port);
      return http.request(mapped, {
        ...requestOptions,
        headers: { ...requestOptions.headers, host: url.host },
        lookup(host, lookupOptions, callback) {
          assert(requestOptions.lookup);
          requestOptions.lookup(host, lookupOptions, (error, address) => {
            if (error) { callback(error, '', 4); return; }
            const pinned = typeof address === 'string' ? address : address[0].address;
            hooks.pinned?.(pinned);
            if (lookupOptions.all) callback(null, [{ address: '127.0.0.1', family: 4 }]);
            else callback(null, '127.0.0.1', 4);
          });
        },
      }, callback);
    },
  });
  t.after(() => fetcher.dispose());
  return fetcher;
}

function code(expected: string) {
  return (error: unknown) => error instanceof SurfError && error.code === expected;
}

test('public URL policy rejects credentials, local aliases, encoded IPv4 and special IPv6 ranges', () => {
  const denied = [
    'file:///etc/passwd', 'data:text/plain,hello', 'ftp://example.org/a',
    'http://user:password@example.org/', 'https://@example.org/',
    'http://localhost/', 'http://service.local./', 'https://metadata.google.internal/',
    'http://printer/', 'http://machine.home.arpa/', 'http://service.lan/',
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/',
    'http://10.0.0.1/', 'http://172.16.0.1/', 'http://192.168.0.1/', 'http://169.254.169.254/',
    'http://100.64.0.1/', 'http://0.0.0.0/', 'http://224.0.0.1/', 'http://192.0.2.1/',
    'http://[::1]/', 'http://[fc00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:8.8.8.8]/', 'http://[64:ff9b::808:808]/', 'http://[2001:db8::1]/',
    'http://[3fff::1]/', 'http://[4000::1]/', 'http://[2002:7f00:1::]/',
    ' https://example.org/', 'https://example.org/\nvalue', 'https://example.org\\@localhost/',
  ];
  for (const url of denied) assert.throws(() => parsePublicUrl(url), code('unsafe_url'), url);
  assert.equal(parsePublicUrl('https://example.org/path?q=one#fragment').href, 'https://example.org/path?q=one');
  assert.equal(parsePublicUrl('https://8.8.8.8/').hostname, '8.8.8.8');
  assert.equal(parsePublicUrl('https://[2606:4700:4700::1111]/').protocol, 'https:');
});

test('mixed DNS answers are rejected before connecting, including mapped and reserved addresses', async () => {
  for (const denied of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::ffff:8.8.8.8', '2001:db8::1']) {
    let connected = false;
    const fetcher = createPublicFetcher({
      lookup: async () => [{ address: PUBLIC, family: 4 }, { address: denied, family: denied.includes(':') ? 6 : 4 }],
      request() { connected = true; throw Error('must not connect'); },
    });
    await assert.rejects(fetcher.get('http://public.example.org/', options), code('unsafe_url'));
    fetcher.dispose();
    assert.equal(connected, false);
  }
});

test('GET pins a validated address without a second DNS lookup and does not retain cookies', async t => {
  let resolutions = 0;
  const pin: string[] = [];
  const origin = await server(t, (req, res) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.headers.host, 'public.example.org');
    assert.equal(req.headers.cookie, undefined);
    res.setHeader('Set-Cookie', 'private-cookie=synthetic-test');
    res.setHeader('Content-Type', 'text/plain');
    res.end('public text');
  });
  const fetcher = localFetcher(t, origin.port, {
    lookup: async () => { resolutions++; return [{ address: resolutions === 1 ? PUBLIC : '127.0.0.1', family: 4 }]; },
    pinned: value => pin.push(value),
  });
  const result = await fetcher.get('http://public.example.org/', options);
  assert.equal(result.body.toString(), 'public text');
  assert.equal(result.headers['set-cookie'], undefined);
  assert.equal(resolutions, 1);
  assert.deepEqual(pin, [PUBLIC]);
});

test('redirects revalidate DNS even for the same host and block literal private targets', async t => {
  let resolutions = 0;
  let requests = 0;
  const origin = await server(t, (req, res) => {
    requests++;
    res.writeHead(302, { Location: req.url === '/literal' ? 'http://127.0.0.1/' : '/next' });
    res.end();
  });
  const fetcher = localFetcher(t, origin.port, { lookup: async () => [{ address: ++resolutions === 1 ? PUBLIC : '127.0.0.1', family: 4 }] });
  await assert.rejects(fetcher.get('http://public.example.org/', options), code('unsafe_url'));
  assert.equal(requests, 1);
  resolutions = 0;
  await assert.rejects(fetcher.get('http://public.example.org/literal', options), code('unsafe_url'));
  assert.equal(requests, 2);
});

test('redirect limits and disabled redirects fail without replaying the request', async t => {
  let requests = 0;
  const origin = await server(t, (_req, res) => { requests++; res.writeHead(302, { Location: '/again' }); res.end(); });
  const fetcher = localFetcher(t, origin.port);
  await assert.rejects(fetcher.get('http://public.example.org/', options), code('too_many_redirects'));
  assert.equal(requests, 6);
  requests = 0;
  await assert.rejects(fetcher.get('http://public.example.org/', { ...options, allowRedirects: false }), code('http_error'));
  assert.equal(requests, 1);
});

test('subscription credentials never follow a redirect and no cookie is replayed', async t => {
  const received: (string | string[] | undefined)[] = [];
  const origin = await server(t, (req, res) => {
    received.push(req.headers['x-subscription-token']);
    assert.equal(req.headers.cookie, undefined);
    if (req.url === '/') {
      res.writeHead(302, { Location: 'http://next.example.org/result', 'Set-Cookie': 'auth=synthetic' });
      res.end();
    } else res.end('done');
  });
  const fetcher = localFetcher(t, origin.port);
  const result = await fetcher.get('http://public.example.org/', { ...options, headers: { 'X-Subscription-Token': 'synthetic-api-token' } });
  assert.deepEqual(received, ['synthetic-api-token', undefined]);
  assert.equal(result.url, 'http://next.example.org/result');
});

test('anonymous GET rejects injected Cookie, authorization, Host and malformed headers', async () => {
  const fetcher = createPublicFetcher();
  const deniedHeaders: Record<string, string>[] = [
    { Cookie: 'synthetic' }, { Authorization: 'synthetic' }, { Host: 'localhost' },
    { 'Proxy-Authorization': 'synthetic' }, { Accept: 'text/html\r\nInjected: yes' },
  ];
  for (const headers of deniedHeaders) await assert.rejects(fetcher.get('http://public.example.org/', { ...options, headers }), code('invalid_input'));
  fetcher.dispose();
});

test('gzip, deflate and brotli are decoded with both wire and decoded byte limits', async t => {
  const payload = Buffer.from('公开网页内容。'.repeat(50));
  const codecs = { gzip: gzipSync, deflate: deflateSync, br: brotliCompressSync };
  const origin = await server(t, (req, res) => {
    const name = req.url!.slice(1) as keyof typeof codecs;
    res.setHeader('Content-Encoding', name);
    res.end(codecs[name](payload));
  });
  const fetcher = localFetcher(t, origin.port);
  for (const name of Object.keys(codecs)) {
    const result = await fetcher.get(`http://public.example.org/${name}`, options);
    assert.deepEqual(result.body, payload);
    await assert.rejects(fetcher.get(`http://public.example.org/${name}`, { ...options, maxBytes: 100 }), code('too_large'));
  }
});

test('oversized content-length, chunked bodies, unsupported encodings and malformed compression are bounded', async t => {
  const origin = await server(t, (req, res) => {
    if (req.url === '/length') { res.setHeader('Content-Length', 5000); res.end('x'.repeat(5000)); }
    else if (req.url === '/encoding') { res.setHeader('Content-Encoding', 'unknown'); res.end('x'); }
    else if (req.url === '/corrupt') { res.setHeader('Content-Encoding', 'gzip'); res.end('not-gzip'); }
    else { res.write('x'.repeat(32)); res.end('y'.repeat(32)); }
  });
  const fetcher = localFetcher(t, origin.port);
  await assert.rejects(fetcher.get('http://public.example.org/length', { ...options, maxBytes: 50 }), code('too_large'));
  await assert.rejects(fetcher.get('http://public.example.org/chunk', { ...options, maxBytes: 50 }), code('too_large'));
  await assert.rejects(fetcher.get('http://public.example.org/encoding', options), code('unsupported_content'));
  await assert.rejects(fetcher.get('http://public.example.org/corrupt', options), code('network_error'));
});

test('HTTP denial returns only status and allowed headers without consuming a large error body', async t => {
  const origin = await server(t, (_req, res) => {
    res.writeHead(429, { 'Content-Length': 9999999, 'Retry-After': '30', 'Set-Cookie': 'synthetic' });
    res.flushHeaders();
  });
  const fetcher = localFetcher(t, origin.port);
  const result = await fetcher.get('http://public.example.org/', { ...options, maxBytes: 50 });
  assert.equal(result.status, 429);
  assert.equal(result.body.length, 0);
  assert.equal(result.headers['retry-after'], '30');
  assert.equal(result.headers['set-cookie'], undefined);
});

test('timeouts include a stuck DNS lookup and late resolution cannot open a connection', async () => {
  let resolveDns!: (value: { address: string; family: number }[]) => void;
  let requests = 0;
  const fetcher = createPublicFetcher({
    lookup: () => new Promise(resolve => { resolveDns = resolve; }),
    request() { requests++; throw Error('unexpected'); },
  });
  await assert.rejects(fetcher.get('http://public.example.org/', { ...options, timeoutMs: 25 }), code('timeout'));
  resolveDns([{ address: PUBLIC, family: 4 }]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 0);
  fetcher.dispose();
});

test('body timeout and cancellation close active requests without leaking external reasons', async t => {
  const origin = await server(t, (_req, res) => { res.writeHead(200); res.write('partial'); });
  const fetcher = localFetcher(t, origin.port);
  await assert.rejects(fetcher.get('http://public.example.org/', { ...options, timeoutMs: 40 }), code('timeout'));
  const controller = new AbortController();
  const pending = fetcher.get('http://public.example.org/', { ...options, signal: controller.signal });
  const timer = setTimeout(() => controller.abort('synthetic-secret-reason'), 30);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, error => code('cancelled')(error) && !String(error).includes('synthetic-secret-reason'));
  await assert.rejects(fetcher.get('http://public.example.org/', { ...options, signal: controller.signal }), code('cancelled'));
});

test('dispose cancels pending DNS and bodies and rejects future work', async t => {
  let requests = 0;
  const origin = await server(t, (_req, res) => { requests++; res.write('partial'); });
  const fetcher = localFetcher(t, origin.port);
  const pending = fetcher.get('http://public.example.org/', options);
  const timer = setTimeout(() => fetcher.dispose(), 30);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, code('stopped'));
  assert.equal(requests, 1);
  await assert.rejects(fetcher.get('http://public.example.org/', options), code('stopped'));
  const dnsFetcher = createPublicFetcher({ lookup: () => new Promise(() => {}) });
  const dnsPending = dnsFetcher.get('http://public.example.org/', options);
  dnsFetcher.dispose();
  await assert.rejects(dnsPending, code('stopped'));
});

test('CONNECT proxy receives the validated IP and proxy credentials never reach the origin', async t => {
  let connectTarget = '';
  let proxyAuth: string | undefined;
  const origin = await server(t, (req, res) => {
    assert.equal(req.headers.host, 'public.example.org');
    assert.equal(req.headers['proxy-authorization'], undefined);
    res.end('through proxy');
  });
  const proxy = await server(t, (_req, res) => { res.writeHead(405); res.end(); });
  const upstream = new Set<Socket>();
  t.after(() => { for (const socket of upstream) socket.destroy(); });
  proxy.instance.on('connect', (req, client, head) => {
    connectTarget = req.url ?? '';
    proxyAuth = req.headers['proxy-authorization'];
    assert.equal(head.length, 0);
    const target = connect(origin.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.pipe(target); target.pipe(client);
    });
    upstream.add(target);
    target.on('close', () => upstream.delete(target));
    target.on('error', () => client.destroy());
    client.on('error', () => target.destroy());
    client.on('close', () => target.destroy());
  });
  const fetcher = createPublicFetcher({ lookup: async () => [{ address: PUBLIC, family: 4 }] });
  t.after(() => fetcher.dispose());
  const result = await fetcher.get('http://public.example.org/', {
    ...options, proxyUrl: `http://fictional-user:fictional-password@127.0.0.1:${proxy.port}`,
  });
  assert.equal(result.body.toString(), 'through proxy');
  assert.equal(connectTarget, `${PUBLIC}:80`);
  assert.equal(proxyAuth, `Basic ${Buffer.from('fictional-user:fictional-password').toString('base64')}`);
});

test('proxy rejects unsafe destination before CONNECT and proxy failures expose no credentials', async t => {
  let connections = 0;
  const proxy = await server(t, (_req, res) => { res.writeHead(407); res.end(); });
  proxy.instance.on('connect', (_req, socket) => { connections++; socket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); });
  const fetcher = createPublicFetcher({ lookup: async host => [{ address: host.startsWith('private') ? '10.0.0.1' : PUBLIC, family: 4 }] });
  t.after(() => fetcher.dispose());
  const opts = { ...options, proxyUrl: `http://fictional-user:fictional-password@127.0.0.1:${proxy.port}` };
  await assert.rejects(fetcher.get('http://private.example.org/', opts), code('unsafe_url'));
  assert.equal(connections, 0);
  await assert.rejects(fetcher.get('http://public.example.org/', opts), error => code('network_error')(error) && !String(error).includes('fictional'));
  assert.equal(connections, 1);
});

test('CONNECT TLS uses the original hostname and enforces certificate identity verification', async t => {
  const proxy = await server(t, (_req, res) => res.end());
  proxy.instance.on('connect', (_req, socket) => socket.write('HTTP/1.1 200 Connection Established\r\n\r\n'));
  const checked: string[] = [];
  const fetcher = createPublicFetcher({
    lookup: async () => [{ address: PUBLIC, family: 4 }],
    tlsConnect: ((parameters: tls.ConnectionOptions) => {
      assert.equal(parameters.rejectUnauthorized, true);
      assert(parameters.checkServerIdentity);
      const peer = { subjectaltname: 'DNS:public.example.org', subject: { CN: 'public.example.org' } } as tls.PeerCertificate;
      const identityError = parameters.checkServerIdentity('proxy-host-must-not-be-used', peer);
      if (parameters.servername === 'public.example.org') assert.equal(identityError, undefined);
      else assert(identityError instanceof Error);
      checked.push(parameters.servername ?? '');
      throw Error('synthetic handshake failure after checking TLS parameters');
    }) as typeof tls.connect,
  });
  t.after(() => fetcher.dispose());
  for (const host of ['public.example.org', 'wrong.example.org']) {
    await assert.rejects(fetcher.get(`https://${host}/`, { ...options, proxyUrl: `http://127.0.0.1:${proxy.port}` }), code('network_error'));
  }
  assert.deepEqual(checked, ['public.example.org', 'wrong.example.org']);
});

test('HTTPS through CONNECT does not silently downgrade to plaintext', async t => {
  let originRequests = 0;
  const origin = await server(t, (_req, res) => { originRequests++; res.end('must not be read as HTTPS'); });
  const proxy = await server(t, (_req, res) => res.end());
  const upstream = new Set<Socket>();
  t.after(() => { for (const socket of upstream) socket.destroy(); });
  proxy.instance.on('connect', (_req, client) => {
    const target = connect(origin.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      client.pipe(target); target.pipe(client);
    });
    upstream.add(target);
    target.on('error', () => client.destroy());
    target.on('close', () => upstream.delete(target));
    client.on('error', () => target.destroy());
    client.on('close', () => target.destroy());
  });
  const fetcher = createPublicFetcher({ lookup: async () => [{ address: PUBLIC, family: 4 }] });
  t.after(() => fetcher.dispose());
  await assert.rejects(fetcher.get('https://public.example.org/', { ...options, proxyUrl: `http://127.0.0.1:${proxy.port}` }), code('network_error'));
  assert.equal(originRequests, 0);
  // The proxy's own HTTPS connection also retains normal TLS validation.
  await assert.rejects(fetcher.get('http://public.example.org/', { ...options, proxyUrl: `https://127.0.0.1:${proxy.port}` }), code('network_error'));
});

test('proxy connection waiting and tunneled bodies honor cancellation and disposal', async t => {
  const hangingProxy = await server(t, (_req, res) => res.end());
  hangingProxy.instance.on('connect', () => {});
  const fetcher = createPublicFetcher({ lookup: async () => [{ address: PUBLIC, family: 4 }] });
  t.after(() => fetcher.dispose());
  await assert.rejects(fetcher.get('http://public.example.org/', { ...options, timeoutMs: 35, proxyUrl: `http://127.0.0.1:${hangingProxy.port}` }), code('timeout'));
  const proxy = await server(t, (_req, res) => res.end());
  proxy.instance.on('connect', (_req, socket) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    socket.once('data', () => socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n'));
  });
  const pending = fetcher.get('http://public.example.org/', { ...options, proxyUrl: `http://127.0.0.1:${proxy.port}` });
  const timer = setTimeout(() => fetcher.dispose(), 35);
  t.after(() => clearTimeout(timer));
  await assert.rejects(pending, code('stopped'));
});

test('invalid options and raw DNS/transport errors produce fixed safe failures', async () => {
  const fetcher = createPublicFetcher({ lookup: async () => { throw Error('synthetic-credential-and-original-query'); } });
  for (const change of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxBytes: -1 }, { maxBytes: 100 * 1024 * 1024 }]) {
    await assert.rejects(fetcher.get('http://public.example.org/', { ...options, ...change }), code('invalid_input'));
  }
  await assert.rejects(fetcher.get('http://public.example.org/', options), error => code('network_error')(error) && !String(error).includes('synthetic'));
  fetcher.dispose();
});
