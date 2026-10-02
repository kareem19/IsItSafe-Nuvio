import { load } from 'cheerio/slim';

// Parses one isitsafe.tv title page. Returns null if no rating is found.
export function parseDetail(html, slug) {
  const $ = load(html);

  const ogTitle = $('meta[property="og:title"]').attr('content') || '';
  const m = ogTitle.match(/[—–-]\s*(SLIGHTLY SAFE|UNSAFE|SAFE)\s*$/i);
  if (!m) return null;
  const rating = m[1].toUpperCase();

  const name = $('h1').first().text().trim();
  const summary = $('h1').first().next().text().trim();

  const heading = $('h2')
    .filter((_, e) => /sex\s*&\s*nudity/i.test($(e).text()))
    .first();
  let reasons = [];
  let node = heading;
  for (let i = 0; i < 3 && !reasons.length && node.length; i++, node = node.parent()) {
    reasons = node
      .nextUntil('h2')
      .find('li')
      .addBack('li')
      .map((_, li) => $(li).text().trim())
      .get()
      .filter((t) => t && !/^show spoilers/i.test(t));
  }

  return { name, rating, summary, reasons, url: `https://isitsafe.tv/movie/${slug}` };
}
