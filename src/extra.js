// Extra sources (best effort, regex only). Both can fail silently; /debug/... shows why.
import { slugify } from './kim.js';

const GUIDE_IDS = ['NUDITY', 'VIOLENCE', 'PROFANITY', 'ALCOHOL', 'FRIGHTENING'];
const SEV = '(None|Mild|Moderate|Severe)';
const NOT_OTHER_ID = '(?:(?!"id":"(?:NUDITY|VIOLENCE|PROFANITY|ALCOHOL|FRIGHTENING)")[\\s\\S])';

// IMDb parents guide: severity per category, e.g. { nudity: 'Mild', violence: 'Moderate' }
export function parseImdbGuide(html) {
  const out = {};
  for (const id of GUIDE_IDS) {
    let m = html.match(new RegExp(`"id":"${id}"${NOT_OTHER_ID}{0,500}?"severity"${NOT_OTHER_ID}{0,200}?"text":"${SEV}"`));
    if (!m) m = html.match(new RegExp(`sub-section-${id.toLowerCase()}[\\s\\S]{0,1500}?${SEV}`, 'i'));
    if (m) out[id.toLowerCase()] = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  }
  return Object.keys(out).length ? out : null;
}

// Common Sense Media: recommended age + content grid (Sex, Romance & Nudity etc., scored 0-5).
// The grid markup is not verified, so scores/text are best effort; /debug shows the raw HTML slice.
const AMP = '(?:&amp;|&)';
const GRID = {
  sex: new RegExp(`(?<=>)\\s*Sex,\\s*Romance\\s*${AMP}\\s*Nudity\\s*(?=<)`, 'i'),
  violence: new RegExp(`(?<=>)\\s*Violence\\s*${AMP}\\s*Scariness\\s*(?=<)`, 'i'),
  drugs: new RegExp(`(?<=>)\\s*Drinking,\\s*Drugs\\s*${AMP}\\s*Smoking\\s*(?=<)`, 'i'),
  language: /(?<=>)\s*Language\s*(?=<)/,
};
const NEXT_LABEL = new RegExp(
  `(?<=>)\\s*(?:Sex,\\s*Romance\\s*${AMP}\\s*Nudity|Violence\\s*${AMP}\\s*Scariness|Drinking,\\s*Drugs\\s*${AMP}\\s*Smoking|Language|Products\\s*${AMP}\\s*Purchases)\\s*(?=<)`,
  'i',
);

const plain = (h) =>
  h
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&#8217;|&rsquo;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

function gridItem(html, re, from = 0) {
  const m = re.exec(html.slice(from));
  if (!m) return null;
  const start = from + m.index + m[0].length;
  const rest = html.slice(start, start + 3000);
  const nx = rest.search(NEXT_LABEL);
  const seg = nx >= 0 ? rest.slice(0, nx) : rest.slice(0, 2000);

  // score 0-5: try explicit text/attributes first, then count "filled" dots
  let score = null;
  const explicit =
    seg.match(/(\d)\s*(?:out of|\/)\s*5/i) ||
    seg.match(/(?:data-(?:rating|score|value|level)|aria-valuenow)=["'](\d)["']/i) ||
    seg.match(/(?:rating|score|level|dots?)[-_ ]?(\d)\b/i);
  if (explicit) score = Number(explicit[1]);
  else {
    const filled = (seg.match(/class=["'][^"']*\b(?:filled|active|full|selected|on)\b[^"']*["']/gi) || []).length;
    if (filled >= 1 && filled <= 5) score = filled;
  }
  if (score !== null && (score < 0 || score > 5)) score = null;

  let text = plain(seg)
    .replace(/\d\s*(?:out of|\/)\s*5(?:\s*stars?)?/gi, '')
    .replace(/\b(?:read|show|see) more\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length < 12) text = '';
  return { score, text, index: from + m.index };
}

export function parseCsm(html, name, url) {
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '';
  if (!/common sense/i.test(title) || !slugify(title).includes(slugify(name))) return null;
  const age = (html.match(/Why\s+Age\s*(\d{1,2})\s*\+/i) || html.match(/\bage\s*(\d{1,2})\+/i))?.[1];
  if (!age) return null;

  const sex = gridItem(html, GRID.sex);
  const violence = gridItem(html, GRID.violence);
  const drugs = gridItem(html, GRID.drugs);
  const language = gridItem(html, GRID.language, violence?.index || 0);
  const pick = (g) => (g && (g.score !== null || g.text) ? { score: g.score, text: g.text } : null);
  return { age: Number(age), url, sex: pick(sex), violence: pick(violence), drugs: pick(drugs), language: pick(language), rawFrom: sex?.index ?? null };
}
