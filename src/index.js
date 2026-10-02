// IsItSafe addon for Nuvio/Stremio, running live on Cloudflare Workers.
// For each title opened in the app: IMDb id -> name/year (Cinemeta) -> isitsafe.tv page -> label.
// Every lookup is cached (found: 7 days, not found: 6 hours).

import { parseDetail } from './parse.js';

const SITE = 'https://isitsafe.tv';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const UA = 'isitsafe-nuvio-addon (personal project)';
const ICON = { SAFE: '🟢', 'SLIGHTLY SAFE': '🟡', UNSAFE: '🔴' };
const TTL_FOUND = 7 * 24 * 3600;
const TTL_MISSING = 6 * 3600;

const MANIFEST = {
  id: 'community.isitsafe.live',
  version: '2.0.0',
  name: 'IsItSafe',
  description: 'Shows isitsafe.tv ratings (Safe / Slightly Safe / Unsafe + reasons) for visual sex and nudity.',
  resources: ['stream', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
};

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const slugify = (n) =>
  n
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

async function getCinemeta(type, imdb) {
  try {
    const res = await fetch(`${CINEMETA}/meta/${type}/${imdb}.json`, { headers: { 'user-agent': UA } });
    if (!res.ok) return null;
    return (await res.json()).meta || null;
  } catch {
    return null;
  }
}

function candidateSlugs(type, meta) {
  const base = slugify(meta.name || '');
  if (!base) return [];
  if (type === 'series') return [`${base}-tv`];
  const y = Number(((meta.year || meta.releaseInfo || '') + '').match(/\d{4}/)?.[0]);
  if (!y) return [];
  return [`${base}-${y}`, `${base}-${y - 1}`, `${base}-${y + 1}`];
}

// Returns { rating, reasons, url, ... } or null. Cached per IMDb id.
async function lookup(type, imdb, ctx, meta) {
  const cache = globalThis.caches?.default;
  const key = new Request(`https://cache.isitsafe.local/${type}/${imdb}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return (await hit.json()).rec;
  }

  meta = meta || (await getCinemeta(type, imdb));
  let rec = null;
  if (meta) {
    for (const slug of candidateSlugs(type, meta)) {
      try {
        const res = await fetch(`${SITE}/movie/${slug}`, { headers: { 'user-agent': UA } });
        if (!res.ok) continue;
        rec = parseDetail(await res.text(), slug);
        if (rec) break;
      } catch {}
    }
  }

  if (cache) {
    const put = cache.put(
      key,
      new Response(JSON.stringify({ rec }), {
        headers: { 'cache-control': `public, max-age=${rec ? TTL_FOUND : TTL_MISSING}` },
      }),
    );
    ctx?.waitUntil ? ctx.waitUntil(put) : await put;
  }
  return rec;
}

function labelText(r) {
  const lines = r.reasons?.length ? r.reasons : [r.summary || 'No details'];
  return `${ICON[r.rating]} ${r.rating}\n${lines.map((l) => `• ${l}`).join('\n')}`;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const { pathname } = new URL(request.url);

    if (pathname === '/' ) {
      return new Response('IsItSafe addon. Add /manifest.json to Nuvio.', { headers: { 'content-type': 'text/plain', ...CORS } });
    }
    if (pathname === '/manifest.json') return json(MANIFEST);

    const m = pathname.match(/^\/(stream|meta)\/(movie|series)\/(.+)\.json$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, resource, type, rawId] = m;
    const id = decodeURIComponent(rawId);
    const imdb = id.split(':')[0];
    if (!/^tt\d+$/.test(imdb)) return json(resource === 'stream' ? { streams: [] } : { meta: null });

    if (resource === 'stream') {
      const r = await lookup(type, imdb, ctx);
      if (!r) return json({ streams: [] }, 200, { 'cache-control': 'max-age=3600' });
      return json(
        {
          streams: [
            {
              name: `isitsafe.tv\n${ICON[r.rating]} ${r.rating}`,
              description: `${labelText(r)}\n\nRated on visual sex & nudity only`,
              externalUrl: r.url,
            },
          ],
        },
        200,
        { 'cache-control': 'max-age=3600' },
      );
    }

    // meta: Cinemeta's metadata with the label added on top of the description
    const meta = await getCinemeta(type, imdb);
    if (!meta) return json({ meta: null });
    const r = await lookup(type, imdb, ctx, meta);
    if (r) meta.description = `${labelText(r)}\n\n${meta.description || ''}`.trim();
    return json({ meta }, 200, { 'cache-control': 'max-age=3600' });
  },
};
