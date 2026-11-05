// Downloads with a disk cache, so a rebuild only fetches what it doesn't already have.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

const CACHE_DIR = fileURLToPath(new URL('../../.cache/', import.meta.url));
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  Accept: '*/*',
};
const RETRY_DELAYS_MS = [2000, 6000, 15000];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class RateLimited extends Error {}

export async function download(url, headers = {}) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      headers: { ...HEADERS, ...headers },
      signal: AbortSignal.timeout(30_000),
    }).catch((error) => ({ networkError: error }));

    if (response.ok) return Buffer.from(await response.arrayBuffer());
    if (response.status === 404) return null;
    if (attempt === RETRY_DELAYS_MS.length) {
      const reason = response.networkError?.message ?? `HTTP ${response.status}`;
      if (response.status === 429) throw new RateLimited(`${url}: ${reason}`);
      throw new Error(`${url}: ${reason}`);
    }
    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

// `keepMissing` records a 404 so that the same closed day isn't requested again.
export async function cachedDownload(key, url, { isValid = () => true, keepMissing = false, headers } = {}) {
  const path = join(CACHE_DIR, key);
  if (existsSync(`${path}.gz`)) return gunzipSync(readFileSync(`${path}.gz`));
  if (keepMissing && existsSync(`${path}.none`)) return null;

  const body = await download(url, headers);
  mkdirSync(dirname(path), { recursive: true });
  if (!body || !isValid(body)) {
    if (keepMissing) writeFileSync(`${path}.none`, '');
    return null;
  }
  writeFileSync(`${path}.gz`, gzipSync(body));
  return body;
}

export function writeCache(key, text) {
  const path = join(CACHE_DIR, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function readCache(key) {
  const path = join(CACHE_DIR, key);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

// Downloads filed under a date are only reused during that period, so older folders can go.
export function pruneFolders(parent, keep) {
  const path = join(CACHE_DIR, parent);
  if (!existsSync(path)) return;
  for (const name of readdirSync(path)) {
    if (name !== keep) rmSync(join(path, name), { recursive: true, force: true });
  }
}

export async function mapPool(items, size, delayMs, task) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await task(items[index], index);
        await sleep(delayMs);
      }
    }),
  );
  return results;
}
