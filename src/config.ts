/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import { SurfError } from './errors.ts';
import type { PublicConfig, SurfConfig } from './types.ts';
export const defaults: SurfConfig = {
  searchProvider: 'bing', braveApiKey: '', proxyUrl: '', timeoutMs: 20_000,
  maxPageBytes: 2 * 1024 * 1024, maxImageBytes: 8 * 1024 * 1024,
  maxTextChars: 60_000, resultsLimit: 5, referenceTtlSeconds: 600, concurrency: 3,
};
export function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SurfError('invalid_input');
  return input as Record<string, unknown>;
}
const limits = {
  timeoutMs: [1000, 60_000], maxPageBytes: [65536, 4 * 1024 * 1024],
  maxImageBytes: [65536, 16 * 1024 * 1024], maxTextChars: [1000, 100_000],
  resultsLimit: [1, 10], referenceTtlSeconds: [30, 1800], concurrency: [1, 8],
} as const;
export function parseConfig(value: unknown): SurfConfig {
  try {
    const input = object(value), result = { ...defaults };
    if (Object.keys(input).some(key => !Object.hasOwn(defaults, key))) throw new SurfError('config_invalid');
    if (input.searchProvider !== undefined) {
      if (input.searchProvider !== 'bing' && input.searchProvider !== 'duckduckgo' && input.searchProvider !== 'brave') throw new SurfError('config_invalid');
      result.searchProvider = input.searchProvider;
    }
    for (const key of ['braveApiKey', 'proxyUrl'] as const) {
      if (input[key] === undefined) continue;
      if (typeof input[key] !== 'string' || input[key].length > (key === 'proxyUrl' ? 2048 : 512) || /[\x00-\x20\x7f]/.test(input[key]))
        throw new SurfError('config_invalid');
      result[key] = input[key];
    }
    if (result.proxyUrl) {
      const proxy = new URL(result.proxyUrl);
      if (!['http:', 'https:'].includes(proxy.protocol) || proxy.pathname !== '/' || proxy.search || proxy.hash || !proxy.hostname)
        throw new SurfError('config_invalid');
      result.proxyUrl = proxy.href;
    }
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      if (input[key] === undefined) continue;
      const value = input[key], [low, high] = limits[key];
      if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) throw new SurfError('config_invalid');
      result[key] = value;
    }
    return result;
  } catch { throw new SurfError('config_invalid'); }
}
export function publicConfig(config: SurfConfig): PublicConfig {
  const { braveApiKey, proxyUrl, ...rest } = config;
  return { ...rest, hasBraveApiKey: Boolean(braveApiKey), hasProxy: Boolean(proxyUrl) };
}
export function updateConfig(value: unknown, current: SurfConfig): SurfConfig {
  const input = { ...object(value) };
  for (const [key, clear] of [['braveApiKey', 'clearBraveApiKey'], ['proxyUrl', 'clearProxy']] as const) {
    if (input[clear] !== undefined && typeof input[clear] !== 'boolean') throw new SurfError('config_invalid');
    if (input[clear] === true && input[key] !== undefined && input[key] !== '') throw new SurfError('config_invalid');
    input[key] = input[clear] === true ? '' : (input[key] === '' || input[key] === undefined ? current[key] : input[key]);
    delete input[clear];
  }
  return parseConfig({ ...current, ...input });
}
