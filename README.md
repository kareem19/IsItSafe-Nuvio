# IsItSafe live addon (Cloudflare Workers, free)

Sources: isitsafe.tv (main), Kids-In-Mind, IMDb parents guide, Common Sense Media, TMDB age ratings.
If isitsafe.tv has nothing, the label is estimated from the other sources and marked "(est.)".

## Files for GitHub
src/index.js, src/parse.js, src/kim.js, src/extra.js, package.json, wrangler.toml

## Step 1: create the cache (needed for speed)
1. Cloudflare dashboard > Storage & Databases > KV > Create a namespace, name: isitsafe-cache.
2. Copy its ID.
3. In GitHub, edit wrangler.toml, replace PASTE_YOUR_KV_ID_HERE with the ID, commit.
   Cloudflare redeploys automatically.

## Step 2 (optional): age ratings
Worker > Settings > Variables and secrets:
- Secret TMDB_API_KEY = your TMDB key
- Text AGE_COUNTRIES = US,GB,DE (any country codes)

## Install
https://<your-worker>.workers.dev/manifest.json

## Check caching and sources for one title
https://<your-worker>.workers.dev/debug/movie/tt1375666
Shows: kvBound (should be true), cachedBeforeThisCall (null the first time, then a number),
liveFetchMs, and the HTTP status of every source.
