// IsItSafe addon for Nuvio/Stremio on Cloudflare Workers.
// Sources: isitsafe.tv (main), Kids-In-Mind, IMDb parents guide, Common Sense Media, TMDB age ratings.
// Speed: answers within ~2.5s with whatever sources replied; slower sources finish in the
// background and are saved to the cache, so the next open is instant.
// Cache: memory -> KV (needs the "CACHE" KV binding; the Cache API is a no-op on workers.dev).

import { parseDetail } from './parse.js';
import { parseKim, slugify } from './kim.js';
import { parseImdbGuide, parseCsm } from './extra.js';

const SITE = 'https://isitsafe.tv';
const KIM = 'https://kids-in-mind.com';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const UA = 'isitsafe-nuvio-addon (personal project)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ICON = { SAFE: '🟢', 'SLIGHTLY SAFE': '🟠', UNSAFE: '🔴' };
const RANK = { SAFE: 0, 'SLIGHTLY SAFE': 1, UNSAFE: 2 };
const FRESH_FOUND = 7 * 86400e3;
const FRESH_MISSING = 6 * 3600e3;
const BUDGET_MS = Number(2500);   // max wait before answering with partial data
const FETCH_TIMEOUT_MS = 5000;
const KEY = 'v5';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANIFEST = {
  id: 'community.isitsafe.live.compact',
  version: '6.1.0',
  name: 'IsItSafe',
  description: 'Sex/nudity safety rating (isitsafe.tv, Kids-In-Mind, IMDb) plus age ratings.',
  resources: ['stream', 'meta'],
  types: ['movie', 'series'],
