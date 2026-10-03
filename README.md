# SafeNest: family safety addon for Nuvio (Cloudflare Workers, free)

Primary source: Common Sense Media (age + Violence / Sex / Language / Drinking-Drugs grid).
Fallbacks when it has nothing for a title: isitsafe.tv, Kids-In-Mind, IMDb parents guide.
Country age ratings come from TMDB (needs TMDB_API_KEY secret; AGE_COUNTRIES optional, e.g. US,GB,DE).

Header = overall label (green / orange / red) from the worst category.
Card = "Why age N+?" line, then only the important categories (score 2+), one main reason each.

## Files for GitHub (upload, do not paste)
src/index.js, src/parse.js, src/kim.js, src/extra.js, package.json, wrangler.toml
Name of the addon in Nuvio: change NAME at the top of src/index.js.

## Check one title
https://<your-worker>.workers.dev/debug/movie/tt1375666   (or /debug/series/tt...)
Shows what each source returned; rawSlice under the Common Sense entry shows the real page markup.
