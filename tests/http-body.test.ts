/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createServer, request, type ClientRequest, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readJsonBody } from '../src/http-body.ts';
import { SurfError } from '../src/errors.ts';

const events = ['data', 'end', 'error', 'aborted', 'close'] as const;
class Request extends EventEmitter {
  aborted = false;
  destroyed = false;
  readableEnded = false;
  paused = false;
  pause() { this.paused = true; return this; }
  incoming() { return this as unknown as IncomingMessage; }
}
function isCode(code: string) {
  return (error: unknown) => error instanceof SurfError && error.code === code;
}
function clean(req: Request, signal: AbortSignal) {
  for (const event of events) assert.equal(req.listenerCount(event), 0, `removed ${event} listener`);
  assert.equal(getEventListeners(signal, 'abort').length, 0);
}

test('JSON body reads split UTF-8 chunks, then clears its listeners and deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = new Request(), abort = new AbortController();
  const body = Buffer.from('{"text":"中文😀","active":true}');
  const result = readJsonBody(req.incoming(), abort.signal);
  for (const chunk of [body.subarray(0, 11), body.subarray(11, 13), body.subarray(13)]) req.emit('data', chunk);
  req.readableEnded = true;
  req.emit('end');
  assert.deepEqual(await result, { text: '中文😀', active: true });
  clean(req, abort.signal);
  t.mock.timers.tick(5001);
  assert.equal(req.paused, false);
});

test('body size limits count bytes and reject before buffering an oversized chunk', async () => {
  const req = new Request(), abort = new AbortController();
  const result = readJsonBody(req.incoming(), abort.signal, { maxBytes: 8 });
  req.emit('data', '{"');
  req.emit('data', '中文😀');
  await assert.rejects(result, isCode('too_large'));
  assert.equal(req.paused, true);
  clean(req, abort.signal);
  req.emit('data', Buffer.alloc(100_000));
  req.emit('end');
  req.emit('close');
});

test('exact size JSON body succeeds; empty and malformed JSON remain safe errors', async () => {
  for (const body of ['{"n":1}', '', '{"secret":"private input"']) {
    const req = new Request(), abort = new AbortController();
    const result = readJsonBody(req.incoming(), abort.signal, { maxBytes: Math.max(1, Buffer.byteLength(body)) });
    req.emit('data', Buffer.from(body)); req.emit('end');
    if (body === '{"n":1}') assert.deepEqual(await result, { n: 1 });
    else await assert.rejects(result, error => isCode('invalid_input')(error) && !String(error).includes('private'));
    clean(req, abort.signal);
  }
});

test('invalid UTF-8 is rejected instead of silently replacing JSON string bytes', async () => {
  const req = new Request(), abort = new AbortController();
  const result = readJsonBody(req.incoming(), abort.signal);
  req.emit('data', Buffer.from([0x22, 0xFF, 0x22])); req.emit('end');
  await assert.rejects(result, isCode('invalid_input'));
  clean(req, abort.signal);
});

test('already cancelled requests do not install listeners or wait for body data', async () => {
  const req = new Request(), abort = new AbortController(); abort.abort('private reason');
  await assert.rejects(readJsonBody(req.incoming(), abort.signal), error => isCode('cancelled')(error) && !String(error).includes('private'));
  assert.equal(req.paused, true);
  clean(req, abort.signal);
});

test('signal cancellation wins over late data and end without touching unrelated listeners', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const req = new Request(), abort = new AbortController();
  const observer = () => {};
  req.on('close', observer);
  const result = readJsonBody(req.incoming(), abort.signal);
  req.emit('data', Buffer.from('{"partial":'));
  abort.abort('private cancelled input');
  req.emit('data', Buffer.from('true}')); req.emit('end');
  await assert.rejects(result, isCode('cancelled'));
  assert.equal(req.paused, true);
  assert.deepEqual(req.listeners('close'), [observer]);
  req.removeListener('close', observer);
  clean(req, abort.signal);
  t.mock.timers.tick(5001);
});

test('slow and never-ending request bodies have a total deadline, not an idle-only deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const slow of [false, true]) {
    const req = new Request(), abort = new AbortController();
    const result = readJsonBody(req.incoming(), abort.signal, { timeoutMs: 100 });
    if (slow) { req.emit('data', Buffer.from('{')); t.mock.timers.tick(60); req.emit('data', Buffer.from('"')); t.mock.timers.tick(40); }
    else t.mock.timers.tick(100);
    await assert.rejects(result, isCode('timeout'));
    assert.equal(req.paused, true);
    clean(req, abort.signal);
    req.emit('end');
  }
});

test('request error, abort, and premature close produce fixed errors and clean up', async () => {
  for (const [event, code] of [['error', 'invalid_input'], ['aborted', 'cancelled'], ['close', 'cancelled']] as const) {
    const req = new Request(), abort = new AbortController();
    const result = readJsonBody(req.incoming(), abort.signal);
    req.emit('data', Buffer.from('{'));
    req.emit(event, new Error('private upstream details'));
    await assert.rejects(result, value => isCode(code)(value) && !String(value).includes('private'));
    clean(req, abort.signal);
    assert.equal(req.destroyed, false);
  }
});

test('late cancellation after a valid end cannot change successful result', async () => {
  const req = new Request(), abort = new AbortController();
  const result = readJsonBody(req.incoming(), abort.signal);
  req.emit('data', 'null'); req.emit('end'); abort.abort(); req.emit('close');
  assert.equal(await result, null);
  clean(req, abort.signal);
});

test('invalid reader options fail immediately with fixed input errors', async () => {
  for (const options of [{ maxBytes: 0 }, { maxBytes: 1.5 }, { timeoutMs: 0 }, { timeoutMs: Number.POSITIVE_INFINITY }]) {
    const req = new Request(), abort = new AbortController();
    await assert.rejects(readJsonBody(req.incoming(), abort.signal, options), isCode('invalid_input'));
    clean(req, abort.signal);
  }
});

for (const mode of ['client-disconnect', 'cancel-then-disconnect'] as const) {
  test(`real HTTP ${mode} has no unhandled late error and leaves other requests usable`, { timeout: 5000 }, async t => {
    const controller = new AbortController();
    const clients = new Set<ClientRequest>();
    let start!: (req: IncomingMessage) => void;
    const started = new Promise<IncomingMessage>(resolve => { start = resolve; });
    let finish!: (error: unknown) => void;
    const finished = new Promise<unknown>(resolve => { finish = resolve; });
    let closed!: () => void;
    const connectionClosed = new Promise<void>(resolve => { closed = resolve; });
    const server = createServer((req, res) => {
      if (req.url === '/health') { res.end('ok'); return; }
      // Do not add an error observer: it would mask an unhandled-error regression.
      req.socket.once('close', closed);
      void readJsonBody(req, controller.signal, { timeoutMs: 1000 }).then(
        () => finish(new Error('incomplete body unexpectedly succeeded')),
        error => { finish(error); if (!res.destroyed) { res.statusCode = 400; res.end('invalid request'); } },
      );
      start(req);
    });
    // Register owned-resource cleanup before creating the listening socket or clients.
    t.after(async () => {
      controller.abort();
      for (const client of clients) client.destroy();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    const port = (server.address() as AddressInfo).port;
    const client = request({ host: '127.0.0.1', port, method: 'POST', path: '/config', agent: false,
      headers: { 'content-type': 'application/json', 'content-length': '1000' } });
    clients.add(client);
    client.on('error', () => {}); // This client's explicit disconnect is expected.
    client.on('response', response => response.resume());
    client.write('{"partial":');
    const req = await started;
    if (mode === 'cancel-then-disconnect') { controller.abort('synthetic cancellation'); await finished; }
    client.destroy();
    const outcome = await finished;
    await connectionClosed;
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(isCode('cancelled')(outcome));
    assert.equal(req.listenerCount('error'), 0);
    assert.equal(req.listenerCount('data'), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    const health = await new Promise<string>((resolve, reject) => {
      const other = request({ host: '127.0.0.1', port, path: '/health', agent: false }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        response.on('error', reject);
      });
      clients.add(other);
      other.on('error', reject);
      other.end();
    });
    assert.equal(health, 'ok');
  });
}
