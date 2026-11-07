/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBing, parseBrave, parseDuckDuckGo, parsePage } from '../src/content.ts';
import { SurfError } from '../src/errors.ts';

const pageUrl = 'https://example.com/news/story';
const ddgUrl = 'https://html.duckduckgo.com/html/?q=synthetic';
const b = (html: string) => Buffer.from(html);
function page(html: string, maximum = 10_000) { return parsePage(b(html), pageUrl, 'text/html; charset=utf-8', maximum); }
function error(code: string) { return (value: unknown) => value instanceof SurfError && value.code === code; }

test('article text preserves paragraphs and excludes executable, hidden and navigation content', () => {
  const result = page(`<title>合成标题 &amp; sample</title><nav>导航秘密</nav><main><article><h1>主题</h1><p>第一段 <b>内容</b>。</p>
    <p>第二段<br>换行</p><script>throw '不要执行'</script><style>.x{}</style><noscript>隐藏替代</noscript>
    <div hidden>隐藏甲</div><div aria-hidden="true">隐藏乙</div><div style=" display: none !important;">隐藏丙</div>
    <div style="visibility: hidden">隐藏丁</div><form>表单噪声</form><aside>广告</aside></article><div>正文以外</div></main>`);
  assert.equal(result.title, '合成标题 & sample');
  assert.match(result.text, /主题\n+第一段 内容。\n+第二段\n换行/);
  assert.doesNotMatch(result.text, /秘密|隐藏|不要执行|广告|正文以外|噪声/);
  assert.equal(result.truncated, false);
});

test('safe base, relative URLs, unicode titles, lazy images and srcset resolve without fetching', () => {
  const result = page(`<base href="https://cdn.example.org/assets/"><main><p>正文</p>
    <a href="guide?q=1&amp;x=2#detail">下一页</a><a href="guide?q=1&amp;x=2">重复</a><a href="#same">本页</a>
    <img src="data:image/png;base64,AA==" data-src="../photo.webp" alt="图 &amp; 片">
    <img srcset="small.png 300w, large.png 1000w" alt="响应图"><img src="../photo.webp" alt="重复图">
    <img src="pixel.gif" width="1" height="1"></main>`);
  assert.deepEqual(result.links, [{ url: 'https://cdn.example.org/assets/guide?q=1&x=2', text: '下一页' }]);
  assert.deepEqual(result.images, [
    { url: 'https://cdn.example.org/photo.webp', alt: '图 & 片' },
    { url: 'https://cdn.example.org/assets/large.png', alt: '响应图' },
  ]);
});

test('untrusted URLs and unsafe base cannot create local media or links', () => {
  const blocked = ['file:///C:/private', 'javascript:alert(1)', 'data:text/html,secret', 'http://127.0.0.1/a',
    'http://2130706433/a', 'http://0x7f000001/a', 'http://169.254.169.254/a', 'http://10.0.0.1/a',
    'http://[::1]/a', 'http://[::ffff:127.0.0.1]/a', 'http://router.local/a', 'http://foo.internal/a',
    'http://localhost./a', 'https://name:password@example.org/a', 'http://intranet/a'];
  const result = page(`<base href="http://localhost/"><article><p>正常正文</p>${blocked.map(url => `<a href="${url}">坏链接</a><img src="${url}">`).join('')}
    <a href="../good">正常链接</a><img src="/public.png" alt="正常图"></article>`);
  assert.deepEqual(result.links, [{ url: 'https://example.com/good', text: '正常链接' }]);
  assert.deepEqual(result.images, [{ url: 'https://example.com/public.png', alt: '正常图' }]);
  assert.throws(() => parsePage(b('<p>data</p>'), 'http://localhost/', 'text/html', 100), error('unsafe_url'));
});

test('HTTP charset and HTML meta charset decode GBK text', () => {
  const chinese = Buffer.from([0xD6, 0xD0, 0xCE, 0xC4]); // 合成夹具：中文。
  const headerCase = Buffer.concat([b('<p>'), chinese, b('</p>')]);
  assert.equal(parsePage(headerCase, pageUrl, 'text/html; charset="gbk"', 100).text, '中文');
  const metaCase = Buffer.concat([b('<meta charset=gbk><p>'), chinese, b('</p>')]);
  assert.equal(parsePage(metaCase, pageUrl, 'text/html', 100).text, '中文');
  assert.equal(parsePage(chinese, pageUrl, 'text/plain; charset=gbk', 100).text, '中文');
});

test('plain text is not interpreted as HTML and truncation does not split surrogate pairs', () => {
  const result = parsePage(b('<script>只是原文</script>\n😀结束'), pageUrl, 'text/plain', 100);
  assert.match(result.text, /^<script>只是原文<\/script>/);
  assert.equal(page('<article>甲😀乙</article>', 2).text, '甲');
  assert.equal(page('<article>甲😀乙</article>', 2).truncated, true);
  assert.throws(() => page('<p>x</p>', 0), error('invalid_input'));
});

test('links and images are bounded and stable, including duplicate targets', () => {
  const result = page(`<main>内容${Array.from({ length: 80 }, (_, n) => `<a href="/${n}">链接 ${n}</a><img src="/p${n}.png">`).join('')}</main>`);
  assert.equal(result.links.length, 40);
  assert.equal(result.images.length, 32);
  assert.equal(result.images[31].url, 'https://example.com/p31.png');
});

test('unsupported types and JS-only shells are not reported as successfully read', () => {
  assert.throws(() => parsePage(b('fake'), pageUrl, 'video/mp4', 100), error('unsupported_content'));
  assert.throws(() => parsePage(b('%PDF'), pageUrl, 'application/pdf', 100), error('unsupported_content'));
  assert.throws(() => page('<div id="app"></div><script src="app.js"></script>'), error('unsupported_content'));
  assert.throws(() => page('<p>Please enable JavaScript to continue.</p><script src="app.js"></script>'), error('unsupported_content'));
  assert.throws(() => page('<div id="app">Loading...</div><script src="app.js"></script>'), error('unsupported_content'));
  const image = page('<main><img src="/content.jpg" alt="只有图片"></main>');
  assert.equal(image.text, '');
  assert.equal(image.images.length, 1);
  assert.match(image.notice!, /没有可提取正文/);
});

test('known challenge and login forms are blocked, an article discussing verification is readable', () => {
  assert.throws(() => page('<title>Verify</title><form id="challenge-form">secret</form>'), error('access_blocked'));
  assert.throws(() => page('<title>Just a moment...</title><div id="challenge-stage">Checking</div>'), error('access_blocked'));
  assert.throws(() => page('<title>登录</title><form><input type="password"></form>'), error('access_blocked'));
  const result = page('<title>验证码的设计</title><article>文章讨论 CAPTCHA、登录与 JavaScript，不是挑战页面。</article>');
  assert.match(result.text, /CAPTCHA/);
  assert.equal(page('<title>Welcome</title><form><input type=password>登录</form><article>公开内容无需登录。</article>').text, '公开内容无需登录。');
});

test('deep markup extraction uses bounded input and no recursive text walk', () => {
  const html = `${'<div>'.repeat(1200)}<p>深层正文</p>${'</div>'.repeat(1200)}`;
  assert.equal(page(html).text, '深层正文');
});

test('DuckDuckGo HTML results decode only valid redirects and retain ordinary snippets', () => {
  const html = `<title>DuckDuckGo</title><div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpaper%3Fa%3D1&amp;rut=opaque">合成 <b>结果</b></a><a class="result__snippet">摘要 &amp; 信息</a></div>
    <div class="result result--ad"><a class="result__a" href="https://ads.example.org/">广告</a></div>
    <div class="result"><a class="result__a" href="https://example.org/paper?a=1">重复结果</a></div>
    <div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=http%3A%2F%2F127.0.0.1%2F">坏目标</a></div>`;
  assert.deepEqual(parseDuckDuckGo(b(html), ddgUrl, 5), [{ title: '合成 结果', url: 'https://example.org/paper?a=1', snippet: '摘要 & 信息' }]);
});

test('DuckDuckGo Lite associates each snippet with its result row', () => {
  const html = `<table><tr><td>1</td><td><a class="result-link" href="https://one.example.org/">One</a></td></tr>
    <tr><td></td><td class="result-snippet">First synthetic snippet</td></tr><tr><td>one.example.org</td></tr>
    <tr><td>2</td><td><a class="result-link" href="https://two.example.org/">Two</a></td></tr>
    <tr><td></td><td class="result-snippet">Second synthetic snippet</td></tr></table>`;
  const results = parseDuckDuckGo(b(html), 'https://lite.duckduckgo.com/lite/', 5);
  assert.equal(results[0].snippet, 'First synthetic snippet');
  assert.equal(results[1].snippet, 'Second synthetic snippet');
  assert.equal(parseDuckDuckGo(b(html), ddgUrl, 1).length, 1);
});

test('DuckDuckGo only accepts known empty-result evidence; changed pages and challenges fail safely', () => {
  assert.deepEqual(parseDuckDuckGo(b('<div class=no-results>No results found.</div>'), ddgUrl, 3), []);
  assert.deepEqual(parseDuckDuckGo(b('<title>DuckDuckGo</title><table><tr><td>No results found for synthetic.</td></tr></table>'), ddgUrl, 3), []);
  assert.throws(() => parseDuckDuckGo(b('<title>New layout</title><div>opaque third-party text</div>'), ddgUrl, 3), error('search_parse'));
  assert.throws(() => parseDuckDuckGo(b('<form id=anomaly-form><div class=anomaly-modal>secret input</div></form>'), ddgUrl, 3), error('access_blocked'));
  assert.throws(() => parseDuckDuckGo(b('<a class=result__a href="file:///secret">unsafe</a>'), ddgUrl, 3), error('search_parse'));
  assert.throws(() => parseDuckDuckGo(b('<div></div>'), ddgUrl, 0), error('invalid_input'));
});

test('Brave structured results normalize text and filter unsafe or duplicate targets', () => {
  const payload = { web: { results: [
    { title: '<b>合成标题</b>', url: 'https://example.org/a#part', description: 'A &amp; B <script>untrusted code</script>' },
    { title: 'duplicate', url: 'https://example.org/a', description: 'duplicate' },
    { title: 'unsafe', url: 'http://[::ffff:127.0.0.1]/' },
    { title: 42, url: 'https://example.org/b' },
  ] } };
  assert.deepEqual(parseBrave(b(JSON.stringify(payload)), 5), [{ title: '合成标题', url: 'https://example.org/a', snippet: 'A & B' }]);
  assert.deepEqual(parseBrave(b('{"web":{"results":[]}}'), 5), []);
});

test('Brave malformed response errors never expose response text', () => {
  for (const input of ['secret token payload', '{"error":"private payload"}', '{"web":{"results":"secret"}}', '{"web":{"results":[{"title":"x","url":"file:///secret"}]}}']) {
    assert.throws(() => parseBrave(b(input), 5), value => error('search_parse')(value) && !String(value).includes('secret') && !String(value).includes('private'));
  }
});

const bingUrl = 'https://cn.bing.com/search?q=synthetic';
const bingRedirect = (url: string) => `https://www.bing.com/ck/a?!&amp;u=a1${Buffer.from(url).toString('base64url')}&amp;ntb=1`;

test('Bing organic results resolve valid encoded targets and read captions without ads', () => {
  const html = `<ol id="b_results">
    <li class="b_algo"><h2><a href="${bingRedirect('https://example.org/article?q=1#part')}">合成 <b>标题</b></a></h2><div class="b_caption"><p>摘要 &amp; 正文</p></div></li>
    <li class="b_algo b_ad"><h2><a href="https://ads.example.org/">广告</a></h2><p>广告摘要</p></li>
    <li class="b_algo sponsored"><h2><a href="https://sponsor.example.org/">赞助</a></h2></li>
    <li class="b_algo"><h2><a href="https://example.org/article?q=1">重复目标</a></h2></li>
    <li class="b_algo"><h2><a href="https://docs.example.org/">直接结果</a></h2><p>直接摘要</p></li>
    </ol><h2><a href="https://unrelated.example.org/">页脚导航</a></h2>`;
  assert.deepEqual(parseBing(b(html), bingUrl, 5), [
    { title: '合成 标题', url: 'https://example.org/article?q=1', snippet: '摘要 & 正文' },
    { title: '直接结果', url: 'https://docs.example.org/', snippet: '直接摘要' },
  ]);
  assert.equal(parseBing(b(html), bingUrl, 1).length, 1);
});

test('Bing redirect decoding rejects local URLs, malformed encoding and internal navigation', () => {
  const unsafe = [
    bingRedirect('http://127.0.0.1/private'), bingRedirect('file:///secret'), bingRedirect('https://name:password@example.org/'),
    bingRedirect('https://www.bing.com/search?q=internal'), '/ck/a?u=not-base64', '/ck/a?u=a1@@@@',
    '/ck/a?u=a1aHR0cHM6Ly9leGFtcGxlLm9yZy8!', '/ck/a', '/search?q=internal', '/images/search?q=synthetic',
  ];
  const html = `<ol id=b_results>${unsafe.map(href => `<li class=b_algo><h2><a href="${href}">不可用目标</a></h2></li>`).join('')}
    <li class=b_algo><h2><a href="https://valid.example.org/">正常目标</a></h2><p>合成摘要</p></li></ol>`;
  assert.deepEqual(parseBing(b(html), bingUrl, 10), [{ title: '正常目标', url: 'https://valid.example.org/', snippet: '合成摘要' }]);
  assert.throws(() => parseBing(b('<ol id=b_results><li class=b_algo><h2><a href="/ck/a?u=bad">错误跳转</a></h2></li></ol>'), bingUrl, 5), error('search_parse'));
});

test('Bing zero results require a known marker; challenge or changed structure fails safely', () => {
  assert.deepEqual(parseBing(b('<ol id=b_results><li class=b_no>No results found for synthetic.</li></ol>'), bingUrl, 5), []);
  assert.throws(() => parseBing(b('<div id=b_captcha>private verification content</div>'), bingUrl, 5), error('access_blocked'));
  assert.throws(() => parseBing(b('<form id=challenge-form>private verification content</form>'), bingUrl, 5), error('access_blocked'));
  assert.throws(() => parseBing(b('<div>private changed page</div>'), bingUrl, 5), value => error('search_parse')(value) && !String(value).includes('private'));
  assert.throws(() => parseBing(b('<div class=b_no>unrelated marker outside results</div>'), bingUrl, 5), error('search_parse'));
  assert.throws(() => parseBing(b('<ol id=b_results></ol>'), bingUrl, 0), error('invalid_input'));
});

test('Bing decoder accepts URL-safe base64 padding only for canonical safe targets', () => {
  const encoded = Buffer.from('https://example.org/路径?q=中文').toString('base64url');
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, '=');
  const html = `<ol id=b_results><li class=b_algo><h2><a href="/ck/a?u=a1${padded}">多语言目标</a></h2></li></ol>`;
  assert.deepEqual(parseBing(b(html), bingUrl, 5), [{ title: '多语言目标', url: 'https://example.org/%E8%B7%AF%E5%BE%84?q=%E4%B8%AD%E6%96%87', snippet: '' }]);
});
