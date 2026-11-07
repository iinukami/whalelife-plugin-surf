/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { OptionalService } from 'whalelife';
import { defaults, parseConfig, publicConfig, updateConfig } from '../src/config.ts';
import { SurfRuntime } from '../src/runtime.ts';
import { SurfError } from '../src/errors.ts';
import type { FetchOptions, FetchResult, PublicFetcher, SurfConfig, VisionService, OperationResult } from '../src/types.ts';

function ok<T>(value: OperationResult<T>): T { assert.equal(value.status, 'ok', JSON.stringify(value)); if (value.status !== 'ok') throw Error('Expected success'); return value.data; }
function error<T>(value: OperationResult<T>, code: string) { assert.equal(value.status, 'error'); if (value.status === 'error') assert.equal(value.error.code, code); }
function fake(callback?: (url: string, options: FetchOptions) => Promise<FetchResult>): PublicFetcher & { calls: { url: string; options: FetchOptions }[]; disposed: boolean } {
  return { calls: [], disposed: false,
    async get(url, options) {
      this.calls.push({ url, options });
      return callback ? callback(url, options) : { url, status: 200, headers: { 'content-type': 'text/html' },
        body: Buffer.from('<html><title>合成测试</title><article><p>' + '正文。'.repeat(2600) + '</p><img src="https://images.example.com/a.png" alt="测试图"></article></html>') };
    }, dispose() { this.disposed = true; } };
}
function setup(t: TestContext, changes: Partial<SurfConfig> = {}, fetcher = fake(), now?: () => number) {
  const runtime = new SurfRuntime({ ...defaults, ...changes }, fetcher, { signal: new AbortController().signal, transient: true, configValid: true, now });
  t.after(() => runtime.dispose()); return { runtime, fetcher };
}

test('配置校验、secret保留/显式清除和公开配置不回传凭据', () => {
  const config = parseConfig({ braveApiKey: 'synthetic-key-for-test', proxyUrl: 'http://test:test@127.0.0.1:1234', timeoutMs: 2000 });
  const view = JSON.stringify(publicConfig(config));
  assert.ok(!view.includes('synthetic-key')); assert.ok(!view.includes('127.0.0.1')); assert.equal(publicConfig(config).hasProxy, true);
  assert.equal(updateConfig({ braveApiKey: '', proxyUrl: '', resultsLimit: 3 }, config).braveApiKey, config.braveApiKey);
  assert.equal(updateConfig({ clearProxy: true, clearBraveApiKey: true }, config).braveApiKey, '');
  assert.throws(() => updateConfig({ clearProxy: true, proxyUrl: 'http://proxy.example' }, config), SurfError);
  for (const input of [{ timeoutMs: 0 }, { concurrency: 100 }, { proxyUrl: 'file:///tmp' }, { braveApiKey: 'test\r\nsecret' }, { searchProvider: 'unknown' }, { arbitrary: true }, null])
    assert.throws(() => parseConfig(input), (e: unknown) => e instanceof SurfError && e.code === 'config_invalid');
});
test('网页分段、会话隔离、过期和停用不会偷偷重新获取', async t => {
  let time = 0; const { runtime, fetcher } = setup(t, {}, fake(), () => time);
  const first = ok(await runtime.read({ sessionId: 'one', url: 'https://example.com/page' }));
  assert.equal(first.text.length, 6000); assert.equal(first.nextOffset, 6000); assert.equal(first.images.length, 1);
  assert.equal(first.imageToolAvailable, false); assert.equal(fetcher.calls.length, 1);
  const next = ok(await runtime.read({ sessionId: 'one', pageRef: first.pageRef, offset: first.nextOffset }));
  assert.ok(next.text.length > 0); assert.equal(next.nextOffset, undefined); assert.equal(fetcher.calls.length, 1);
  error(await runtime.read({ sessionId: 'two', pageRef: first.pageRef }), 'page_unavailable');
  error(await runtime.read({ sessionId: 'one', pageRef: first.pageRef, url: 'https://example.com' }), 'invalid_input');
  time = 600_001; error(await runtime.read({ sessionId: 'one', pageRef: first.pageRef }), 'page_unavailable');
  await runtime.dispose(); error(await runtime.read({ sessionId: 'one', url: 'https://example.com' }), 'stopped');
  assert.equal(fetcher.disposed, true); assert.equal(fetcher.calls.length, 1);
});
test('Brave只在显式选择并配置时调用，缺Key不回退，header不进入结果', async t => {
  const source = fake(async (url) => ({ url, status: 200, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ web: { results: [{ title: 'Test', url: 'https://example.com/result', description: 'Synthetic summary' }] } })) }));
  const { runtime } = setup(t, { searchProvider: 'brave', braveApiKey: 'synthetic-api-test' }, source);
  const data = ok(await runtime.search({ sessionId: 'one', query: '合成 测试', limit: 2 }));
  assert.equal(data.provider, 'brave'); assert.equal(data.results.length, 1);
  assert.equal(source.calls[0].options.allowRedirects, false); assert.equal(source.calls[0].options.headers?.['X-Subscription-Token'], 'synthetic-api-test');
  assert.ok(!JSON.stringify(data).includes('synthetic-api-test'));
  const missing = setup(t, { searchProvider: 'brave' }, fake());
  error(await missing.runtime.search({ sessionId: 'one', query: 'test' }), 'search_unconfigured'); assert.equal(missing.fetcher.calls.length, 0);
});
test('默认搜索不附Key，来源失败不影响给链接阅读', async t => {
  const source = fake(async (url): Promise<FetchResult> => url.includes('bing.com') ? { url, status: 429, headers: {}, body: Buffer.from('PRIVATE-REMOTE-ERROR') }
    : { url, status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('Synthetic public text') });
  const { runtime } = setup(t, {}, source);
  const search = await runtime.search({ sessionId: 'one', query: 'SENSITIVE QUERY' }); error(search, 'access_blocked');
  assert.ok(!JSON.stringify(search).includes('PRIVATE')); assert.ok(!JSON.stringify(search).includes('SENSITIVE'));
  assert.equal(source.calls[0].options.headers?.['X-Subscription-Token'], undefined);
  assert.equal(ok(await runtime.read({ sessionId: 'one', url: 'https://example.com' })).text, 'Synthetic public text');
});
test('按需获取真实图片、只用可信会话、视觉下线保留文字', async t => {
  const bytes = Buffer.from('synthetic-image-bytes'); let offered = 0; let seenSession = '';
  const source = fake(async url => url.endsWith('.png') ? { url, status: 200, headers: { 'content-type': 'image/png' }, body: bytes }
    : { url, status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<article>测试正文<img src="https://example.com/test.png" alt="不能当成已看图"></article>') });
  const { runtime } = setup(t, {}, source); const aborter = new AbortController();
  const vision: VisionService = { async offerMedia(input) { offered++; seenSession = input.sessionId; assert.deepEqual(Buffer.from(input.base64, 'base64'), bytes); return { mediaRef: 'vis_test', expiresAt: new Date(Date.now() + 60_000).toISOString(), info: {} }; }, async release() { return { released: true }; } };
  runtime.setVision({ service: vision, signal: aborter.signal, effect: setup => setup() });
  const page = ok(await runtime.read({ sessionId: 'trusted', url: 'https://example.com' }));
  assert.equal(offered, 0); assert.equal(source.calls.length, 1);
  error(await runtime.image({ sessionId: 'other', pageRef: page.pageRef, imageIndex: 0 }), 'page_unavailable');
  const media = ok(await runtime.image({ sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 }));
  assert.equal(media.state, 'offered'); assert.equal(media.nextTool, 'vision_view'); assert.equal(seenSession, 'trusted');
  assert.equal(offered, 1); assert.equal(source.calls.length, 2);
  assert.equal(ok(await runtime.image({ sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 })).mediaRef, media.mediaRef);
  assert.equal(offered, 1); assert.equal(source.calls.length, 2);
  aborter.abort(); error(await runtime.image({ sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 }), 'vision_unavailable');
  assert.equal(ok(await runtime.read({ sessionId: 'trusted', pageRef: page.pageRef })).imageToolAvailable, false);
});
test('视觉错误不泄露原文和媒体；取消后迟到offer释放，不假称已理解', async t => {
  const aborter = new AbortController(); let releaseCount = 0;
  const source = fake(async url => ({ url, status: 200, headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'text/html' },
    body: Buffer.from(url.endsWith('.png') ? 'IMAGE_SECRET' : '<article>read<img src="https://example.com/a.png"></article>') }));
  const { runtime } = setup(t, {}, source);
  const binding: OptionalService<VisionService> = { signal: new AbortController().signal, effect: fn => fn(), service: {
    async offerMedia() { aborter.abort(); return { mediaRef: 'vis_cancel', expiresAt: new Date().toISOString(), info: {} }; },
    async release() { releaseCount++; return { released: true }; },
  } };
  runtime.setVision(binding);
  const page = ok(await runtime.read({ sessionId: 'one', url: 'https://example.com' }));
  const result = await runtime.image({ sessionId: 'one', pageRef: page.pageRef, imageIndex: 0 }, { signal: aborter.signal });
  error(result, 'cancelled'); assert.equal(releaseCount, 1); assert.ok(!JSON.stringify(result).includes('IMAGE_SECRET'));
  binding.service.offerMedia = async () => { throw Error('PRIVATE-VISION-BYTES'); };
  const failed = await runtime.image({ sessionId: 'one', pageRef: page.pageRef, imageIndex: 0 });
  error(failed, 'image_unavailable'); assert.ok(!JSON.stringify(failed).includes('PRIVATE'));
});
test('并发满、过期缓存容量、invalid输入均不额外联网', async t => {
  let resolve!: (value: FetchResult) => void;
  const source = fake(() => new Promise(r => { resolve = r; }));
  const { runtime } = setup(t, { concurrency: 1 }, source);
  const first = runtime.read({ sessionId: 'one', url: 'https://example.com' });
  error(await runtime.read({ sessionId: 'one', url: 'https://example.com' }), 'busy');
  resolve({ url: 'https://example.com', status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok') }); await first;
  assert.equal(source.calls.length, 1);
  error(await runtime.search({ sessionId: '', query: 'query' }), 'session_required');
  error(await runtime.search({ sessionId: 'one', query: '' }), 'invalid_input');
  error(await runtime.read({ sessionId: 'one', url: 'https://example.com', offset: 1 }), 'invalid_input');
  assert.equal(source.calls.length, 1);
  const cached = setup(t);
  for (let i = 0; i < 8; i++) ok(await cached.runtime.read({ sessionId: 'one', url: 'https://example.com/' + i }));
  error(await cached.runtime.read({ sessionId: 'one', url: 'https://example.com/9' }), 'busy');
  assert.equal(cached.fetcher.calls.length, 8);
});
test('相同图片在途请求预占额度，完成后复用', async t => {
  let finish!: () => void; let offered = 0;
  const source = fake(async url => ({ url, status: 200, headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'text/html' },
    body: Buffer.from(url.endsWith('.png') ? 'synthetic' : '<article>page<img src="https://example.com/a.png"></article>') }));
  const { runtime } = setup(t, {}, source);
  runtime.setVision({ signal: new AbortController().signal, effect: fn => fn(), service: {
    async offerMedia() { offered++; await new Promise<void>(resolve => { finish = resolve; }); return { mediaRef: 'vis_same', expiresAt: new Date(Date.now() + 60000).toISOString(), info: {} }; },
    async release() { return { released: true }; },
  } });
  const page = ok(await runtime.read({ sessionId: 'one', url: 'https://example.com' }));
  const first = runtime.image({ sessionId: 'one', pageRef: page.pageRef, imageIndex: 0 });
  await new Promise(resolve => setImmediate(resolve));
  error(await runtime.image({ sessionId: 'one', pageRef: page.pageRef, imageIndex: 0 }), 'busy');
  assert.equal(source.calls.length, 2); assert.equal(offered, 1);
  finish(); const media = ok(await first);
  assert.equal(ok(await runtime.image({ sessionId: 'one', pageRef: page.pageRef, imageIndex: 0 })).mediaRef, media.mediaRef);
  assert.equal(source.calls.length, 2); assert.equal(offered, 1);
});
test('图片容量包含在途占位，不会并发越过32份上限', async t => {
  let count = 0; let finish!: () => void;
  const source = fake(async url => ({ url, status: 200, headers: { 'content-type': url.endsWith('.png') ? 'image/png' : 'text/html' },
    body: Buffer.from(url.endsWith('.png') ? 'synthetic' : '<article>page' + Array.from({ length: 32 }, (_, i) => '<img src="https://example.com/' + i + '.png">').join('') + '</article>') }));
  const { runtime } = setup(t, { concurrency: 8 }, source);
  runtime.setVision({ signal: new AbortController().signal, effect: fn => fn(), service: {
    async offerMedia() { count++; if (count === 32) await new Promise<void>(resolve => { finish = resolve; }); return { mediaRef: 'vis_' + count, expiresAt: new Date(Date.now() + 60000).toISOString(), info: {} }; },
    async release() { return { released: true }; },
  } });
  const page = ok(await runtime.read({ sessionId: 'one', url: 'https://example.com/a' }));
  const another = ok(await runtime.read({ sessionId: 'one', url: 'https://example.com/b' }));
  for (let i = 0; i < 31; i++) ok(await runtime.image({ sessionId: 'one', pageRef: page.pageRef, imageIndex: i }));
  const pending = runtime.image({ sessionId: 'one', pageRef: page.pageRef, imageIndex: 31 });
  await new Promise(resolve => setImmediate(resolve));
  error(await runtime.image({ sessionId: 'one', pageRef: another.pageRef, imageIndex: 0 }), 'busy');
  assert.equal(count, 32); assert.equal(source.calls.length, 34); finish(); ok(await pending);
});
test('分段保持非BMP字符完整，使用返回的nextOffset能无损继续', async t => {
  const text = 'x'.repeat(5999) + '鲸🐳尾';
  const source = fake(async url => ({ url, status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from(text) }));
  const { runtime } = setup(t, {}, source);
  const first = ok(await runtime.read({ sessionId: 'one', url: 'https://example.com' }));
  const second = ok(await runtime.read({ sessionId: 'one', pageRef: first.pageRef, offset: first.nextOffset }));
  assert.equal(first.text + second.text, text);
  error(await runtime.read({ sessionId: 'one', pageRef: first.pageRef, offset: 6001 }), 'invalid_input');
});
