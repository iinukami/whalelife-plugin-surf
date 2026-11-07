/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { randomUUID } from 'node:crypto';
import type { OptionalService } from 'whalelife';
import { publicConfig, object } from './config.ts';
import { SurfError, safeError } from './errors.ts';
import { parsePage, parseBing, parseDuckDuckGo, parseBrave } from './content.ts';
import type { PublicFetcher, SurfConfig, SurfService, SurfStatus, OperationResult, ParsedPage,
  SearchData, PageData, ImageData, SearchInput, ReadInput, ImageInput, CallOptions, VisionService } from './types.ts';

type StoredPage = ParsedPage & { sessionId: string; url: string; expires: number };
type StoredOffer = { sessionId: string; binding: OptionalService<VisionService>; media: ImageData; expires: number };
const PAGE_CHUNK = 6000;
function identity(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 200 || /[\x00-\x1f\x7f]/.test(input)) throw new SurfError('session_required');
  return input;
}
function checkResponse(status: number) {
  if ([401, 403, 429, 503].includes(status)) throw new SurfError('access_blocked');
  if (status < 200 || status > 299) throw new SurfError('http_error');
}

export class SurfRuntime implements SurfService {
  readonly config: SurfConfig;
  private fetcher: PublicFetcher;
  private aborter = new AbortController();
  private signal: AbortSignal;
  private now: () => number;
  private transient: boolean;
  private configValid: boolean;
  private stopped = false;
  private active = 0;
  private pages = new Map<string, StoredPage>();
  private offers = new Map<string, StoredOffer>();
  private imageRequests = new Set<string>();
  private vision?: OptionalService<VisionService>;
  constructor(config: SurfConfig, fetcher: PublicFetcher, options: { signal: AbortSignal; transient: boolean; configValid: boolean; now?: () => number }) {
    this.config = { ...config }; this.fetcher = fetcher; this.now = options.now ?? Date.now;
    this.signal = AbortSignal.any([options.signal, this.aborter.signal]);
    this.transient = options.transient; this.configValid = options.configValid;
  }
  setVision(binding: OptionalService<VisionService> | undefined) {
    if (this.vision !== binding) this.offers.clear();
    this.vision = binding;
  }
  status(): SurfStatus {
    return { version: '1.0.0', ready: !this.stopped && !this.signal.aborted && this.transient && this.configValid,
      configValid: this.configValid, vision: this.visionAvailable(), searchProvider: this.config.searchProvider, activeRequests: this.active };
  }
  settings() { return publicConfig(this.config); }
  private visionAvailable() { return !this.stopped && !this.signal.aborted && Boolean(this.vision && !this.vision.signal.aborted); }
  private async execute<T>(sessionId: unknown, options: CallOptions | undefined, task: (session: string, signal: AbortSignal) => Promise<T>): Promise<OperationResult<T>> {
    let entered = false;
    try {
      if (this.stopped || this.signal.aborted) throw new SurfError('stopped');
      if (!this.transient) throw new SurfError('host_required');
      if (!this.configValid) throw new SurfError('config_invalid');
      const session = identity(sessionId);
      const signal = options?.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
      if (signal.aborted) throw new SurfError('cancelled');
      if (this.active >= this.config.concurrency) throw new SurfError('busy');
      this.active++; entered = true; this.prune();
      const data = await task(session, signal);
      if (signal.aborted) throw new SurfError(this.signal.aborted ? 'stopped' : 'cancelled');
      return { status: 'ok', data };
    } catch (error) {
      const safe = this.signal.aborted ? safeError(new SurfError('stopped')) : options?.signal?.aborted ? safeError(new SurfError('cancelled')) : safeError(error);
      return { status: 'error', error: safe };
    } finally { if (entered) this.active--; }
  }
  private prune() {
    for (const [ref, page] of this.pages) if (page.expires <= this.now()) this.pages.delete(ref);
    for (const [key, offer] of this.offers) if (offer.expires <= this.now() || offer.binding.signal.aborted) this.offers.delete(key);
  }
  private async releaseOffer(binding: OptionalService<VisionService>, sessionId: string, mediaRef: string) {
    if (binding.signal.aborted) return;
    const aborter = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => binding.service.release({ sessionId, mediaRef }, { signal: aborter.signal })).catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(() => { aborter.abort(); resolve(); }, 500); timer.unref(); }),
      ]);
    } finally { if (timer) clearTimeout(timer); aborter.abort(); }
  }
  private page(session: string, ref: unknown): StoredPage {
    const page = typeof ref === 'string' ? this.pages.get(ref) : undefined;
    if (!page || page.sessionId !== session || page.expires <= this.now()) throw new SurfError('page_unavailable');
    return page;
  }
  search(input: SearchInput & { sessionId: string }, options?: CallOptions): Promise<OperationResult<SearchData>> {
    return this.execute(input?.sessionId, options, async (_session, signal) => {
      object(input);
      if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 600 || /[\x00-\x1f\x7f]/.test(input.query)) throw new SurfError('invalid_input');
      const limit = input.limit ?? this.config.resultsLimit;
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new SurfError('invalid_input');
      const provider = this.config.searchProvider;
      if (provider === 'brave' && !this.config.braveApiKey) throw new SurfError('search_unconfigured');
      const url = new URL(provider === 'brave' ? 'https://api.search.brave.com/res/v1/web/search'
        : provider === 'bing' ? 'https://cn.bing.com/search' : 'https://html.duckduckgo.com/html/');
      url.searchParams.set('q', input.query.trim());
      if (provider === 'brave') url.searchParams.set('count', String(limit));
      const response = await this.fetcher.get(url.href, { signal, timeoutMs: this.config.timeoutMs,
        maxBytes: this.config.maxPageBytes, proxyUrl: this.config.proxyUrl, allowRedirects: provider !== 'brave',
        headers: provider === 'brave' ? { 'X-Subscription-Token': this.config.braveApiKey, Accept: 'application/json' } : { Accept: 'text/html' } });
      checkResponse(response.status);
      const results = provider === 'brave' ? parseBrave(response.body, limit)
        : provider === 'bing' ? parseBing(response.body, response.url, limit) : parseDuckDuckGo(response.body, response.url, limit);
      return { provider, results, untrusted: true };
    });
  }
  read(input: ReadInput & { sessionId: string }, options?: CallOptions): Promise<OperationResult<PageData>> {
    return this.execute(input?.sessionId, options, async (session, signal) => {
      object(input);
      const offset = input.offset ?? 0;
      if (!Number.isInteger(offset) || offset < 0 || offset > this.config.maxTextChars || (input.url !== undefined && input.pageRef !== undefined)) throw new SurfError('invalid_input');
      let ref: string, page: StoredPage;
      if (input.pageRef !== undefined) {
        page = this.page(session, input.pageRef); ref = input.pageRef;
      } else {
        if (typeof input.url !== 'string' || !input.url || offset !== 0) throw new SurfError('invalid_input');
        if (this.pages.size >= 32 || [...this.pages.values()].filter(p => p.sessionId === session).length >= 8) throw new SurfError('busy');
        const response = await this.fetcher.get(input.url, { signal, timeoutMs: this.config.timeoutMs,
          maxBytes: this.config.maxPageBytes, proxyUrl: this.config.proxyUrl, headers: { Accept: 'text/html,application/xhtml+xml,text/plain' } });
        checkResponse(response.status);
        const parsed = parsePage(response.body, response.url, response.headers['content-type'] ?? '', this.config.maxTextChars);
        if (signal.aborted) throw new SurfError('cancelled');
        // Recheck after I/O: parallel callers must not exceed the cache capacity.
        this.prune();
        if (this.pages.size >= 32 || [...this.pages.values()].filter(p => p.sessionId === session).length >= 8) throw new SurfError('busy');
        ref = `page_${randomUUID()}`;
        page = { ...parsed, sessionId: session, url: response.url, expires: this.now() + this.config.referenceTtlSeconds * 1000 };
        this.pages.set(ref, page);
      }
      if (offset > page.text.length) throw new SurfError('invalid_input');
      if (offset > 0 && /[\uDC00-\uDFFF]/.test(page.text.charAt(offset)) && /[\uD800-\uDBFF]/.test(page.text.charAt(offset - 1))) throw new SurfError('invalid_input');
      let end = Math.min(page.text.length, offset + PAGE_CHUNK);
      if (end < page.text.length && /[\uD800-\uDBFF]/.test(page.text.charAt(end - 1))) end--;
      return { pageRef: ref, url: page.url, title: page.title, text: page.text.slice(offset, end), offset,
        ...(end < page.text.length ? { nextOffset: end } : {}), truncated: page.truncated,
        expiresAt: new Date(page.expires).toISOString(), links: page.links,
        images: page.images.map((item, index) => ({ index, alt: item.alt })),
        imageToolAvailable: this.visionAvailable(), untrusted: true, ...(page.notice ? { notice: page.notice } : {}) };
    });
  }
  image(input: ImageInput & { sessionId: string }, options?: CallOptions): Promise<OperationResult<ImageData>> {
    return this.execute(input?.sessionId, options, async (session, signal) => {
      object(input);
      const page = this.page(session, input.pageRef), binding = this.vision;
      if (!binding || binding.signal.aborted) throw new SurfError('vision_unavailable');
      if (!Number.isInteger(input.imageIndex) || input.imageIndex < 0 || input.imageIndex >= page.images.length) throw new SurfError('invalid_input');
      const key = `${input.pageRef}:${input.imageIndex}`;
      const cached = this.offers.get(key);
      if (cached && cached.binding === binding && cached.sessionId === session && cached.expires > this.now()) return cached.media;
      if (this.imageRequests.has(key) || this.offers.size + this.imageRequests.size >= 32) throw new SurfError('busy');
      this.imageRequests.add(key);
      try {
        const combined = AbortSignal.any([signal, binding.signal]);
        const response = await this.fetcher.get(page.images[input.imageIndex].url, { signal: combined,
          timeoutMs: this.config.timeoutMs, maxBytes: this.config.maxImageBytes, proxyUrl: this.config.proxyUrl,
          headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' } });
        checkResponse(response.status);
        const mime = (response.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)) throw new SurfError('unsupported_content');
        this.page(session, input.pageRef);
        if (combined.aborted) throw new SurfError('cancelled');
        let offered: Awaited<ReturnType<VisionService['offerMedia']>>;
        try {
          offered = await binding.service.offerMedia({ sessionId: session, mime, base64: response.body.toString('base64') }, { signal: combined });
        } catch { throw new SurfError(binding.signal.aborted ? 'vision_unavailable' : combined.aborted ? 'cancelled' : 'image_unavailable'); }
        if (combined.aborted || this.vision !== binding || page.expires <= this.now()) {
          // Only our confirmed offer is released; the provider's own TTL is the bounded fallback.
          await this.releaseOffer(binding, session, offered.mediaRef);
          throw new SurfError(combined.aborted ? 'cancelled' : 'page_unavailable');
        }
        const expires = Date.parse(offered.expiresAt);
        if (typeof offered.mediaRef !== 'string' || offered.mediaRef.length > 200 || !Number.isFinite(expires) || expires <= this.now()) throw new SurfError('image_unavailable');
        const media: ImageData = { mediaRef: offered.mediaRef, expiresAt: offered.expiresAt, nextTool: 'vision_view', state: 'offered' };
        this.offers.set(key, { sessionId: session, binding, media, expires: Math.min(expires, page.expires) });
        return media;
      } finally { this.imageRequests.delete(key); }
    });
  }
  async dispose() {
    if (this.stopped) return;
    this.stopped = true; this.aborter.abort(); this.pages.clear(); this.vision = undefined;
    const offers = [...this.offers.values()]; this.offers.clear(); this.imageRequests.clear();
    await this.fetcher.dispose();
    await Promise.all(offers.map(offer => this.releaseOffer(offer.binding, offer.sessionId, offer.media.mediaRef)));
  }
}
