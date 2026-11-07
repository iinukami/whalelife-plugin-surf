/*! Copyright (c) 2026 iinukami and contributors.
 * SPDX-License-Identifier: AGPL-3.0-only
 * Additional terms under AGPLv3 Section 7: see LICENSE-ADDITIONAL.
 */
import type { TestContext } from 'node:test';
import { mkdir, mkdtemp, realpath, lstat, rm } from 'node:fs/promises';
import { resolve, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
export async function temporaryDirectory(t: TestContext) {
  const base = resolve(root, '.artifacts/tests');
  let directory: string | undefined;
  const cleanup: (() => unknown | Promise<unknown>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const fn of cleanup.toReversed()) {
      try { await fn(); } catch (error) { errors.push(error); }
    }
    if (directory) {
      const target = resolve(directory), rel = relative(base, target);
      if (!rel || rel.startsWith('..') || isAbsolute(rel) || dirname(target) !== base ||
          resolve(await realpath(base)) !== base || (await lstat(target)).isSymbolicLink()) {
        errors.push(Error('Unsafe test cleanup target'));
      } else {
        try { await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
        catch (error) { errors.push(error); }
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Test cleanup failed');
  });
  await mkdir(base, { recursive: true });
  if ((await lstat(base)).isSymbolicLink() || resolve(await realpath(base)) !== base) throw Error('Unsafe test root');
  directory = await mkdtemp(join(base, 'surf-'));
  return { dir: directory, cleanup };
}
