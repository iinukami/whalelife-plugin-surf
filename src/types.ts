/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
export interface SurfConfig {
  searchProvider: 'bing' | 'duckduckgo' | 'brave';
  braveApiKey: string;
  proxyUrl: string;
  timeoutMs: number;
  maxPageBytes: number;
  maxImageBytes: number;
  maxTextChars: number;
  resultsLimit: number;
  referenceTtlSeconds: number;
  concurrency: number;
}
export type PublicConfig = Omit<SurfConfig, 'braveApiKey' | 'proxyUrl'> & {
  hasBraveApiKey: boolean; hasProxy: boolean;
};
export interface FetchOptions {
  signal?: AbortSignal; timeoutMs: number; maxBytes: number;
  headers?: Record<string, string>; proxyUrl?: string; allowRedirects?: boolean;
}
export interface FetchResult { url: string; status: number; headers: Record<string, string>; body: Buffer }
export interface PublicFetcher {
  get(url: string, options: FetchOptions): Promise<FetchResult>;
  dispose(): void | Promise<void>;
}
export interface WebLink { text: string; url: string }
export interface WebImage { url: string; alt: string }
export interface ParsedPage {
  title: string; text: string; links: WebLink[]; images: WebImage[];
  truncated: boolean; notice?: string;
}
export interface SearchItem { title: string; url: string; snippet: string }
export interface CallOptions { signal?: AbortSignal }
export interface SearchInput { query: string; limit?: number }
export interface ReadInput { url?: string; pageRef?: string; offset?: number }
export interface ImageInput { pageRef: string; imageIndex: number }
export interface SurfStatus {
  version: '1.0.0'; ready: boolean; vision: boolean; gallery: boolean; configValid: boolean;
  searchProvider: SurfConfig['searchProvider']; activeRequests: number;
}
export type OperationResult<T> = { status: 'ok'; data: T } | { status: 'error'; error: { code: string; message: string } };
export interface SearchData { provider: string; results: SearchItem[]; untrusted: true }
export interface PageData {
  pageRef: string; url: string; title: string; text: string; offset: number;
  nextOffset?: number; truncated: boolean; expiresAt: string;
  links: WebLink[]; images: { index: number; alt: string }[];
  imageToolAvailable: boolean; collectionToolAvailable: boolean; untrusted: true; notice?: string;
}
export interface ImageData { mediaRef: string; expiresAt: string; nextTool: 'vision_view'; state: 'offered' }
export interface GalleryImageData { mediaRef: string; expiresAt: string; nextTool: 'gallery_collect'; state: 'offered' }
/** Trusted backend service only. sessionId must come from ToolSession.id, never model arguments. */
export interface SurfService {
  status(): SurfStatus;
  settings(): PublicConfig;
  search(input: SearchInput & { sessionId: string }, options?: CallOptions): Promise<OperationResult<SearchData>>;
  read(input: ReadInput & { sessionId: string }, options?: CallOptions): Promise<OperationResult<PageData>>;
  image(input: ImageInput & { sessionId: string }, options?: CallOptions): Promise<OperationResult<ImageData>>;
  prepareCollection(input: ImageInput & { sessionId: string }, options?: CallOptions): Promise<OperationResult<GalleryImageData>>;
}
/** Consumer-side subset of vision's published 1.0.0 contract. */
export interface VisionService {
  offerMedia(input: { sessionId: string; mime: string; base64: string }, options?: CallOptions): Promise<{ mediaRef: string; expiresAt: string; info: unknown }>;
  release(input: { sessionId: string; mediaRef: string }, options?: CallOptions): Promise<{ released: boolean }>;
}
/** Consumer-side subset of gallery's published 1.0.0 contract; offering does not collect. */
export interface GalleryService {
  offerMedia(input: { sessionId: string; base64: string; source?: string }, options?: CallOptions): Promise<{ mediaRef: string; expiresInSeconds: number }>;
}
