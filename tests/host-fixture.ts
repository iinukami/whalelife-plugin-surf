/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { mkdir, writeFile, readFile, readdir, symlink, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { temporaryDirectory, root } from './temporary-directory.ts';

export const CURRENT_HOST = 'bfc7639e69358f2d981faf8a4554656d0dc70b12';
// RELEASING.md preserves this named compatibility tag; the old short hash is ambiguous.
export const MINIMUM_HOST = 'refs/tags/213b52b';
const MINIMUM_HOST_COMMIT = '7c8e3898b2bc7cb0b892eb0ab2feec0ca9c8aaf0';
export const RAW_PAGE = 'SYNTHETIC_SURF_FOREIGN_PAGE_DO_NOT_PERSIST';
export const RAW_SEARCH = 'SYNTHETIC_SURF_FOREIGN_SEARCH_DO_NOT_PERSIST';
export const QUERY = 'SYNTHETIC_SURF_PRIVATE_QUERY_DO_NOT_PERSIST';
export const ARG_SECRET = 'SYNTHETIC_SURF_ARGUMENT_SECRET';
export const ERROR_SECRET = 'SYNTHETIC_SURF_ERROR_CREDENTIAL';
export const SAVED_SECRET = 'SYNTHETIC_SURF_SAVED_API_KEY';
export const PAGE_URL = 'https://surf-fixture.example/article?private=' + ARG_SECRET;
const host = resolve(root, '../whalelife');

export async function until(check: () => boolean | Promise<boolean>, label: string, milliseconds = 6000) {
  const deadline = Date.now() + milliseconds;
  while (!await check()) {
    assert.ok(Date.now() < deadline, label);
    await delay(20);
  }
}

export async function diskText(directory: string): Promise<string> {
  const chunks: string[] = [];
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error: any) { if (error.code === 'ENOENT') return ''; throw error; }
  for (const entry of entries) {
    const path = join(directory, entry.name);
    assert.equal(entry.isSymbolicLink(), false, 'persisted fixture trees must not contain links');
    chunks.push(entry.isDirectory() ? await diskText(path) : await readFile(path, 'utf8'));
  }
  return chunks.join('\n');
}

export async function hostFixture(t: TestContext, baseline = CURRENT_HOST) {
  const f = await temporaryDirectory(t);
  const source = join(f.dir, 'host');
  await mkdir(source);
  const archive = join(f.dir, 'host.tar');
  const revision = spawnSync('git', ['-C', host, 'rev-parse', '--verify', baseline + '^{commit}'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(revision.status, 0, revision.stderr || revision.error?.message);
  assert.equal(revision.stdout.trim(), baseline === MINIMUM_HOST ? MINIMUM_HOST_COMMIT : CURRENT_HOST,
    'a frozen host test baseline must not silently move');
  const git = spawnSync('git', ['-C', host, 'archive', '--format=tar', '--output=' + archive, revision.stdout.trim(), 'core', 'package.json'],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(git.status, 0, git.stderr || git.error?.message);
  const tar = spawnSync('tar', ['-xf', archive, '-C', source], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  assert.equal(tar.status, 0, tar.stderr || tar.error?.message);
  await symlink(join(host, 'node_modules'), join(source, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const run = join(f.dir, 'runtime');
  await mkdir(join(run, 'config'), { recursive: true });
  await mkdir(join(run, 'plugins'), { recursive: true });
  await writeFile(join(run, 'config/config.json'), JSON.stringify({
    log: { level: 'info' }, web: { port: 0 },
    plugin_runtime: { startupTimeoutMs: 8000, callTimeoutMs: 4000, heartbeatTimeoutMs: 2000, stopTimeoutMs: 800 },
    providers: [{ id: 'synthetic', name: 'Synthetic', protocol: 'openai-compatible', base_url: 'http://127.0.0.1:1/v1', api_key: 'synthetic-model-secret' }],
    models: [{ id: 'synthetic-chat', provider: 'synthetic', name: 'Synthetic', model: 'fixture', type: 'chat', enabled: true, context_window: 32000 }],
    model_bindings: { chat: 'synthetic-chat' },
    personas: { a: { name: 'Synthetic', file: 'personas/a.md', model: 'synthetic-chat', permission: 'full' } },
    channels: { web: { persona: 'a', permission: 'full' } }, memory: { root: 'memory', budget_tokens: 6000 },
  }));
  const { boot } = await import(pathToFileURL(join(source, 'core/index.ts')).href);
  let app: any;
  f.cleanup.push(async () => { await app?.close(); });
  app = await boot(run);
  const requests: any[] = [], events: any[] = [];
  app.llm.chat = async () => { throw Error('Unexpected model call: test has not installed a synthetic response'); };
  app.runtime.events.on('tool/called', (event: any) => events.push(event));
  const model = (reply: (request: any) => any) => {
    app.llm.chat = async (request: any) => {
      requests.push(JSON.parse(JSON.stringify(request)));
      const result = await reply(request);
      if (result.text) request.onChunk?.(result.text);
      return { usage: { prompt_tokens: 20, completion_tokens: 4 }, ...result };
    };
  };
  const plugin = async (id: string, body: string, manifest: Record<string, unknown> = {}) => {
    const dir = join(run, 'plugins', ...id.split('/').flatMap((part, index) => index ? ['sub', part] : [part]));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'plugin.yaml'), JSON.stringify({ id: id.split('/').at(-1), name: id,
      description: 'Synthetic isolated test fixture', version: '1.0.0', apiVersion: '1.0.0', ...manifest }));
    await writeFile(join(dir, 'index.ts'), body);
    return dir;
  };
  const surf = join(run, 'plugins/surf');
  await mkdir(surf);
  await cp(join(root, 'plugin.yaml'), join(surf, 'plugin.yaml'));
  await writeFile(join(surf, 'index.ts'), `
import { applyWithDependencies } from ${JSON.stringify(pathToFileURL(join(root, 'index.ts')).href)};
import { SurfError } from ${JSON.stringify(pathToFileURL(join(root, 'src/errors.ts')).href)};
export async function apply(ctx) {
  let now = Date.now(), calls = 0, waiting = false, cancelled = 0, disposed = false;
  const rawPage = ${JSON.stringify(RAW_PAGE)}, rawSearch = ${JSON.stringify(RAW_SEARCH)};
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=', 'base64');
  const fetcher = {
    async get(url, options) {
      calls++;
      options.signal?.throwIfAborted();
      const parsed = new URL(url);
      if (parsed.pathname === '/error') throw Error('Synthetic request failed: https://user:${ERROR_SECRET}@surf-fixture.example/' + ${JSON.stringify(ARG_SECRET)});
      if (parsed.pathname === '/timeout') throw new SurfError('timeout');
      if (parsed.pathname === '/wait') {
        waiting = true;
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { dispose(); reject(Error('Synthetic wait deadline')); }, 2500);
          const abort = () => { cancelled++; dispose(); reject(new SurfError('cancelled')); };
          const dispose = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); waiting = false; };
          options.signal?.addEventListener('abort', abort, {once:true});
          if (options.signal?.aborted) abort();
        });
      }
      if (parsed.pathname.endsWith('.png')) return {url, status:200, headers:{'content-type':'image/png'}, body:image};
      if (parsed.hostname === 'cn.bing.com') return {url, status:200, headers:{'content-type':'text/html; charset=utf-8'},
        body:Buffer.from('<html><head><title>Synthetic search - Bing</title></head><body><ol id="b_results"><li class="b_algo"><h2><a href="https://surf-fixture.example/article">Synthetic result</a></h2><div class="b_caption"><p>' + rawSearch + '</p></div></li></ol></body></html>')};
      if (parsed.hostname.includes('duckduckgo')) return {url, status:200, headers:{'content-type':'text/html; charset=utf-8'},
        body:Buffer.from('<html><body><div class="result"><h2 class="result__title"><a class="result__a" href="https://surf-fixture.example/article">Synthetic result</a></h2><a class="result__snippet">' + rawSearch + '</a></div></body></html>')};
      if (parsed.hostname === 'api.search.brave.com') {
        if (options.headers?.['X-Subscription-Token'] !== ${JSON.stringify(SAVED_SECRET)} || options.allowRedirects !== false)
          throw Error('Synthetic Brave request did not receive the selected credential and redirect policy');
        return {url, status:200, headers:{'content-type':'application/json'},
          body:Buffer.from(JSON.stringify({web:{results:[{title:'Synthetic result',url:'https://surf-fixture.example/article',description:rawSearch}]}}))};
      }
      return {url, status:200, headers:{'content-type':'text/html; charset=utf-8'}, body:Buffer.from('<!doctype html><html><head><title>Synthetic article</title></head><body><article><h1>Synthetic article</h1><p>' + rawPage + ' This is synthetic text for an isolated integration test.</p><a href="/next">Synthetic next page</a><img src="https://surf-fixture.example/image.png" alt="Synthetic image"></article></body></html>')};
    },
    dispose() { disposed = true; }
  };
  ctx.provide('surf-test-fixture', {
    stats() { return {calls,waiting,cancelled,disposed,pid:process.pid}; },
    advance(milliseconds) { now += milliseconds; }
  });
  return applyWithDependencies(ctx, {fetcher, now:()=>now});
}`);
  const childDir = await plugin('surf/platform-fixture', `export function apply(ctx) {
    const surf = ctx.get('surf'); let reads = 0;
    ctx.provide('surf-child-test', { status() { return surf.status(); },
      async read(input) { reads++; return surf.read(input); }, stats() { return {reads,pid:process.pid}; }
    });
  }`, { depends: ['surf'] });
  await mkdir(join(childDir, 'data'));
  await writeFile(join(childDir, 'data/config.json'), '{"syntheticSavedChoice":"keep"}');
  const load = async (id: string) => {
    const record = await app.runtime.loadPath(id);
    assert.equal(record.status, 'active', record.error);
    assert.notEqual(record.execution.pid, process.pid, 'loadPath must execute in a real isolated plugin process');
    return record;
  };
  await load('surf');
  const baseUrl = `http://127.0.0.1:${app.web.server.address().port}`;
  const login = await fetch(baseUrl + '/api/login', { method: 'POST', body: '{}', signal: AbortSignal.timeout(4000) });
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  const request = (path: string, body?: unknown) => fetch(baseUrl + path, {
    method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const service = (name = 'surf') => app.runtime.services.get(name)?.value;
  const names = () => app.tools.list().map((tool: any) => tool.function.name) as string[];
  const sessionId = await app.sessions.create('Synthetic surf integration');
  const call = (name: string, args: unknown = {}, id = sessionId, signal?: AbortSignal) =>
    app.tools.call(name, args, { id, permission: 'full', ...(signal ? { signal } : {}) });
  const assertPrivate = async (extra: string[] = []) => {
    await app.runtime.events.drain();
    await app.memory.queue;
    for (const directory of ['memory', 'logs']) {
      const saved = await diskText(join(run, directory));
      for (const marker of [RAW_PAGE, RAW_SEARCH, QUERY, ARG_SECRET, ERROR_SECRET, SAVED_SECRET, ...extra])
        assert.ok(!saved.includes(marker), `${directory} retained private marker ${marker}`);
    }
    const projected = JSON.stringify(events);
    for (const marker of [RAW_PAGE, RAW_SEARCH, QUERY, ARG_SECRET, ERROR_SECRET, SAVED_SECRET, ...extra])
      assert.ok(!projected.includes(marker), 'event projection retained private content');
  };
  return { ...f, app, run, source, surf, childDir, baseline, sessionId, baseUrl, request, plugin, load,
    service, names, call, model, requests, events, assertPrivate };
}

export async function installVision(f: Awaited<ReturnType<typeof hostFixture>>) {
  await f.plugin('vision', `export function apply(ctx) {
    let offers = 0, releases = 0, lastSession;
    ctx.provide('vision', {
      async offerMedia(input) {
        if (!input.sessionId || input.mime !== 'image/png' || !input.base64) throw Error('Malformed synthetic media');
        offers++; lastSession = input.sessionId;
        return {mediaRef:'synthetic-vision-' + offers, expiresAt:new Date(Date.now()+60000).toISOString(), info:{kind:'image',mime:'image/png'}};
      },
      async release() { releases++; return {released:true}; },
      stats() { return {offers,releases,lastSession,pid:process.pid}; }
    });
  }`);
  await f.load('vision');
}
