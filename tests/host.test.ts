/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CURRENT_HOST, MINIMUM_HOST, RAW_PAGE, RAW_SEARCH, QUERY, ARG_SECRET, ERROR_SECRET,
  SAVED_SECRET, PAGE_URL, hostFixture, installVision, until, diskText } from './host-fixture.ts';

const deadline = { timeout: 35000 };
const toolCall = (name: string, args: unknown = {}) => ({ id: 'synthetic-' + name,
  name, arguments: JSON.stringify(args) });
const childService = (f: Awaited<ReturnType<typeof hostFixture>>) =>
  f.app.runtime.records.get('surf/platform-fixture').local.get('surf-child-test');

for (const baseline of [CURRENT_HOST, MINIMUM_HOST]) {
  test(`real loadPath on ${baseline}: status, authenticated settings and explicit compatibility boundary`, deadline, async t => {
    const f = await hostFixture(t, baseline), current = baseline === CURRENT_HOST;
    const record = f.app.runtime.records.get('surf');
    assert.equal(record.manifest.console.groupChildren, true);
    assert.equal(f.app.runtime.records.get('surf/platform-fixture').status, 'active');
    assert.notEqual((await childService(f).stats()).pid, record.execution.pid);
    const tools = f.names();
    assert.ok(tools.includes('surf_status'));
    assert.equal(tools.includes('surf_read'), current);
    assert.equal(tools.includes('surf_search'), current);
    assert.equal(tools.includes('surf_image'), false);
    const status = await f.call('surf_status');
    assert.equal(status.ok, true);
    assert.equal(status.result.ready, current);
    assert.equal(status.result.vision, false);
    assert.equal(status.result.configValid, true);
    assert.equal((await f.service().status()).ready, current);
    assert.equal((await childService(f).status()).ready, current);
    assert.equal((await f.service('surf-test-fixture').stats()).calls, 0);
    assert.equal((await fetch(f.baseUrl + '/plugins/surf/config', { signal: AbortSignal.timeout(4000) })).status, 401);
    assert.equal((await fetch(f.baseUrl + '/plugins/surf/settings', { signal: AbortSignal.timeout(4000) })).status, 401);
    const settings = await f.request('/plugins/surf/settings');
    assert.equal(settings.status, 200);
    assert.match(await settings.text(), /surf|冲浪/);
    const response = await f.request('/plugins/surf/config');
    assert.equal(response.status, 200);
    const state: any = await response.json();
    assert.equal(state.status.ready, current);
    assert.equal(state.config.searchProvider, 'bing');
    assert.equal(state.config.hasBraveApiKey, false);
    assert.equal(state.config.hasProxy, false);
    assert.equal(Object.hasOwn(state.config, 'braveApiKey'), false);
    assert.equal(Object.hasOwn(state.config, 'proxyUrl'), false);
    const { hasBraveApiKey, hasProxy, ...editable } = state.config;
    const saved = await f.request('/plugins/surf/config', { revision: state.revision,
      config: { ...editable, timeoutMs: 12000, braveApiKey: SAVED_SECRET } });
    assert.equal(saved.status, 200, await saved.text());
    const savedState: any = await (await f.request('/plugins/surf/config')).json();
    assert.equal(savedState.config.timeoutMs, 12000);
    assert.equal(savedState.config.hasBraveApiKey, true);
    assert.ok(!JSON.stringify(savedState).includes(SAVED_SECRET));
    const conflict = await f.request('/plugins/surf/config', { revision: state.revision, config: editable });
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as any).error.code, 'config_conflict');
    if (current) {
      assert.equal(f.app.tools.entries.get('surf_read').transientResult, true);
      assert.equal(f.app.tools.entries.get('surf_search').transientResult, true);
      for (const provider of ['duckduckgo', 'brave']) {
        const currentState: any = await (await f.request('/plugins/surf/config')).json();
        const changed = await f.request('/plugins/surf/config', { revision: currentState.revision,
          config: { searchProvider: provider, braveApiKey: '' } });
        assert.equal(changed.status, 200, await changed.text());
        await f.app.runtime.action('surf', 'reload');
        assert.equal((await f.service().settings()).hasBraveApiKey, true, 'blank credential input preserves the stored key');
        const searched = await f.call('surf_search', { query: QUERY });
        assert.equal(searched.result.status, 'ok');
        assert.equal(searched.result.data.provider, provider);
        assert.ok(JSON.stringify(searched.result).includes(RAW_SEARCH));
      }
    } else {
      for (const result of [
        await f.service().read({ sessionId: f.sessionId, url: PAGE_URL }),
        await f.service().search({ sessionId: f.sessionId, query: QUERY }),
      ]) {
        assert.equal(result.status, 'error');
        assert.equal(result.error.code, 'host_required');
        assert.ok(!JSON.stringify(result).includes(ARG_SECRET));
        assert.ok(!JSON.stringify(result).includes(QUERY));
      }
      assert.equal((await f.service('surf-test-fixture').stats()).calls, 0,
        'old host must not fetch external content or register a persistent fallback tool');
      await installVision(f);
      assert.equal(f.names().includes('surf_image'), false, 'missing optional and transient APIs must remain safe');
      assert.equal(f.app.runtime.records.get('surf').status, 'active');
      await f.app.runtime.action('vision', 'stop');
      assert.equal(f.app.runtime.records.get('surf').status, 'active');
    }
    assert.equal(f.requests.length, 0, 'status and settings cannot invoke a model');
    await f.assertPrivate();
  });
}

test('current host keeps raw content, follow-up arguments and credentials out of durable memory and logs', deadline, async t => {
  const f = await hostFixture(t);
  const search = await f.call('surf_search', { query: QUERY });
  assert.equal(search.ok, true);
  assert.equal(search.result.status, 'ok');
  assert.ok(JSON.stringify(search.result).includes(RAW_SEARCH), 'the model receives actual synthetic search content');
  const read = await f.call('surf_read', { url: PAGE_URL });
  assert.equal(read.ok, true);
  assert.equal(read.result.status, 'ok');
  assert.ok(read.result.data.text.includes(RAW_PAGE));
  assert.equal(read.result.data.untrusted, true);
  assert.equal(read.result.data.imageToolAvailable, false);
  const pageRef = read.result.data.pageRef;
  assert.ok(pageRef);
  const unsafeError = await f.call('surf_read', { url: 'https://surf-fixture.example/error?token=' + ARG_SECRET });
  assert.equal(unsafeError.ok, true, 'the tool completed and reports a business failure in its result');
  assert.equal(unsafeError.result.status, 'error');
  assert.equal(unsafeError.result.error.code, 'network_error');
  for (const secret of [ARG_SECRET, ERROR_SECRET]) assert.ok(!JSON.stringify(unsafeError).includes(secret));
  await f.plugin('conversation-fixture', `export function apply(ctx) {
    ctx.tools.register({name:'surf_fixture_echo',description:'Synthetic post-read argument fixture',danger:'safe',
      schema:{text:{type:'string'}},run:args=>args});
    ctx.provide('conversation-fixture', {run:input=>ctx.sessions.run(input), transient:input=>ctx.sessions.runTransient(input)});
  }`);
  await f.load('conversation-fixture');
  let round = 0;
  const visibleReply = '已读到这篇公开文章。还要继续查看吗？SYNTHETIC_SURF_VISIBLE_REPLY';
  f.model(request => {
    round++;
    if (round === 1) return { text: '', toolCalls: [toolCall('surf_read', { url: PAGE_URL })] };
    if (round === 2) {
      assert.ok(JSON.stringify(request.messages).includes(RAW_PAGE));
      return { text: '', toolCalls: [toolCall('surf_fixture_echo', { text: RAW_PAGE + pageRef })] };
    }
    return { text: visibleReply, toolCalls: [] };
  });
  assert.equal(await f.service('conversation-fixture').run({ sessionId: f.sessionId, text: '请读取并与我交流', persona: 'a', permission: 'full' }), visibleReply);
  assert.equal(round, 3);
  assert.equal((await f.app.memory.readSession(f.sessionId)).at(-1).text, visibleReply,
    'ordinary final assistant text follows the current host contract and must survive');
  f.model(request => {
    const serialized = JSON.stringify(request.messages);
    assert.ok(serialized.includes(visibleReply), 'the next conversation retains the actual question');
    for (const marker of [RAW_PAGE, RAW_SEARCH, pageRef, ARG_SECRET]) assert.ok(!serialized.includes(marker));
    return { text: '继续查看你指定的内容。', toolCalls: [] };
  });
  await f.service('conversation-fixture').run({ sessionId: f.sessionId, text: '可以', persona: 'a', permission: 'full' });
  let technicalRound = 0;
  f.model(() => ++technicalRound === 1
    ? { text: '', toolCalls: [toolCall('surf_read', { url: PAGE_URL })] }
    : { text: RAW_PAGE + ARG_SECRET, toolCalls: [] });
  assert.equal(await f.service('conversation-fixture').transient({ sessionId: f.sessionId,
    text: 'Synthetic technical operation', persona: 'a', permission: 'full' }), RAW_PAGE + ARG_SECRET,
  'technical execution returns its result while retaining the host transient isolation contract');
  await f.assertPrivate([pageRef]);
  const pluginData = await diskText(join(f.surf, 'data'));
  for (const marker of [RAW_PAGE, RAW_SEARCH, QUERY, pageRef, ARG_SECRET, ERROR_SECRET]) assert.ok(!pluginData.includes(marker));
});

test('optional vision arrives and stops independently; tools, trusted session and recovery remain correct', deadline, async t => {
  const f = await hostFixture(t), parentPid = f.app.runtime.records.get('surf').execution.pid;
  const first = await f.call('surf_read', { url: PAGE_URL });
  assert.equal(first.result.status, 'ok');
  const pageRef = first.result.data.pageRef;
  assert.equal(first.result.data.imageToolAvailable, false);
  await installVision(f);
  await until(async () => (await f.service().status()).vision && f.names().includes('surf_image'), 'vision binding did not become ready');
  assert.equal(f.app.tools.entries.get('surf_image').transientResult, true);
  assert.equal(f.app.runtime.records.get('surf').dependencies.has('vision'), false);
  assert.equal(f.app.runtime.records.get('surf').execution.pid, parentPid);
  const otherSession = await f.app.sessions.create('Synthetic unrelated surf session');
  const wrong = await f.call('surf_image', { pageRef, imageIndex: 0, sessionId: f.sessionId }, otherSession);
  assert.equal(wrong.result.status, 'error', 'model supplied sessionId cannot override the trusted tool session');
  assert.equal((await f.service('vision').stats()).offers, 0);
  const image = await f.call('surf_image', { pageRef, imageIndex: 0 });
  assert.equal(image.result.status, 'ok');
  assert.equal(image.result.data.state, 'offered');
  assert.equal(image.result.data.nextTool, 'vision_view');
  assert.equal((await f.service('vision').stats()).lastSession, f.sessionId);
  assert.equal((await f.service('vision').stats()).offers, 1);
  assert.equal(f.requests.length, 0, 'offering an image does not claim it has been viewed or call another model');
  await f.app.runtime.action('vision', 'stop');
  await until(async () => !(await f.service().status()).vision && !f.names().includes('surf_image'), 'vision tools survived provider stop');
  assert.equal(f.app.runtime.records.get('surf').status, 'active');
  assert.equal(f.app.runtime.records.get('surf/platform-fixture').status, 'active');
  assert.ok(f.names().includes('surf_read'));
  assert.equal((await f.call('surf_read', { url: PAGE_URL })).result.status, 'ok');
  await f.app.runtime.action('vision', 'start');
  await until(() => f.names().includes('surf_image'), 'vision tools did not return');
  assert.equal((await f.service('vision').stats()).offers, 0, 'provider recovery must not replay image offers');
  assert.equal(f.app.runtime.records.get('surf').execution.pid, parentPid);
  assert.deepEqual(f.app.runtime.list().filter((record: any) => !record.builtin).map((record: any) => record.id).sort(),
    ['surf', 'surf/platform-fixture', 'vision'], 'there is no separate bridge plugin');
  await f.assertPrivate([pageRef, image.result.data.mediaRef]);
});

test('parent stop cancels waiting work, blocks children and resumes without replay or reviving an opted-out child', deadline, async t => {
  const f = await hostFixture(t);
  const child = childService(f), parentPid = f.app.runtime.records.get('surf').execution.pid;
  const read = await child.read({ sessionId: f.sessionId, url: PAGE_URL });
  assert.equal(read.status, 'ok');
  assert.equal((await child.stats()).reads, 1);
  const pageRef = read.data.pageRef;
  await f.service('surf-test-fixture').advance(601000);
  const expired = await f.call('surf_read', { pageRef });
  assert.equal(expired.result.status, 'error');
  assert.equal(expired.result.error.code, 'page_unavailable');
  const timeout = await f.call('surf_read', { url: 'https://surf-fixture.example/timeout' });
  assert.equal(timeout.result.status, 'error');
  assert.equal(timeout.result.error.code, 'timeout');
  assert.equal((await f.service().status()).activeRequests, 0);
  const waiting = f.call('surf_read', { url: 'https://surf-fixture.example/wait' }).then(
    (result: any) => ({ result }), (error: unknown) => ({ error }));
  await until(async () => (await f.service('surf-test-fixture').stats()).waiting, 'synthetic request never started');
  const stoppedAt = Date.now();
  await f.app.runtime.action('surf', 'stop');
  const outcome = await waiting;
  assert.ok(Date.now() - stoppedAt < 6000, 'cancel and stop must settle within the bounded host shutdown');
  assert.notEqual(f.app.runtime.records.get('surf/platform-fixture').status, 'active');
  assert.equal(f.names().some(name => name.startsWith('surf_')), false);
  if ('result' in outcome && outcome.result.ok) assert.notEqual(outcome.result.result.status, 'ok');
  await f.app.runtime.action('surf', 'start');
  assert.equal(f.app.runtime.records.get('surf').status, 'active');
  assert.equal(f.app.runtime.records.get('surf/platform-fixture').status, 'active');
  assert.notEqual(f.app.runtime.records.get('surf').execution.pid, parentPid);
  assert.equal((await f.service('surf-test-fixture').stats()).calls, 0, 'restart cannot replay requests');
  assert.equal((await childService(f).stats()).reads, 0, 'child restart cannot replay a previous read');
  const stale = await f.call('surf_read', { pageRef });
  assert.equal(stale.result.error.code, 'page_unavailable');
  await f.app.runtime.action('surf/platform-fixture', 'stop');
  await f.app.runtime.action('surf', 'reload');
  assert.equal(f.app.runtime.records.get('surf/platform-fixture').status, 'stopped', 'saved child opt-out must survive parent reload');
  assert.equal(await readFile(join(f.childDir, 'data/config.json'), 'utf8'), '{"syntheticSavedChoice":"keep"}');
  const state: any = await (await f.request('/api/status')).json();
  assert.equal(state.plugins.find((record: any) => record.id === 'surf').console.groupChildren, true);
  assert.equal(state.plugins.find((record: any) => record.id === 'surf/platform-fixture').enabled, false);
  await f.assertPrivate([pageRef]);
});
