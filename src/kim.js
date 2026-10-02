// Second source: kids-in-mind.com (sex/nudity, violence, language scored 0-10).
// Regex-only parsing keeps CPU time low on the free Workers plan.

export const slugify = (n) =>
  n
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’`]/g, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const toText = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');

// Page header looks like: "Inception | 2010 | PG-13 | - 1.7.4"  (sex . violence . language)
// Returns null unless the page is for the wanted title and year (+/- 1).
export function parseKim(html, title, year, url) {
  const text = toText(html);
  const h = text.match(/(\d{4})\s*\|\s*([A-Za-z0-9-]+)\s*\|\s*[-–]\s*(\d{1,2})\.(\d{1,2})\.(\d{1,2})/);
  if (!h) return null;
  if (Math.abs(Number(h[1]) - Number(year)) > 1) return null;
  const before = text.slice(Math.max(0, h.index - 120), h.index);
  if (!slugify(before).endsWith(slugify(title))) return null;

  const sexMatch = text.match(/SEX\/NUDITY\s+(\d{1,2})\s*[-–]\s*(.+?)(?=\s+advertisement|\s+VIOLENCE\/GORE)/i);
  const sex = sexMatch ? Number(sexMatch[1]) : Number(h[3]);
  let snippet = sexMatch ? sexMatch[2].trim() : '';
  if (snippet.length > 150) snippet = snippet.slice(0, 150).replace(/\s+\S*$/, '') + '…';

  return {
    sex,
    violence: Number(h[4]),
    language: Number(h[5]),
    mpaa: h[2],
    snippet,
    url,
  };
}
