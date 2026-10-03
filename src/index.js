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
const KEY = 'v7';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' };
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANIFEST = {
  id: 'community.isitsafe.live.compact',
  version: '6.3.0',
  name: 'IsItSafe',
  description: 'Sex/nudity safety rating (isitsafe.tv, Kids-In-Mind, IMDb) plus age ratings.',
  resources: ['stream', 'meta'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: [],
};

// ---------- fetching ----------
async function fetchText(url, tried, headers = {}) {
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
  if (!base) return null;
  const tryOne = async (slug) => {
    const html = await fetchText(`${SITE}/movie/${slug}`, tried);
    return html && parseDetail(html, slug);
  };
  if (type === 'series') return tryOne(`${base}-tv`);
  if (!y) return null;
  const first = await tryOne(`${base}-${y}`);
  if (first) return first;
  const rest = await Promise.all([tryOne(`${base}-${y - 1}`), tryOne(`${base}-${y + 1}`)]);
  return rest.find(Boolean) || null;
}

async function findKim(meta, tried) {
  const y = yearOf(meta);
  if (!meta.name || !y) return null;
  const flat = meta.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!flat) return null;
  const direct = [`${KIM}/${flat[0]}/${flat}.htm`, `${KIM}/${flat[0]}/${flat}${String(y).slice(2)}.htm`];
  const [search, ...pages] = await Promise.all([
    fetchText(`${KIM}/?s=${encodeURIComponent(meta.name)}`, tried, browser),
    ...direct.map((u) => fetchText(u, tried, browser)),
  ]);
  for (let i = 0; i < pages.length; i++) {
    const rec = pages[i] && parseKim(pages[i], meta.name, y, direct[i]);
    if (rec) return rec;
  }
  if (!search) return null;
  const found = [...search.matchAll(/href="(https?:\/\/(?:www\.)?kids-in-mind\.com\/(?:[a-z0-9]\/[a-z0-9_-]+\.htm|\?p=\d+))"/gi)]
    .map((m) => m[1])
    .filter((u) => !direct.includes(u))
    .slice(0, 3);
  const more = await Promise.all(found.map((u) => fetchText(u, tried, browser)));
  for (let i = 0; i < more.length; i++) {
    const rec = more[i] && parseKim(more[i], meta.name, y, found[i]);
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
  if (!html) return null;
  if (tried) { // debug only: raw HTML around the content grid
    const i = html.search(/Sex,\s*Romance/i);
    tried.push({ gridLabelFound: i >= 0, htmlLength: html.length, rawSlice: i >= 0 ? html.slice(Math.max(0, i - 300), i + 1500) : null });
  }
  const rec = parseCsm(html, meta.name, url);
  if (rec) delete rec.rawFrom;
  return rec;
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

// Starts all sources in parallel. `data` fills in as each one finishes; `done` resolves when all have.
function collect(type, imdb, meta, env, tried) {
  const data = { site: null, kim: null, imdb: null, csm: null, certs: [] };
  const run = (p, set) => p.then(set).catch(() => {});
  const done = Promise.all([
    run(findSite(type, meta, tried?.site), (v) => (data.site = v)),
    type === 'movie' ? run(findKim(meta, tried?.kim), (v) => (data.kim = v)) : null,
    run(findImdb(imdb, tried?.imdb), (v) => (data.imdb = v)),
    run(findCsm(type, meta, tried?.csm), (v) => (data.csm = v)),
    run(findCerts(type, imdb, env), (v) => (data.certs = v || [])),
  ]);
  return { data, done };
}

// ---------- cache: memory -> KV ----------
const mem = new Map();
const inflight = new Map();

async function readStore(key, env) {
  if (mem.has(key)) return mem.get(key);
  let rec = null;
  try {
    if (env?.CACHE) rec = await env.CACHE.get(key, { type: 'json', cacheTtl: 600 });
  } catch {}
  if (rec) {
    if (mem.size > 500) mem.clear();
    mem.set(key, rec);
  }
  return rec;
}

async function writeStore(key, rec, env) {
  if (mem.size > 500) mem.clear();
  mem.set(key, rec);
  try {
    if (env?.CACHE) await env.CACHE.put(key, JSON.stringify(rec), { expirationTtl: 30 * 86400 });
  } catch {} // e.g. free-plan daily write limit reached: memory cache still works
}

const isAny = (d) => !!(d.site || d.kim || d.imdb || d.csm || d.certs?.length);
const isFresh = (rec) => Date.now() - rec.at < (isAny(rec.data) ? FRESH_FOUND : FRESH_MISSING);
const keyOf = (type, imdb) => `${KEY}/${type}/${imdb}`;

// Fetch everything for a title and save it (used for stale refresh and pre-warming).
async function refresh(type, imdb, env, meta) {
  const key = keyOf(type, imdb);
  meta = meta || (await getCinemeta(type, imdb));
  if (!meta) return null;
  const { data, done } = collect(type, imdb, meta, env);
  await done;
  await writeStore(key, { data, at: Date.now() }, env);
  return data;
}

// Returns { data, partial }. Cached -> instant. Otherwise waits at most BUDGET_MS.
async function lookup(type, imdb, ctx, env, meta) {
  const key = keyOf(type, imdb);
  const rec = await readStore(key, env);
  if (rec) {
    if (!isFresh(rec) && ctx?.waitUntil) ctx.waitUntil(refresh(type, imdb, env, meta)); // serve stale, refresh later
    return { data: rec.data, partial: false };
  }

  let job = inflight.get(key);
  if (!job) {
    meta = meta || (await getCinemeta(type, imdb));
    if (!meta) return null;
    const { data, done } = collect(type, imdb, meta, env);
    const finish = done.then(async () => {
      await writeStore(key, { data: { ...data }, at: Date.now() }, env);
      inflight.delete(key);
    });
    job = { data, done, finish };
    inflight.set(key, job);
    if (ctx?.waitUntil) ctx.waitUntil(finish);
  }
  const state = await Promise.race([job.done.then(() => 'done'), sleep(BUDGET_MS).then(() => 'timeout')]);
  if (state === 'done' && !ctx?.waitUntil) await job.finish;
  return { data: { ...job.data }, partial: state === 'timeout' };
}

// Cron: pre-warm popular titles, 1 per run (needs the KV binding).
async function prewarm(env) {
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
  const base = Math.floor(Date.now() / 120000); // every 2 minutes
  for (let i = 0; i < L; i++) { // first title that still needs data
    const it = list.items[(base + i) % L];
    const rec = await env.CACHE.get(keyOf(it.type, it.id), 'json');
    if (rec && isFresh(rec)) continue;
    await refresh(it.type, it.id, env);
    return;
  }
}

// ---------- verdict + formatting ----------
const kimRating = (s) => (s <= 1 ? 'SAFE' : s <= 4 ? 'SLIGHTLY SAFE' : 'UNSAFE');
const csmRating = (n) => (n <= 1 ? 'SAFE' : n <= 3 ? 'SLIGHTLY SAFE' : 'UNSAFE');
const imdbRating = (sev) => (sev === 'None' ? 'SAFE' : sev === 'Mild' ? 'SLIGHTLY SAFE' : 'UNSAFE');
const flag = (cc) => String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
const bold = (s) => [...s].map((c) => (c >= 'A' && c <= 'Z' ? String.fromCodePoint(0x1d5d4 + c.charCodeAt(0) - 65) : c)).join('');
const clip = (s, n) => (s.length > n ? s.slice(0, n).replace(/\s+\S*$/, '') + '…' : s);

// Brief + complete: whole reasons only, most important first, no "…" cut-offs.
const WEIGHTS = [
  [/explicit|graphic|full[- ]frontal|sex scene|intercourse|masturbat|orgy|porn|rape/i, 4],
  [/nudity|nude|topless|breast|naked|genital|buttock|rear|bare/i, 3],
  [/sexual|sex |kiss|cleavage|lingerie|innuendo|underwear/i, 2],
];
const weigh = (r) => WEIGHTS.find(([re]) => re.test(r))?.[1] ?? 1;
const shorten = (r, max = 110) => {
  r = r.trim().replace(/\s+/g, ' ');
  if (r.length <= max) return r;
  const sentence = r.match(/^.*?[.!?](?=\s|$)/)?.[0];
  if (sentence && sentence.length <= max) return sentence;
  const cut = r.slice(0, max);
  const i = Math.max(cut.lastIndexOf(', '), cut.lastIndexOf('; '), cut.lastIndexOf(' - '));
  return i >= 40 ? cut.slice(0, i) : r; // never cut mid-sentence
};
function briefReasons(reasons, max = 120) {
  const ranked = reasons
    .map((r, i) => ({ r: r.trim().replace(/[.\s]+$/, ''), i }))
    .filter((x) => x.r)
    .map((x) => ({ ...x, w: weigh(x.r) }))
    .sort((a, b) => b.w - a.w || a.i - b.i);
  const picked = [];
  let len = 0;
  for (const x of ranked) {
    const t = shorten(x.r);
    const add = (picked.length ? 3 : 0) + t.length;
    if (picked.length && len + add > max) continue;
    picked.push({ t, i: x.i });
    len += add;
  }
  return picked.sort((a, b) => a.i - b.i).map((p) => p.t).join(' · ');
}

// Age ratings -> rough sex/nudity rating (weak signal, only used when no content source responded)
const AGE_WORDS = {
  G: 'SAFE', PG: 'SAFE', U: 'SAFE', 'TV-Y': 'SAFE', 'TV-Y7': 'SAFE', 'TV-Y7-FV': 'SAFE', 'TV-G': 'SAFE', 'TV-PG': 'SAFE',
  'PG-13': 'SLIGHTLY SAFE', 'TV-14': 'SLIGHTLY SAFE',
  R: 'UNSAFE', 'TV-MA': 'UNSAFE', 'NC-17': 'UNSAFE', X: 'UNSAFE',
};
const byAge = (n) => (n <= 11 ? 'SAFE' : n <= 14 ? 'SLIGHTLY SAFE' : 'UNSAFE');
function certRating(r) {
  const k = String(r).toUpperCase().trim();
  if (AGE_WORDS[k]) return AGE_WORDS[k];
  const n = parseInt(k.replace(/[^0-9]/g, ''), 10); // 12, 12A, 16, 18, R18 ...
  return Number.isNaN(n) ? null : byAge(n);
}

// Final label: isitsafe.tv if available, otherwise estimated from the other sources.
function verdict(d, imdbId) {
  if (d.site) return { rating: d.site.rating, est: false, url: d.site.url };

  const votes = [];
  const basis = [];
  if (d.kim) { votes.push(kimRating(d.kim.sex)); basis.push('Kids-In-Mind'); }
  if (d.csm?.sex?.score != null) { votes.push(csmRating(d.csm.sex.score)); basis.push('Common Sense'); }
  if (d.imdb?.nudity) { votes.push(imdbRating(d.imdb.nudity)); basis.push('IMDb'); }
  if (votes.length) {
    // sources disagree -> take the more cautious one
    const rating = votes.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
    return { rating, est: true, basis, url: d.csm?.url || d.kim?.url || `https://www.imdb.com/title/${imdbId}/parentalguide/` };
  }

  // only age ratings available (Common Sense Media + country ratings): most common rating, ties -> more cautious
  const ageVotes = [...(d.certs || []).map((x) => certRating(x.r)), d.csm ? byAge(d.csm.age) : null].filter(Boolean);
  if (!ageVotes.length) return null;
  const counts = {};
  for (const r of ageVotes) counts[r] = (counts[r] || 0) + 1;
  const rating = Object.keys(counts).sort((x, y) => counts[y] - counts[x] || RANK[y] - RANK[x])[0];
  return { rating, est: true, basis: ['age ratings'], url: d.csm?.url || SITE };
}

// Layout (3 lines under a bold coloured title):
//   line 1: first available of isitsafe.tv / Kids-In-Mind / IMDb details (no source name, max ~2 lines)
//   line 2: the next available one (no source name)
//   line 3: everything else: remaining source, Common Sense age, country flags + age ratings
function render(d, imdbId) {
  const v = verdict(d, imdbId);
  const ages = (d.certs || []).map((x) => `${flag(x.c)} ${x.r}`).join('  ');
  const g = d.imdb;
  const imdbText = g && [g.nudity && `Sex & Nudity ${g.nudity}`, g.violence && `Violence ${g.violence}`].filter(Boolean).join(' · ');

  // content sources in priority order, shown WITHOUT their names
  const content = [];
  if (d.site) {
    const reasons = d.site.reasons?.length ? d.site.reasons : [d.site.summary].filter(Boolean);
    if (reasons.length) content.push({ id: 'site', text: briefReasons(reasons), chip: null });
  }
  const cs = d.csm?.sex;
  if (cs && (cs.text || cs.score != null)) {
    const short = cs.text ? shorten(cs.text) : '';
    const text = short ? (/[.!?"')]$/.test(short) ? short : `${short}…`) : `Sex, romance & nudity ${cs.score}/5`;
    content.push({ id: 'csm', text, chip: cs.score != null ? `CSM Sex ${cs.score}/5` : null });
  }
  if (d.kim) {
    const scores = `Sex ${d.kim.sex}/10 · Violence ${d.kim.violence}/10 · Language ${d.kim.language}/10`;
    if (!d.site && !cs && d.kim.snippet) content.push({ id: 'kimtext', text: shorten(d.kim.snippet), chip: null });
    content.push({ id: 'kim', text: scores, chip: `Sex ${d.kim.sex}/10` });
  }
  if (imdbText) content.push({ id: 'imdb', text: imdbText, chip: g.nudity ? `IMDb: ${g.nudity}` : null });

  const shown = content.slice(0, 2);
  const lines = shown.map((c) => c.text);
  // last line: whatever is left (short chips), then the age, with country flags and ratings
  const rest = content.slice(2).map((c) => c.chip).filter(Boolean);
  if (d.csm) rest.push(`CSM ${d.csm.age}+`);
  if (ages) rest.push(ages);
  if (rest.length) lines.push(rest.join('  |  '));

  if (!v) {
    if (!lines.length) return null;
    return { name: `⚪ ${bold('NOT RATED')}`, description: ['No sex/nudity rating found', ...lines].join('\n'), url: d.csm?.url || SITE };
  }
  return { name: `${ICON[v.rating]} ${bold(v.rating)}${v.est ? ' (est.)' : ''}`, description: lines.join('\n'), url: v.url };
}

// ---------- routing ----------
export default {
  async scheduled(event, env, ctx) {
    if (env.CACHE) ctx.waitUntil(prewarm(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    let { pathname } = new URL(request.url);
    // old install links with a style prefix keep working
    pathname = pathname.replace(/^\/(compact|classic|detailed|minimal)(?=\/)/, '');

    if (pathname === '/') {
      return new Response('IsItSafe addon. Add /manifest.json to Nuvio.', { headers: { 'content-type': 'text/plain', ...CORS } });
    }
    if (pathname === '/manifest.json') return json(MANIFEST);

    // Diagnostic: /debug/movie/tt1375666  (runs every source live and shows cache status)
    const dbg = pathname.match(/^\/debug\/(movie|series)\/(tt\d+)$/);
    if (dbg) {
      const [, type, imdb] = dbg;
      const meta = await getCinemeta(type, imdb);
      if (!meta) return json({ error: 'Cinemeta has no such title' });
      const rec = await readStore(keyOf(type, imdb), env);
      const tried = { site: [], kim: [], imdb: [], csm: [] };
      const t0 = Date.now();
      const { data, done } = collect(type, imdb, meta, env, tried);
      await done;
      return json({
        name: meta.name,
        year: yearOf(meta),
        tmdbKeySet: !!env?.TMDB_API_KEY,
        kvBound: !!env?.CACHE,
        cachedBeforeThisCall: rec ? { ageMinutes: Math.round((Date.now() - rec.at) / 60000) } : null,
        liveFetchMs: Date.now() - t0,
        tried,
        found: { site: !!data.site, kim: !!data.kim, imdb: data.imdb, csm: data.csm, certs: data.certs },
        shown: render(data, imdb),
      });
    }

    const m = pathname.match(/^\/(stream|meta)\/(movie|series)\/(.+)\.json$/);
    if (!m) return json({ error: 'not found' }, 404);
    const [, resource, type, rawId] = m;
    const imdb = decodeURIComponent(rawId).split(':')[0];
    if (!/^tt\d+$/.test(imdb)) return json(resource === 'stream' ? { streams: [] } : { meta: null });

    if (resource === 'stream') {
      const r = await lookup(type, imdb, ctx, env);
      const cc = { 'cache-control': r?.partial ? 'no-store' : 'public, max-age=60' };
      const out = r && render(r.data, imdb);
      if (!out) return json({ streams: [] }, 200, { 'cache-control': 'no-store' });
      return json({ streams: [{ name: out.name, description: out.description, externalUrl: out.url }] }, 200, cc);
    }

    const meta = await getCinemeta(type, imdb);
    if (!meta) return json({ meta: null });
    const r = await lookup(type, imdb, ctx, env, meta);
    const out = r && render(r.data, imdb);
    if (out) meta.description = `${out.name}\n${out.description}\n\n${meta.description || ''}`.trim();
    return json({ meta }, 200, { 'cache-control': r?.partial ? 'no-store' : 'public, max-age=60' });
  },
};
