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
| `index.html` | The home page (checker, directory, "How we score", questions, pricing, newsletter form) |
| `site.css` | The look of every page (home and Google pages): colours, fonts, spacing. Change a colour here and it changes everywhere |
| `fonts/` | The site's two own fonts (Archivo for headlines and grades, JetBrains Mono for small labels) and their free licence. Also used by `share-card.js` and `scripts/make-share-images.py` |
| `report.js` | Draws a result as HTML: the score dial, "What should I do?", warning signs, "Why this grade?" and the directory cards. Used by both `index.html` (in the browser) and `seo.js` (in the Worker) |
| `score.js` | Scoring engine. **The only source of truth for points, caps, grades and labels**, plus the plain-English text shown with them (`LEVELS` advice, `GROUPS` questions, `WHY` each check matters) |
| `worker.js` | Cloudflare Worker: link previews for shared results (`/?repo=owner/name`), `/api/subscribe` (Resend), `/mcp` (read-only connector Meta Muse uses to fetch Instagram posts) and old-address redirects |
| `seo.js` | Pages for Google, built by `worker.js` from `data/directory.json`: one page per graded repo (`/repo/owner/name`), the list `/repos`, and `/sitemap.xml` |
| `share-card.js` | Draws the "Download image" PNG of a result in the visitor's browser |
| `share/` | Link-preview pictures (one per grade and label, plus `default.png`). Made by `python3 scripts/make-share-images.py` |
| `instagram.js` | Posts the day's Instagram post through Meta's official API, once a day (cron in `wrangler.jsonc`). Token: `INSTAGRAM_TOKEN` Secret, renewed copy kept in the `INSTAGRAM` KV store. Check it at safetoclone.com/api/instagram/status |
| `hq.js` | Reads the Instagram post queue and pictures from the private HQ repo (`instagram/posts.json` there) with the read-only `HQ_GITHUB_TOKEN` Secret. `worker.js` serves today's pictures at `/ig-media/...` because Instagram needs a public link. Without the key it falls back to `data/instagram-posts.json` |
| `data/instagram-posts.json` | OLD copy of the Instagram post queue, used only until `HQ_GITHUB_TOKEN` is set. New posts go in HQ. Was: post queue (date, image or `images` for a carousel of 2 to 10 slides, caption). The daily job posts from it; `/mcp` also serves it. Hand-edited, unlike `directory.json` |
| `instagram/` | Post images, public at safetoclone.com/instagram/... (Instagram needs a public image URL) |
| `scripts/make-instagram-images.py` | Makes the post images: `python3 scripts/make-instagram-images.py` |
| `wrangler.jsonc` | Cloudflare settings (what to publish, `previews` for PR test sites) |
| `repos.txt` | List of repos in the directory, one per line |
| `scripts/build-directory.mjs` | Scores every repo in `repos.txt` and writes `data/directory.json` |
| `data/directory.json` | Generated every night. **Never edit by hand** |
| `.github/workflows/nightly.yml` | Runs the build script at 07:00 UTC and commits the result |
| `.github/workflows/test.yml` | Runs the tests on every push and PR |
| `test/*.test.mjs` | Tests: `node test/score.test.mjs && node test/mcp.test.mjs && node test/instagram.test.mjs && node test/share.test.mjs && node test/seo.test.mjs && node test/hq.test.mjs` |
| `robots.txt` | For search engines. The sitemap is made by `seo.js` (no `sitemap.xml` file) |
| `README.md` | For humans: what this is and how to deploy |

## If you change X, check Y

| You change | Also affected |
|---|---|
| `score.js` | The website checker, the nightly directory, the tests. Run the tests. If you change point weights, grade cut-offs or labels, update "How we score" and "What the grades mean" in `index.html` and the directory filter buttons. If you add or rename a check, add a line for it in `WHY` |
| `score.js` result fields | `scripts/build-directory.mjs` (copies chosen fields), `report.js` (draws them), the directory code in `index.html`, and the repo pages in `seo.js` |
| `report.js` or `site.css` | The home page and every Google page at once. Run `node test/seo.test.mjs` and look at both `/` and a `/repo/owner/name` page |
| The questions in `index.html` | The FAQ data at the top of `index.html` must match word for word (Google rule). `node test/share.test.mjs` checks it |
| `seo.js` or the `/repo/`, `/repos`, `/sitemap.xml` routes | `run_worker_first` in `wrangler.jsonc`, the directory links in `index.html`. Run `node test/seo.test.mjs && node test/hq.test.mjs` |
| `score.js` grades or labels | The share pictures: `SHARE_IMAGES` in `worker.js`, the list in `scripts/make-share-images.py` (rerun it), colours in `share-card.js` |
| Colours or fonts in `site.css` | Keep `share-card.js` and `scripts/make-share-images.py` (rerun it) in the same colours and fonts |
| `/?repo=` share links | `wireShare` and the `?repo=` auto-check in `index.html`, `homePage` in `worker.js`, `run_worker_first` in `wrangler.jsonc`. Run `node test/share.test.mjs` |
| `/api/subscribe` in `worker.js` | The newsletter form's `fetch("/api/subscribe")` in `index.html` |
| Domain or address | `worker.js` redirects, `SITE` in `seo.js`, `index.html` canonical link and footer, `robots.txt`, `README.md` |
| `repos.txt` | Nothing until the next nightly run (or run the workflow by hand). Then each new repo gets its own Google page and sitemap entry |
| `data/instagram-posts.json` | What gets posted next (real posts, public, no undo). Add the image first (edit `CARDS` in the image script, run it), keep dates `YYYY-MM-DD` (Ottawa time), captions under 2200 characters with at most 5 hashtags (Instagram's limit), run `node test/mcp.test.mjs` |
| `/mcp` tool names in `worker.js` | Any agent connected to it (e.g. Meta Muse) calls them by name |
| `instagram.js`, `hq.js` or the cron in `wrangler.jsonc` | Real posts on @safetoclone. Run `node test/instagram.test.mjs && node test/hq.test.mjs`. `/ig-media/` must only ever serve pictures of queued posts, never other HQ files. Don't also let Muse post from the queue, or posts double up |

## Ground rules

- The GitHub repo `emiliomadeit/safetoclone` is the only real copy of the code.
- Every merge to `main` redeploys the site automatically.
- No build step and no npm packages. Keep it that way unless there's a strong reason.
- No outside fonts: never link Google Fonts or another font service. Headline and label fonts live in `fonts/`; body text uses each device's own font (Apple's on Mac and iPhone). Keep new UI accessible: visible keyboard focus, text contrast of at least 4.5:1, and real buttons, links and `<details>` instead of clickable divs.
