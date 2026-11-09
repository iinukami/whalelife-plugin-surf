/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import type { OptionalService } from 'whalelife';
import { defaults } from '../src/config.ts';
import { SurfError } from '../src/errors.ts';
import { SurfRuntime } from '../src/runtime.ts';
import type { FetchOptions, FetchResult, GalleryService, OperationResult, PublicFetcher, SurfConfig, VisionService } from '../src/types.ts';

const original = Buffer.from('GIF89a\x01\x00\x01\x00synthetic-original-frames', 'binary');
const pageHtml = '<article>合成网页' + Array.from({ length: 32 }, (_, i) => `<img src="https://images.example.com/${i}.gif" alt="synthetic image ${i}">`).join('') + '</article>';
function response(url: string): FetchResult {
  return { url, status: 200, headers: { 'content-type': url.endsWith('.gif') ? 'image/gif' : 'text/html' }, body: url.endsWith('.gif') ? original : Buffer.from(pageHtml) };
}
function success<T>(result: OperationResult<T>): T {
  assert.equal(result.status, 'ok', JSON.stringify(result));
  if (result.status !== 'ok') throw Error('Expected success');
  return result.data;
}
function failed<T>(result: OperationResult<T>, code: string) {
  assert.equal(result.status, 'error');
  if (result.status === 'error') assert.equal(result.error.code, code);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SYNTHETIC-SECRET/);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function setup(t: TestContext, options: {
  config?: Partial<SurfConfig>; now?: () => number;
  fetch?: (url: string, options: FetchOptions) => Promise<FetchResult>;
} = {}) {
  const calls: { url: string; options: FetchOptions }[] = [];
  let disposed = false;
  const fetcher: PublicFetcher = {
    async get(url, request) { calls.push({ url, options: request }); return options.fetch ? options.fetch(url, request) : response(url); },
    dispose() { disposed = true; },
  };
  const runtime = new SurfRuntime({ ...defaults, ...options.config }, fetcher, {
    signal: new AbortController().signal, transient: true, configValid: true, now: options.now,
  });
  t.after(() => runtime.dispose());
  return { runtime, calls, disposed: () => disposed };
}
function gallery(offerMedia: GalleryService['offerMedia'] = async () => ({ mediaRef: 'media_synthetic', expiresInSeconds: 86400 })) {
  const aborter = new AbortController();
  const binding: OptionalService<GalleryService> = { service: { offerMedia }, signal: aborter.signal, effect: effect => effect() };
  return { binding, aborter };
}
function vision(): OptionalService<VisionService> {
  return { signal: new AbortController().signal, effect: effect => effect(), service: {
    async offerMedia() { return { mediaRef: 'vis_synthetic', expiresAt: new Date(Date.now() + 60000).toISOString(), info: {} }; },
    async release() { return { released: true }; },
  } };
}
async function read(runtime: SurfRuntime, sessionId = 'trusted', url = 'https://example.com/page') {
  return success(await runtime.read({ sessionId, url }));
}

test('图库缺失或停用只关闭收藏准备，视觉和文字保持独立', async t => {
  const { runtime, calls } = setup(t);
  runtime.setVision(vision());
  const page = await read(runtime);
  assert.equal(page.imageToolAvailable, true); assert.equal(page.collectionToolAvailable, false);
  assert.equal(runtime.status().version, '1.0.0'); assert.equal(runtime.status().gallery, false);
  const input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  failed(await runtime.prepareCollection(input), 'gallery_unavailable'); assert.equal(calls.length, 1);
  assert.equal(success(await runtime.image(input)).nextTool, 'vision_view');
  const connected = gallery(); runtime.setGallery(connected.binding); connected.aborter.abort();
  failed(await runtime.prepareCollection(input), 'gallery_unavailable');
  assert.equal(runtime.status().ready, true); assert.equal(runtime.status().vision, true);
  assert.equal(success(await runtime.read({ sessionId: 'trusted', pageRef: page.pageRef })).collectionToolAvailable, false);
  assert.equal(calls.length, 2);
});

test('无视觉时仍能交出当前会话的原始GIF，返回图库专用引用且不自动收藏', async t => {
  const { runtime, calls } = setup(t, { now: () => 1000, config: { maxImageBytes: 8000000, proxyUrl: 'http://proxy.example.com:8080' } });
  let offered = 0;
  const connected = gallery(async (input, options) => {
    offered++; assert.deepEqual(input, { sessionId: 'trusted', base64: original.toString('base64'), source: 'surf' });
    assert.equal(options?.signal?.aborted, false);
    return { mediaRef: 'media_original', expiresInSeconds: 86400 };
  });
  runtime.setGallery(connected.binding);
  const page = await read(runtime);
  assert.equal(page.imageToolAvailable, false); assert.equal(page.collectionToolAvailable, true); assert.equal(offered, 0);
  const input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  failed(await runtime.image(input), 'vision_unavailable');
  const result = success(await runtime.prepareCollection(input));
  assert.deepEqual(result, { mediaRef: 'media_original', expiresAt: new Date(86401000).toISOString(), nextTool: 'gallery_collect', state: 'offered' });
  assert.equal(offered, 1); assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://images.example.com/0.gif');
  assert.equal(calls[1].options.maxBytes, 8000000); assert.equal(calls[1].options.timeoutMs, defaults.timeoutMs);
  assert.equal(calls[1].options.proxyUrl, 'http://proxy.example.com:8080');
  assert.deepEqual(calls[1].options.headers, { Accept: 'image/png,image/jpeg,image/webp,image/gif' });
  assert.doesNotMatch(JSON.stringify(result), /base64|GIF89a|images\.example|trusted/);
});

test('普通读取和看图不调用图库，两个提供者的引用和缓存独立', async t => {
  const { runtime, calls } = setup(t); let offers = 0;
  runtime.setVision(vision()); runtime.setGallery(gallery(async () => { offers++; return { mediaRef: 'media_gallery_only', expiresInSeconds: 60 }; }).binding);
  const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  assert.equal(success(await runtime.image(input)).mediaRef, 'vis_synthetic'); assert.equal(offers, 0);
  assert.equal(success(await runtime.prepareCollection(input)).mediaRef, 'media_gallery_only'); assert.equal(offers, 1);
  assert.equal(success(await runtime.image(input)).mediaRef, 'vis_synthetic'); assert.equal(offers, 1); assert.equal(calls.length, 3);
});

test('会话、页面引用和图片索引先校验，失效引用不重新下载', async t => {
  let now = 0; const { runtime, calls } = setup(t, { now: () => now }); let offers = 0;
  runtime.setGallery(gallery(async () => { offers++; return { mediaRef: 'media_test', expiresInSeconds: 60 }; }).binding);
  const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  failed(await runtime.prepareCollection({ ...input, sessionId: '' }), 'session_required');
  failed(await runtime.prepareCollection({ ...input, sessionId: 'another' }), 'page_unavailable');
  failed(await runtime.prepareCollection({ ...input, pageRef: 'page_missing' }), 'page_unavailable');
  for (const imageIndex of [-1, 32, 0.5, NaN]) failed(await runtime.prepareCollection({ ...input, imageIndex }), 'invalid_input');
  now = defaults.referenceTtlSeconds * 1000;
  failed(await runtime.prepareCollection(input), 'page_unavailable'); assert.equal(offers, 0); assert.equal(calls.length, 1);
});

test('已完成准备复用，提供方TTL过期和绑定更换使缓存失效', async t => {
  let now = 0, count = 0; const { runtime, calls } = setup(t, { now: () => now });
  const connected = gallery(async () => ({ mediaRef: 'media_' + ++count, expiresInSeconds: 1 })); runtime.setGallery(connected.binding);
  const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  const first = success(await runtime.prepareCollection(input)); runtime.setGallery(connected.binding);
  assert.deepEqual(success(await runtime.prepareCollection(input)), first); assert.equal(calls.length, 2);
  now = 1000; assert.equal(success(await runtime.prepareCollection(input)).mediaRef, 'media_2'); assert.equal(count, 2);
  runtime.setGallery(gallery(async () => ({ mediaRef: 'media_new_binding', expiresInSeconds: 60 })).binding);
  assert.equal(success(await runtime.prepareCollection(input)).mediaRef, 'media_new_binding'); assert.equal(calls.length, 4);
  runtime.setGallery(undefined); assert.equal(runtime.status().gallery, false);
  failed(await runtime.prepareCollection(input), 'gallery_unavailable'); assert.equal(calls.length, 4);
});

test('页面在下载或交入图库时过期，不返回可用引用或缓存迟到结果', async t => {
  for (const stage of ['fetch', 'offer']) await t.test(stage, async sub => {
    let now = 0, offers = 0;
    const { runtime } = setup(sub, { now: () => now, fetch: async url => {
      if (url.endsWith('.gif') && stage === 'fetch') now = 600000;
      return response(url);
    } });
    runtime.setGallery(gallery(async () => { offers++; now = 600000; return { mediaRef: 'media_late', expiresInSeconds: 86400 }; }).binding);
    const page = await read(runtime);
    failed(await runtime.prepareCollection({ sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 }), 'page_unavailable');
    assert.equal(offers, stage === 'fetch' ? 0 : 1);
  });
});

test('调用取消能终止等待和传递signal，迟到下载或offer不复用', async t => {
  for (const stage of ['fetch', 'offer']) await t.test(stage, async sub => {
    const pendingFetch = deferred<FetchResult>(), pendingOffer = deferred<{ mediaRef: string; expiresInSeconds: number }>();
    sub.after(() => { pendingFetch.resolve(response('https://images.example.com/0.gif')); pendingOffer.resolve({ mediaRef: 'media_late', expiresInSeconds: 60 }); });
    let imageCalls = 0, offers = 0, captured: AbortSignal | undefined;
    const { runtime } = setup(sub, { fetch: async (url, options) => {
      if (url.endsWith('.gif') && ++imageCalls === 1 && stage === 'fetch') { captured = options.signal; return pendingFetch.promise; }
      return response(url);
    } });
    runtime.setGallery(gallery(async (_input, options) => {
      offers++; if (offers === 1 && stage === 'offer') { captured = options?.signal; return pendingOffer.promise; }
      return { mediaRef: 'media_fresh', expiresInSeconds: 60 };
    }).binding);
    const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 }, aborter = new AbortController();
    const pending = runtime.prepareCollection(input, { signal: aborter.signal }); await tick();
    aborter.abort('SYNTHETIC-SECRET-CANCEL'); failed(await pending, 'cancelled'); assert.equal(captured?.aborted, true);
    pendingFetch.resolve(response('https://images.example.com/0.gif')); pendingOffer.resolve({ mediaRef: 'media_late', expiresInSeconds: 60 }); await tick();
    assert.equal(success(await runtime.prepareCollection(input)).mediaRef, 'media_fresh');
    assert.equal(offers, stage === 'fetch' ? 1 : 2); assert.equal(runtime.status().activeRequests, 0);
  });
});

test('图库停止或替换取消在途下载和offer，不复用旧绑定引用', async t => {
  for (const stage of ['fetch', 'offer']) for (const change of ['abort', 'replace']) await t.test(`${stage}-${change}`, async sub => {
    const gate = deferred<void>(); sub.after(() => gate.resolve());
    let captured: AbortSignal | undefined, offers = 0, first = true;
    const { runtime } = setup(sub, { fetch: async (url, options) => {
      if (url.endsWith('.gif') && stage === 'fetch' && first) { first = false; captured = options.signal; await gate.promise; }
      return response(url);
    } });
    const old = gallery(async (_input, options) => { offers++; captured = options?.signal; if (stage === 'offer') await gate.promise; return { mediaRef: 'media_old', expiresInSeconds: 60 }; });
    runtime.setGallery(old.binding); const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
    const pending = runtime.prepareCollection(input); await tick();
    const next = gallery(async () => ({ mediaRef: 'media_new', expiresInSeconds: 60 }));
    if (change === 'abort') old.aborter.abort('SYNTHETIC-SECRET-BINDING'); else runtime.setGallery(next.binding);
    failed(await pending, 'gallery_unavailable'); assert.equal(captured?.aborted, true);
    gate.resolve(); await tick(); assert.equal(offers, stage === 'fetch' ? 0 : 1);
    if (change === 'abort') runtime.setGallery(next.binding);
    assert.equal(success(await runtime.prepareCollection(input)).mediaRef, 'media_new');
    assert.equal(runtime.status().activeRequests, 0);
  });
});

test('停止surf取消等待、清空缓存并拒绝新请求，不调用不存在的图库release', async t => {
  const gate = deferred<void>(); t.after(() => gate.resolve()); let captured: AbortSignal | undefined;
  const { runtime, disposed, calls } = setup(t);
  runtime.setGallery(gallery(async (_input, options) => { captured = options?.signal; await gate.promise; return { mediaRef: 'media_late', expiresInSeconds: 60 }; }).binding);
  const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  const pending = runtime.prepareCollection(input); await tick(); await runtime.dispose();
  failed(await pending, 'stopped'); assert.equal(captured?.aborted, true); assert.equal(disposed(), true);
  gate.resolve(); await tick(); failed(await runtime.prepareCollection(input), 'stopped');
  assert.equal(runtime.status().gallery, false); assert.equal(runtime.status().activeRequests, 0); assert.equal(calls.length, 2);
});

test('提供方错误和非法引用保持固定错误，不回显数据且不留下缓存', async t => {
  const bad: unknown[] = [null, { mediaRef: '', expiresInSeconds: 60 }, { mediaRef: 'x'.repeat(81), expiresInSeconds: 60 },
    { mediaRef: 'PRIVATE\nref', expiresInSeconds: 60 }, { mediaRef: 'media_test', expiresInSeconds: '60' },
    ...[0, -1, NaN, Infinity, Number.MAX_VALUE].map(expiresInSeconds => ({ mediaRef: 'media_test', expiresInSeconds }))];
  const { runtime, calls } = setup(t); let index = 0;
  runtime.setGallery(gallery(async () => {
    if (index === bad.length) { index++; throw Error('PRIVATE-SYNTHETIC-SECRET-provider-body'); }
    return bad[index++] as Awaited<ReturnType<GalleryService['offerMedia']>>;
  }).binding);
  const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  for (let i = 0; i <= bad.length; i++) failed(await runtime.prepareCollection(input), 'image_unavailable');
  assert.equal(calls.length, bad.length + 2); assert.equal(runtime.status().activeRequests, 0);
});

test('网络安全和内容错误在交入图库前拒绝，不调用提供者', async t => {
  const cases = [
    { code: 'unsafe_url', fail: new SurfError('unsafe_url') }, { code: 'too_large', fail: new SurfError('too_large') },
    { code: 'network_error', fail: Error('PRIVATE-SYNTHETIC-SECRET-network') },
    { code: 'access_blocked', status: 403 }, { code: 'unsupported_content', type: 'text/html' },
  ];
  for (const scenario of cases) await t.test(scenario.code, async sub => {
    let offers = 0; const { runtime } = setup(sub, { fetch: async url => {
      const result = response(url); if (!url.endsWith('.gif')) return result;
      if (scenario.fail) throw scenario.fail;
      return { ...result, status: scenario.status ?? 200, headers: { 'content-type': scenario.type ?? 'image/gif' } };
    } });
    runtime.setGallery(gallery(async () => { offers++; return { mediaRef: 'media_unused', expiresInSeconds: 60 }; }).binding);
    const page = await read(runtime);
    failed(await runtime.prepareCollection({ sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 }), scenario.code);
    assert.equal(offers, 0);
  });
});

test('相同图片在途准备只提交一次，已完成请求直接复用', async t => {
  const gate = deferred<void>(); t.after(() => gate.resolve()); let count = 0;
  const { runtime, calls } = setup(t);
  runtime.setGallery(gallery(async () => { count++; await gate.promise; return { mediaRef: 'media_deduplicated', expiresInSeconds: 60 }; }).binding);
  const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  const first = runtime.prepareCollection(input); await tick();
  failed(await runtime.prepareCollection(input), 'busy'); assert.equal(count, 1); assert.equal(calls.length, 2);
  gate.resolve(); const result = success(await first);
  assert.deepEqual(success(await runtime.prepareCollection(input)), result); assert.equal(count, 1); assert.equal(calls.length, 2);
});

test('图库32项容量包含在途占位，过期后释放容量', async t => {
  const gate = deferred<void>(); t.after(() => gate.resolve()); let count = 0, now = 0;
  const { runtime, calls } = setup(t, { now: () => now, config: { concurrency: 8 } });
  runtime.setGallery(gallery(async () => { count++; if (count === 32) await gate.promise; return { mediaRef: 'media_' + count, expiresInSeconds: 60 }; }).binding);
  const page = await read(runtime), another = await read(runtime, 'trusted', 'https://example.com/another');
  for (let i = 0; i < 31; i++) success(await runtime.prepareCollection({ sessionId: 'trusted', pageRef: page.pageRef, imageIndex: i }));
  const last = runtime.prepareCollection({ sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 31 }); await tick();
  const anotherInput = { sessionId: 'trusted', pageRef: another.pageRef, imageIndex: 0 };
  failed(await runtime.prepareCollection(anotherInput), 'busy'); assert.equal(count, 32); assert.equal(calls.length, 34);
  gate.resolve(); success(await last); failed(await runtime.prepareCollection(anotherInput), 'busy');
  now = 60000; success(await runtime.prepareCollection(anotherInput)); assert.equal(count, 33); assert.equal(calls.length, 35);
});

test('图库准备共享浏览并发限制，完成后释放操作位', async t => {
  const gate = deferred<void>(); t.after(() => gate.resolve()); const { runtime } = setup(t, { config: { concurrency: 1 } });
  runtime.setGallery(gallery(async () => { await gate.promise; return { mediaRef: 'media_limit', expiresInSeconds: 60 }; }).binding);
  const page = await read(runtime), input = { sessionId: 'trusted', pageRef: page.pageRef, imageIndex: 0 };
  const pending = runtime.prepareCollection(input); await tick();
  failed(await runtime.read({ sessionId: 'trusted', pageRef: page.pageRef }), 'busy');
  failed(await runtime.prepareCollection({ ...input, imageIndex: 1 }), 'busy');
  assert.equal(runtime.status().activeRequests, 1); gate.resolve(); success(await pending);
  assert.equal(runtime.status().activeRequests, 0); success(await runtime.read({ sessionId: 'trusted', pageRef: page.pageRef }));
});
