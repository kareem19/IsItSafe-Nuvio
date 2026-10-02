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
  violence: new RegExp(`(?<=>)\\s*Violence\\s*${AMP}\\s*Sc