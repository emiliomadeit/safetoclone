# SafeToClone: guide for AI helpers

SafeToClone (https://safetoclone.com) gives GitHub repos a safety grade (A to F) for people who don't code.
The owner is a beginner, so explain changes in plain language.

## Warning: this folder is the public website

`wrangler.jsonc` publishes the whole repo root (`"directory": "."`). Every file here is public at
safetoclone.com/<filename> unless it is listed in `.assetsignore`.
**When you add any file that isn't meant for visitors, add it to `.assetsignore` in the same change.**
Never commit secrets. `RESEND_API_KEY` lives only in Cloudflare as a Secret.

## What each file is

| File | Job |
|---|---|
| `index.html` | The whole website (checker, directory, "How we score", pricing, newsletter form) |
| `score.js` | Scoring engine. **The only source of truth for points, caps, grades and labels** |
| `worker.js` | Cloudflare Worker: `/api/subscribe` (Resend), `/mcp` (read-only connector Meta Muse uses to fetch Instagram posts) and old-address redirects |
| `instagram.js` | Posts the day's Instagram post through Meta's official API, once a day (cron in `wrangler.jsonc`). Token: `INSTAGRAM_TOKEN` Secret, renewed copy kept in the `INSTAGRAM` KV store. Check it at safetoclone.com/api/instagram/status |
| `data/instagram-posts.json` | Instagram post queue (date, image, caption). The daily job posts from it; `/mcp` also serves it. Hand-edited, unlike `directory.json` |
| `instagram/` | Post images, public at safetoclone.com/instagram/... (Instagram needs a public image URL) |
| `scripts/make-instagram-images.py` | Makes the post images: `python3 scripts/make-instagram-images.py` |
| `wrangler.jsonc` | Cloudflare settings (what to publish, `previews` for PR test sites) |
| `repos.txt` | List of repos in the directory, one per line |
| `scripts/build-directory.mjs` | Scores every repo in `repos.txt` and writes `data/directory.json` |
| `data/directory.json` | Generated every night. **Never edit by hand** |
| `.github/workflows/nightly.yml` | Runs the build script at 07:00 UTC and commits the result |
| `.github/workflows/test.yml` | Runs the tests on every push and PR |
| `test/*.test.mjs` | Tests: `node test/score.test.mjs && node test/mcp.test.mjs && node test/instagram.test.mjs` |
| `robots.txt`, `sitemap.xml` | For search engines |
| `README.md` | For humans: what this is and how to deploy |

## If you change X, check Y

| You change | Also affected |
|---|---|
| `score.js` | The website checker, the nightly directory, the tests. Run the tests. If you change point weights or labels, update the "How we score" section and the directory filter buttons in `index.html` |
| `score.js` result fields | `scripts/build-directory.mjs` (copies chosen fields) and the directory code in `index.html` |
| `/api/subscribe` in `worker.js` | The newsletter form's `fetch("/api/subscribe")` in `index.html` |
| Domain or address | `worker.js` redirects, `index.html` canonical link and footer, `robots.txt`, `sitemap.xml`, `README.md` |
| `repos.txt` | Nothing until the next nightly run (or run the workflow by hand) |
| `data/instagram-posts.json` | What gets posted next (real posts, public, no undo). Add the image first (edit `CARDS` in the image script, run it), keep dates `YYYY-MM-DD` (Ottawa time), captions under 2200 characters, run `node test/mcp.test.mjs` |
| `/mcp` tool names in `worker.js` | Any agent connected to it (e.g. Meta Muse) calls them by name |
| `instagram.js` or the cron in `wrangler.jsonc` | Real posts on @safetoclone. Run `node test/instagram.test.mjs`. Don't also let Muse post from the queue, or posts double up |

## Ground rules

- The GitHub repo `emiliomadeit/safetoclone` is the only real copy of the code.
- Every merge to `main` redeploys the site automatically.
- No build step and no npm packages. Keep it that way unless there's a strong reason.
