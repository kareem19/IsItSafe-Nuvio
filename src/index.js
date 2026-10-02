// IsItSafe addon for Nuvio/Stremio on Cloudflare Workers.
// Sources: isitsafe.tv (main), Kids-In-Mind, IMDb parents guide, Common Sense Media,
// TMDB age ratings (several countries). Default style = compact.
// Caching: memory -> Cache API -> KV (optional). Stale results are served instantly
// and refreshed in the background. An optional cron job pre-warms popular titles.

import { parseDetail } from './parse.js';
import { parseKim, slugify } from './kim.js';
import { parseImdbGuide, parseCsm } from './extra.js';

const SITE = 'https://isitsafe.tv';
const KIM = 'https://kids-in-mind.com';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const UA = 'isitsafe-nuvio-addon (personal project)';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ICON = { SAFE: '🟢', 'SLIGHTLY SAFE': '🟡', UNSAFE: '🔴' };
const FRESH_FOUND = 7 * 86400e3;
const FRESH_MISSING = 6 * 3600e3;
const STYLES = ['compact', 'classic', 'detailed', 'minimal'];
const DEFAULT_STYLE = 'compact';
const KEY = 'v4';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const manifest = (style) => ({
  id: `community.isitsafe.live.${style}`,
  version: '4.0.0',
  name: style === DEFAULT_STYLE ? 'IsItSafe' : `IsItSafe (${style})`,
  description: 'Sex/nudity safety rating (isitsafe.tv, Kids-In-Mind, IMDb) plus age ratings.',
  resources: ['stream', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
});

// ---------- fetching ----------
async function fetchText(url, tried, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers } });
    tried?.push({ url, status: res.status });
    return res.ok ? await res.text() : null;
  } catch (e) {
    tried?.push({ url, error: String(e) });
    return null;
  }
}
async function getJson(url, cacheSeconds) {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA },
      ...(cacheSeconds ? { cf: { cacheTtl: cacheSeconds, cacheEverything: true } } : {}),
    });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const getCinemeta = async (type, imdb) => (await getJson(`${CINEMETA}/meta/${type}/${imdb}.json`, 86400))?.meta || null;
const yearOf = (meta) => Number(((meta.year || meta.releaseInfo || '') + '').match(/\d{4}/)?.[0]) || null;
const browser = { 'user-agent': BROWSER_UA, 'accept-language': 'en-US,en;q=0.9' };

async function findSite(type, meta, tried) {
  const base = slugify(meta.name || '');
  const y = yearOf(meta);
  const slugs = !base ? [] : type === 'series' ? [`${base}-tv`] : y ? [`${base}-${y}`, `${base}-${y - 1}`, `${base}-${y + 1}`] : [];
  for (const slug of slugs) {
    const html = await fetchText(`${SITE}/movie/${slug}`, tried);
    const rec = html && parseDetail(html, slug);
    if (rec) return rec;
  }
  return null;
}

async function findKim(meta, tried) {
  const y = yearOf(meta);
  if (!meta.name || !y) return null;
  const flat = meta.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!flat) return null;
  const urls = [`${KIM}/${flat[0]}/${flat}.htm`, `${KIM}/${flat[0]}/${flat}${String(y).slice(2)}.htm`];
  const search = await fetchText(`${KIM}/?s=${encodeURIComponent(meta.name)}`, tried, browser);
  if (search) {
    const found = [...search.matchAll(/href="(https?:\/\/(?:www\.)?kids-in-mind\.com\/(?:[a-z0-9]\/[a-z0-9_-]+\.htm|\?p=\d+))"/gi)].map((m) => m[1]);
    for (const u of found) if (!urls.includes(u)) urls.push(u);
  }
  for (const url of urls.slice(0, 5)) {
    const html = await fetchText(url, tried, browser);
    const rec = html && parseKim(html, meta.name, y, url);
    if (rec) return rec;
  }
  return null;
}

async function findImdb(imdb, tried) {
  const html = await fetchText(`https://www.imdb.com/title/${imdb}/parentalguide/`, tried, browser);
  return html ? parseImdbGuide(html) : null;
}

async function findCsm(type, meta, tried) {
  const slug = slugify(meta.name || '');
  if (!slug) return null;
  const url = `https://www.commonsensemedia.org/${type === 'series' ? 'tv' : 'movie'}-reviews/${slug}`;
  const html = await fetchText(url, tried, browser);
  return html ? parseCsm(html, meta.name, url) : null;
}

// Age ratings for several countries (TMDB). Needs TMDB_API_KEY; AGE_COUNTRIES optional, e.g. "US,GB,DE"
async function findCerts(type, imdb, env) {
  const key = env?.TMDB_API_KEY;
  if (!key) return [];
  const countries = (env.AGE_COUNTRIES || 'US,GB,DE').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const f = await getJson(`https://api.themoviedb.org/3/find/${imdb}?api_key=${key}&external_source=imdb_id`);
  const hit = type === 'series' ? f?.tv_results?.[0] : f?.movie_results?.[0];
  if (!hit) return [];
  const out = [];
  if (type === 'series') {
    const r = await getJson(`https://api.themoviedb.org/3/tv/${hit.id}/content_ratings?api_key=${key}`);
    for (const c of countries) {
      const v = r?.results?.find((x) => x.iso_3166_1 === c)?.rating;
      if (v) out.push({ c, r: v });
    }
  } else {
    const r = await getJson(`https://api.themoviedb.org/3/movie/${hit.id}/release_dates?api_key=${key}`);
    for (const c of countries) {
      const v = r?.results?.find((x) => x.iso_3166_1 === c)?.release_dates?.map((d) => d.certification).find(Boolean);
      if (v) out.push({ c, r: v });
    }
  }
  return out;
}

async function collect(type, imdb, meta, env, debug) {
  const t = debug ? { site: [], kim: [], imdb: [], csm: [] } : {};
  const [site, kim, guide, csm, certs] = await Promise.all([
    findSite(type, meta, t.site),
    type === 'movie' ? findKim(meta, t.kim) : null,
    findImdb(imdb, t.imdb),
    findCsm(type, meta, t.csm),
    findCerts(type, imdb, env),
  ]);
  return { data: { site, kim, imdb: guide, csm, certs }, tried: t };
}

// ---------- caching: memory -> Cache API -> KV ----------
const mem = new Map();
const cacheReq = (key) => new Request(`https://cache.isitsafe.local/${key}`);

async function readStore(key, env) {
  if (mem.has(key)) return mem.get(key);
  let rec = null;
  const c = globalThis.caches?.default;
  if (c) {
    const hit = await c.match(cacheReq(key));
    if (hit) rec = await hit.json();
  }
  if (!rec && env?.CACHE) rec = await env.CACHE.get(key, 'json');
  if (rec) {
    if (mem.size > 500) mem.clear();
    mem.set(key, rec);
  }
  return rec;
}

async function writeStore(key, rec, env, ctx) {
  if (mem.size > 500) mem.clear();
  mem.set(key, rec);
  const jobs = [];
  const c = globalThis.caches?.default;
  if (c) jobs.push(c.put(cacheReq(key), new Response(JSON.stringify(rec), { headers: { 'cache-control': 'public, max-age=2592000' } })));
  if (env?.CACHE) jobs.push(env.CACHE.put(key, JSON.stringify(rec), { expirationTtl: 30 * 86400 }));
  const all = Promise.all(jobs);
  if (ctx?.waitUntil) ctx.waitUntil(all);
  else await all;
}

const isAny = (d) => !!(d.site || d.kim || d.imdb || d.csm || d.certs?.length);
const isFresh = (rec) => Date.now() - rec.at < (isAny(rec.data) ? FRESH_FOUND : FRESH_MISSING);

async function refresh(type, imdb, env, ctx, meta) {
  meta = meta || (await getCinemeta(type, imdb));
  if (!meta) return null;
  const { data } = await collect(type, imdb, meta, env, false);
  await writeStore(`${KEY}/${type}/${imdb}`, { data, at: Date.now() }, env, ctx);
  return data;
}

// One entry per show/movie: all episodes of a series share it.
async function lookup(type, imdb, ctx, env, meta) {
  const rec = await readStore(`${KEY}/${type}/${imdb}`, env);
  if (rec) {
    if (!isFresh(rec) && ctx?.waitUntil) ctx.waitUntil(refresh(type, imdb, env, ctx, meta)); // serve stale, refresh later
    return rec.data;
  }
  return refresh(type, imdb, env, ctx, meta);
}

// Cron: pre-warm popular titles (needs the KV binding "CACHE"); 2 titles per run.
async function prewarm(env, ctx) {
  let list = await env.CACHE.get('popular:v1', 'json');
  if (!list || Date.now() - list.at > 86400e3) {
    const items = [];
    for (const [type, skips] of [['movie', [0, 100, 200]], ['series', [0, 100]]]) {
      for (const s of skips) {
        const r = await getJson(`${CINEMETA}/catalog/${type}/top${s ? `/skip=${s}` : ''}.json`);
        for (const m of r?.metas || []) if (/^tt\d+$/.test(m.id)) items.push({ type, id: m.id });
      }
    }
    if (items.length) await env.CACHE.put('popular:v1', JSON.stringify({ items, at: Date.now() }));
    return;
  }
  const L = list.items.length;
  const start = (Math.floor(Date.now() / 60000) * 2) % L;
  for (const i of [0, 1]) {
    const it = list.items[(start + i) % L];
    const rec = await env.CACHE.get(`${KEY}/${it.type}/${it.id}`, 'json');
    if (rec && isFresh(rec)) continue;
    await refresh(it.type, it.id, env, ctx);
  }
}

// ---------- verdict + formatting ----------
const kimRating = (s) => (s <= 1 ? 'SAFE' : s <= 4 ? 'SLIGHTLY SAFE' : 'UNSAFE');
const imdbRating = (sev) => (sev === 'None' ? 'SAFE' : sev === 'Mild' ? 'SLIGHTLY SAFE' : 'UNSAFE');
const bold = (s) => [...s].map((c) => (c >= 'A' && c <= 'Z' ? String.fromCodePoint(0x1d5d4 + c.charCodeAt(0) - 65) : c)).join('');
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));

function verdict(d) {
  if (d.site) {
    const reasons = d.site.reasons?.length ? d.site.reasons : [d.site.summary].filter(Boolean);
    return { rating: d.site.rating, est: false, src: 'isitsafe.tv', reasons, url: d.site.url };
  }
  if (d.kim) {
    return { rating: kimRating(d.kim.sex), est: true, src: 'Kids-In-Mind (estimated)', reasons: [d.kim.snippet || `Sex & nudity score ${d.kim.sex}/10`], url: d.kim.url };
  }
  if (d.imdb?.nudity) {
    return { rating: imdbRating(d.imdb.nudity), est: true, src: 'IMDb parents guide (estimated)', reasons: [`IMDb parents guide: Sex & Nudity ${d.imdb.nudity}`], url: SITE };
  }
  return null;
}

function render(style, d) {
  const v = verdict(d);
  const ages = (d.certs || []).map((x) => `${flag(x.c)} ${x.r}`);
  const kimChip = d.kim && `Sex ${d.kim.sex}/10`;
  const imdbChip = d.imdb?.nudity && `IMDb: ${d.imdb.nudity}`;
  const csmChip = d.csm && `CSM ${d.csm.age}+`;

  if (!v) {
    const chips = [imdbChip, csmChip, ...ages].filter(Boolean);
    if (!chips.length) return null;
    return { name: '⚪ NOT RATED', description: `No sex/nudity rating found\n${chips.join('  |  ')}`, url: d.csm?.url || SITE };
  }

  const differs = d.site && d.kim && kimRating(d.kim.sex) !== d.site.rating;
  const warn = differs ? `⚠️ Kids-In-Mind differs (sex ${d.kim.sex}/10)` : null;
  const head = `${ICON[v.rating]} ${v.rating}${v.est ? ' (est.)' : ''}`;
  let name = head;
  let lines;

  if (style === 'minimal') {
    lines = [[kimChip, imdbChip, csmChip, ...ages].filter(Boolean).join(' · ') || v.src];
  } else if (style === 'classic') {
    lines = [
      ...v.reasons.map((r) => `• ${r}`),
      warn,
      d.kim && `Kids-In-Mind: Sex ${d.kim.sex}/10 · Violence ${d.kim.violence}/10 · Language ${d.kim.language}/10`,
      imdbChip,
      csmChip && `Common Sense Media: age ${d.csm.age}+`,
      ages.length && `Age ratings: ${ages.join(' · ')}`,
      `Source: ${v.src}`,
    ];
  } else if (style === 'detailed') {
    name = `${ICON[v.rating]} ${bold(v.rating)}${v.est ? ' (est.)' : ''}`;
    const g = d.imdb;
    lines = [
      '━ NUDITY & SEX ━',
      ...v.reasons.map((r) => `• ${r}`),
      warn,
      d.kim || g || d.csm || ages.length ? '━ OTHER SOURCES ━' : null,
      d.kim && `Kids-In-Mind: Sex ${d.kim.sex}/10 · Violence ${d.kim.violence}/10 · Language ${d.kim.language}/10`,
      g && `IMDb guide: ${[g.nudity && `Sex & Nudity ${g.nudity}`, g.violence && `Violence ${g.violence}`, g.profanity && `Profanity ${g.profanity}`, g.alcohol && `Drugs ${g.alcohol}`, g.frightening && `Scary ${g.frightening}`].filter(Boolean).join(' · ')}`,
      d.csm && `Common Sense Media: age ${d.csm.age}+`,
      ages.length && `Age ratings: ${ages.join(' · ')}`,
      '━ SOURCE ━',
      v.src,
    ];
  } else {
    // compact (default): one line
    lines = [[v.reasons[0], kimChip, imdbChip, csmChip, ages.join('  ')].filter(Boolean).join('  |  '), warn];
  }
  return { name, description: lines.filter(Boolean).join('\n'), url: v.url };
}

// ---------- routing ----------
export default {
  async scheduled(event, env, ctx) {
    if (env.CACHE) ctx.waitUntil(prewarm(env, ctx));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    let { pathname } = new URL(request.url);

    let style = DEFAULT_STYLE;
    const seg = pathname.split('/')[1];
    if (STYLES.includes(seg)) {
      style = seg;
      pathname = '/' + pathname.split('/').slice(2).join('/');
    }

    if (pathname === '/') {
      return new Response('IsItSafe addon. Add /manifest.json to Nuvio (or /classic, /detailed, /minimal before it).', {
        headers: { 'content-type': 'text/plain', ...CORS },
      });
    }
    if (pathname === '/manifest.json') return json(manifest(style));

    // Diagnostic: /debug/movie/tt1375666  (live, bypasses the cache)
    const dbg = pathname.match(/^\/debug\/(movie|series)\/(tt\d+)$/);
    if (dbg) {
      const [, type, imdb] = dbg;
      const meta = await getCinemeta(type, imdb);
      if (!meta) return json({ error: 'Cinemeta has no such title' });
      const { data, tried } = await collect(type, imdb, meta, env, true);
      return json({ name: meta.name, year: yearOf(meta), tmdbKeySet: !!env?.TMDB_API_KEY, kvBound: !!env?.CACHE, tried, found: { site: !!data.site, kim: !!data.kim, imdb: data.imdb, csm: data.csm, certs: data.certs }, shown: render(style, data) });
    }

    const m = pathname.match(/^\/(stream|meta)\/(movie|series)\/(.+)\.json$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, resource, type, rawId] = m;
    const imdb = decodeURIComponent(rawId).split(':')[0];
    if (!/^tt\d+$/.test(imdb)) return json(resource === 'stream' ? { streams: [] } : { meta: null });
    const cc = { 'cache-control': 'public, max-age=3600' };

    if (resource === 'stream') {
      const d = await lookup(type, imdb, ctx, env);
      const out = d && render(style, d);
      if (!out) return json({ streams: [] }, 200, cc);
      return json({ streams: [{ name: out.name, description: out.description, externalUrl: out.url }] }, 200, cc);
    }

    const meta = await getCinemeta(type, imdb);
    if (!meta) return json({ meta: null });
    const d = await lookup(type, imdb, ctx, env, meta);
    const out = d && render(style, d);
    if (out) meta.description = `${out.name}\n${out.description}\n\n${meta.description || ''}`.trim();
    return json({ meta }, 200, cc);
  },
};
