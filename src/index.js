// IsItSafe addon for Nuvio/Stremio on Cloudflare Workers.
// Sources: isitsafe.tv (main) + Kids-In-Mind (backup/extra) + TMDB age rating (optional).
// Every lookup is cached (found: 7 days, nothing found: 6 hours).
// Styles are chosen by the install link:  /manifest.json  /compact/manifest.json
//   /detailed/manifest.json  /minimal/manifest.json

import { parseDetail } from './parse.js';
import { parseKim, slugify } from './kim.js';

const SITE = 'https://isitsafe.tv';
const KIM = 'https://kids-in-mind.com';
const CINEMETA = 'https://v3-cinemeta.strem.io';
const UA = 'isitsafe-nuvio-addon (personal project)';
const ICON = { SAFE: '🟢', 'SLIGHTLY SAFE': '🟡', UNSAFE: '🔴' };
const TTL_FOUND = 7 * 24 * 3600;
const TTL_MISSING = 6 * 3600;
const STYLES = ['default', 'compact', 'detailed', 'minimal'];

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });

const manifest = (style) => ({
  id: `community.isitsafe.live.${style}`,
  version: '3.0.0',
  name: style === 'default' ? 'IsItSafe' : `IsItSafe (${style})`,
  description: 'Sex/nudity safety rating (isitsafe.tv + Kids-In-Mind) and age rating.',
  resources: ['stream', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
});

// ---------- data fetching ----------
async function getJson(url) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const getCinemeta = async (type, imdb) => (await getJson(`${CINEMETA}/meta/${type}/${imdb}.json`))?.meta || null;
const yearOf = (meta) => Number(((meta.year || meta.releaseInfo || '') + '').match(/\d{4}/)?.[0]) || null;

async function findSite(type, meta, tried) {
  const base = slugify(meta.name || '');
  const y = yearOf(meta);
  const slugs = !base ? [] : type === 'series' ? [`${base}-tv`] : y ? [`${base}-${y}`, `${base}-${y - 1}`, `${base}-${y + 1}`] : [];
  for (const slug of slugs) {
    try {
      const res = await fetch(`${SITE}/movie/${slug}`, { headers: { 'user-agent': UA } });
      const rec = res.ok ? parseDetail(await res.text(), slug) : null;
      tried?.push({ slug, status: res.status, ratingFound: !!rec });
      if (rec) return rec;
    } catch {}
  }
  return null;
}

async function findKim(meta, tried) {
  const y = yearOf(meta);
  if (!meta.name || !y) return null;
  const flat = meta.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const urls = [
    `${KIM}/${flat[0]}/${flat}.htm`,
    `${KIM}/${flat[0]}/${flat}${String(y).slice(2)}.htm`,
  ];
  try {
    const res = await fetch(`${KIM}/?s=${encodeURIComponent(meta.name)}`, { headers: { 'user-agent': UA } });
    const html = res.ok ? await res.text() : '';
    const found = [...html.matchAll(/href="(https?:\/\/(?:www\.)?kids-in-mind\.com\/(?:[a-z0-9]\/[a-z0-9_-]+\.htm|\?p=\d+))"/gi)].map((m) => m[1]);
    for (const u of found) if (!urls.includes(u)) urls.push(u);
  } catch {}
  for (const url of urls.slice(0, 5)) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA } });
      const rec = res.ok ? parseKim(await res.text(), meta.name, y, url) : null;
      tried?.push({ url, status: res.status, matched: !!rec });
      if (rec) return rec;
    } catch {}
  }
  return null;
}

async function findCert(type, imdb, key) {
  if (!key) return null;
  const f = await getJson(`https://api.themoviedb.org/3/find/${imdb}?api_key=${key}&external_source=imdb_id`);
  const hit = type === 'series' ? f?.tv_results?.[0] : f?.movie_results?.[0];
  if (!hit) return null;
  if (type === 'series') {
    const r = await getJson(`https://api.themoviedb.org/3/tv/${hit.id}/content_ratings?api_key=${key}`);
    return r?.results?.find((x) => x.iso_3166_1 === 'US')?.rating || null;
  }
  const r = await getJson(`https://api.themoviedb.org/3/movie/${hit.id}/release_dates?api_key=${key}`);
  const us = r?.results?.find((x) => x.iso_3166_1 === 'US');
  return us?.release_dates?.map((d) => d.certification).find(Boolean) || null;
}

async function collect(type, imdb, meta, env, debug) {
  const siteTried = debug ? [] : null;
  const kimTried = debug ? [] : null;
  const [site, kim, cert] = await Promise.all([
    findSite(type, meta, siteTried),
    type === 'movie' ? findKim(meta, kimTried) : null,
    findCert(type, imdb, env?.TMDB_API_KEY),
  ]);
  return { data: { site, kim, cert }, siteTried, kimTried };
}

async function lookup(type, imdb, ctx, env, meta) {
  const cache = globalThis.caches?.default;
  const key = new Request(`https://cache.isitsafe.local/v3/${type}/${imdb}`);
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return (await hit.json()).data;
  }
  meta = meta || (await getCinemeta(type, imdb));
  if (!meta) return null;
  const { data } = await collect(type, imdb, meta, env, false);
  const any = data.site || data.kim || data.cert;
  if (cache) {
    const put = cache.put(
      key,
      new Response(JSON.stringify({ data }), {
        headers: { 'cache-control': `public, max-age=${any ? TTL_FOUND : TTL_MISSING}` },
      }),
    );
    ctx?.waitUntil ? ctx.waitUntil(put) : await put;
  }
  return data;
}

// ---------- verdict + formatting ----------
const kimRating = (s) => (s <= 1 ? 'SAFE' : s <= 4 ? 'SLIGHTLY SAFE' : 'UNSAFE');
const bold = (s) => [...s].map((c) => (c >= 'A' && c <= 'Z' ? String.fromCodePoint(0x1d5d4 + c.charCodeAt(0) - 65) : c)).join('');

function verdict(d) {
  if (d.site) {
    const reasons = d.site.reasons?.length ? d.site.reasons : [d.site.summary].filter(Boolean);
    return { rating: d.site.rating, est: false, src: 'isitsafe.tv', reasons, url: d.site.url };
  }
  if (d.kim) {
    const reasons = [d.kim.snippet || `Sex & nudity score ${d.kim.sex}/10`];
    return { rating: kimRating(d.kim.sex), est: true, src: 'Kids-In-Mind (estimated)', reasons, url: d.kim.url };
  }
  return null;
}

function render(style, d) {
  const v = verdict(d);
  const kimLine = d.kim ? `Sex ${d.kim.sex}/10 · Violence ${d.kim.violence}/10 · Language ${d.kim.language}/10` : null;
  const age = d.cert || d.kim?.mpaa || null;

  if (!v) {
    if (!age) return null;
    return { name: '⚪ NOT RATED', description: `No sex/nudity rating found\nAge rating: ${age}`, url: SITE };
  }

  // flag disagreement between the two sources
  const differs = d.site && d.kim && kimRating(d.kim.sex) !== d.site.rating;
  const warn = differs ? `⚠️ Kids-In-Mind rates higher/lower (sex ${d.kim.sex}/10)` : null;
  const head = `${ICON[v.rating]} ${v.rating}${v.est ? ' (est.)' : ''}`;

  let name = head;
  let lines;
  if (style === 'minimal') {
    lines = [[age && `Age ${age}`, d.kim && `Sex ${d.kim.sex}/10`].filter(Boolean).join(' · ') || v.src];
  } else if (style === 'compact') {
    lines = [[v.reasons[0], d.kim && `Sex ${d.kim.sex}/10`, age].filter(Boolean).join('  |  '), warn];
  } else if (style === 'detailed') {
    name = `${ICON[v.rating]} ${bold(v.rating)}${v.est ? ' (est.)' : ''}`;
    lines = [
      '━ NUDITY & SEX ━',
      ...v.reasons.map((r) => `• ${r}`),
      warn,
      kimLine || age ? '━ OTHER SOURCES ━' : null,
      kimLine && `Kids-In-Mind: ${kimLine}`,
      age && `Age rating: ${age}`,
      '━ SOURCE ━',
      v.src,
    ];
  } else {
    lines = [...v.reasons.map((r) => `• ${r}`), warn, kimLine && `Kids-In-Mind: ${kimLine}`, age && `Age rating: ${age}`, `Source: ${v.src}`];
  }
  return { name, description: lines.filter(Boolean).join('\n'), url: v.url };
}

// ---------- routing ----------
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    let { pathname } = new URL(request.url);

    let style = 'default';
    const seg = pathname.split('/')[1];
    if (STYLES.includes(seg)) {
      style = seg;
      pathname = '/' + pathname.split('/').slice(2).join('/');
    }

    if (pathname === '/') {
      return new Response('IsItSafe addon. Add /manifest.json (or /compact, /detailed, /minimal before it) to Nuvio.', {
        headers: { 'content-type': 'text/plain', ...CORS },
      });
    }
    if (pathname === '/manifest.json') return json(manifest(style));

    // Diagnostic: /debug/movie/tt1375666
    const dbg = pathname.match(/^\/debug\/(movie|series)\/(tt\d+)$/);
    if (dbg) {
      const [, type, imdb] = dbg;
      const meta = await getCinemeta(type, imdb);
      if (!meta) return json({ error: 'Cinemeta has no such title' });
      const { data, siteTried, kimTried } = await collect(type, imdb, meta, env, true);
      return json({ name: meta.name, year: yearOf(meta), tmdbKeySet: !!env?.TMDB_API_KEY, siteTried, kimTried, cert: data.cert, shown: render(style, data) });
    }

    const m = pathname.match(/^\/(stream|meta)\/(movie|series)\/(.+)\.json$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, resource, type, rawId] = m;
    const imdb = decodeURIComponent(rawId).split(':')[0];
    if (!/^tt\d+$/.test(imdb)) return json(resource === 'stream' ? { streams: [] } : { meta: null });
    const cc = { 'cache-control': 'max-age=3600' };

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
