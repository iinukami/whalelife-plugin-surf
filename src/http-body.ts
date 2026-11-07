/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { IncomingMessage } from 'node:http';
import { SurfError, type ErrorCode } from './errors.ts';

/** Read this request only. Never log malformed input or close a shared socket. */
export function readJsonBody(req: IncomingMessage, signal: AbortSignal,
  options: { maxBytes?: number; timeoutMs?: number } = {}): Promise<unknown> {
  const maxBytes = options.maxBytes ?? 12_288;
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    return Promise.reject(new SurfError('invalid_input'));
  }
  return new Promise((resolve, reject) => {
    let done = false;
    let length = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      req.removeListener('close', onClose);
      signal.removeEventListener('abort', onAborted);
      chunks.length = 0;
    };
    const fail = (code: ErrorCode) => {
      if (done) return;
      done = true;
      cleanup();
      // This reader owns no other requests, sockets, or user connections.
      req.pause();
      reject(new SurfError(code));
    };
    function onData(chunk: unknown) {
      if (done) return;
      if (typeof chunk !== 'string' && !(chunk instanceof Uint8Array)) { fail('invalid_input'); return; }
      const size = typeof chunk === 'string' ? Buffer.byteLength(chunk, 'utf8') : chunk.byteLength;
      if (size > maxBytes - length) { fail('too_large'); return; }
      length += size;
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk));
    }
    function onEnd() {
      if (done) return;
      if (signal.aborted) { fail('cancelled'); return; }
      let value: unknown;
      try {
        const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length));
        value = JSON.parse(json);
      } catch { fail('invalid_input'); return; }
      done = true;
      cleanup();
      resolve(value);
    }
    function onError() { fail('invalid_input'); }
    function onAborted() { fail('cancelled'); }
    function onClose() { if (!done) fail('cancelled'); }
    if (signal.aborted || req.aborted || req.destroyed) { fail('cancelled'); return; }
    if (req.readableEnded) { fail('invalid_input'); return; }
    // Attach terminal events before enabling flowing mode through the data listener.
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
    signal.addEventListener('abort', onAborted, { once: true });
    timer = setTimeout(() => fail('timeout'), timeoutMs);
    req.on('data', onData);
    if (signal.aborted) onAborted();
  });
}
