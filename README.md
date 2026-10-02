# IsItSafe live addon (Cloudflare Workers, free)

Looks up each title live on isitsafe.tv when you open it in Nuvio, and caches every result
(found: 7 days, not found: 6 hours). No API keys needed.

## Deploy (no command line needed)
1. Push this folder to a GitHub repo.
2. Make a free account at cloudflare.com.
3. Dashboard > Workers & Pages > Create > Import a repository > pick your repo > Deploy.
4. You get a link like `https://isitsafe-addon.<name>.workers.dev`.
5. In Nuvio add `https://isitsafe-addon.<name>.workers.dev/manifest.json` as an addon.
Every push to GitHub redeploys automatically.

## Check first
Run this in a terminal; you should see a line containing "SAFE":
curl -s https://isitsafe.tv/movie/the-odyssey-2026 | grep -io 'og:title[^>]*'
If nothing shows, the site fills its pages with JavaScript and the parser must use its data source instead.
