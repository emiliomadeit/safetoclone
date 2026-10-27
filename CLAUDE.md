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
| `tokens.css` | Every colour, font, size and space the site uses (light and dark mode). Change a colour here and it changes everywhere. Loaded by `site.css` |
| `base.css` | Basic rules every page starts from (from the Hallmark design skill). Loaded by `site.css` |
| `site.css` | The layout of every page (home and Google pages): colours, fonts, spacing. Change a colour here and it changes everywhere |
| `fonts/` | The site's two own fonts (Archivo for headlines and grades, JetBrains Mono for small labels) and their free licence. Also used by `share-card.js` and `scripts/make-share-images.py` |
| `report.js` | Draws a result as HTML: the score dial, "What should I do?", warning signs, "Why this grade?" and the directory cards. Used by both `index.html` (in the browser) and `seo.js` (in the Worker) |
| `score.js` | Scoring engine. **The only source of truth for points, caps, grades and labels**, plus the plain-English text shown with them (`LEVELS` advice, `GROUPS` questions, `WHY` each check matters). Five areas, each with its own letter (`areaGrades`); the overall grade is at most one letter better than the weakest area. "Security habits" comes from OpenSSF Scorecard (api.scorecard.dev). When Scorecard has no "known security holes" answer, `score.js` reads the lock files in the main folder (package-lock.json, requirements.txt pins, poetry.lock, uv.lock, Cargo.lock, go.mod) and looks the parts up in OSV (api.osv.dev). With no data at all that area is left out, not counted as zero |
| `worker.js` | Cloudflare Worker: link previews for shared results (`/?repo=owner/name`), `/api/subscribe` (Resend), `/api/osv` (passes the home-page checker's list of parts to OSV, nothing else), `/mcp` (read-only connector: grades for AI agents, approved posts for Meta Muse to see), the Instagram robot (every 30 minutes, posts only what `batch.js` allows, emails `ALERT_EMAIL` or hello@ through Resend when it skips a post Emile should know about), `/ig-media/` (approved Instagram pictures from HQ), `/api/instagram/status`, `/api/instagram/results` (numbers for HQ's daily task, kept 30 minutes) and old-address redirects |
| `seo.js` | Pages for Google, built by `worker.js` from `data/directory.json`: one page per graded repo (`/repo/owner/name`), the list `/repos`, and `/sitemap.xml` |
| `share-card.js` | Draws the "Download image" PNG of a result in the visitor's browser |
| `share/` | Link-preview pictures (one per grade and label, plus `default.png`). Made by `python3 scripts/make-share-images.py` |
| `batch.js` | **The Instagram approval lock.** A post goes out only from an approved week in HQ (`instagram/batches/<Monday>.json`) with Emile's recorded tap, whose fingerprint (SHA-256 of what people see) and picture fingerprints still match, not paused, held or dropped, while HQ's daily check (`ops/nightly/<date>.md`, `pass`) is under 36 hours old, from the post's time until 3 hours after, and right before posting every grade, label, warning sign and count in the post is still true in today's `data/directory.json` (`claimsProblem`). `fingerprint()` and `checkClaim()` must stay identical to HQ's `instagram/_tools/common.py` |
| `instagram.js` | Posts to Instagram through Meta's official API (single pictures and carousels) and reads results (`listing`, `metrics`; needs the `instagram_business_manage_insights` permission). Token: `INSTAGRAM_TOKEN` Secret, renewed weekly into the `INSTAGRAM` KV store; a newly pasted Secret replaces the renewed copy. Check it at safetoclone.com/api/instagram/status |
| `newsletter.js` | The newsletter robot's rules and the email's look. The Sunday issue lives in HQ (`newsletter/issues/<date>.json`, see `newsletter/README.md` there). `worker.js` emails Emile one test copy of a `ready` issue, then sends an approved one once through Resend Broadcasts in its window (time, Ottawa, default 09:00, up to 3 hours late), only if it's unchanged since his yes and its grades still hold. Status at `/api/newsletter/status`. Optional Secret/variable `RESEND_SEGMENT_ID` picks the Resend segment (otherwise the only one) |
| `hq.js` | Reads the weekly batches, the daily check and pictures from the private HQ repo with the read-only `HQ_GITHUB_TOKEN` Secret. If GitHub is down nothing posts; there is no fallback copy, on purpose. **Posts, captions and pictures live in HQ, not here** (see `instagram/README.md` in HQ) |
| `stats.js` | Rough visitor counts per day (home, repo pages, checks, shares, signups, `agent_mcp` = AI agents asking `/mcp` for grades) and where visitors came from (`?ref=reddit`, `?ref=ig` tags or the linking site). No personal data. Stored in the `INSTAGRAM` KV store as `stats:YYYY-MM-DD`. Read at safetoclone.com/api/stats |
| `wrangler.jsonc` | Cloudflare settings (what to publish, `previews` for PR test sites) |
| `repos.txt` | List of repos in the directory, one per line |
| `scripts/build-directory.mjs` | Scores every repo in `repos.txt` and writes `data/directory.json` |
| `data/directory.json` | Generated every night. **Never edit by hand** |
| `.github/workflows/nightly.yml` | Runs the build script at 07:00 UTC and commits the result |
| `.github/workflows/test.yml` | Runs the tests on every push and PR |
| `test/*.test.mjs` | Tests: `node test/score.test.mjs && node test/mcp.test.mjs && node test/instagram.test.mjs && node test/share.test.mjs && node test/seo.test.mjs && node test/hq.test.mjs && node test/stats.test.mjs && node test/batch.test.mjs && node test/newsletter.test.mjs` |
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
| Colours or fonts in `tokens.css` or `site.css` | Keep `share-card.js` and `scripts/make-share-images.py` (rerun it) in the same colours and fonts |
| `/?repo=` share links | `wireShare` and the `?repo=` auto-check in `index.html`, `homePage` in `worker.js`, `run_worker_first` in `wrangler.jsonc`. Run `node test/share.test.mjs` |
| `/api/subscribe` in `worker.js` | The newsletter form's `fetch("/api/subscribe")` in `index.html`. New signups must land in the segment the newsletter robot sends to |
| `newsletter.js` or `sendNewsletter` in `worker.js` | Real emails to every subscriber. Run `node test/newsletter.test.mjs`. The fingerprint must match HQ's `newsletter/_tools/issue.py`. Never send without Emile's recorded yes, never twice |
| Domain or address | `worker.js` redirects, `SITE` in `seo.js`, `index.html` canonical link and footer, `robots.txt`, `README.md` |
| `repos.txt` | Nothing until the next nightly run (or run the workflow by hand). Then each new repo gets its own Google page and sitemap entry |
| `/mcp` tool names in `worker.js` | Any agent connected to it (e.g. Meta Muse) calls them by name |
| `batch.js`, `instagram.js`, `hq.js` or the cron in `wrangler.jsonc` | Real posts on @safetoclone. Run `node test/batch.test.mjs && node test/instagram.test.mjs && node test/hq.test.mjs`. Never loosen the lock in `batch.js` without Emile's OK. `/ig-media/` must only ever serve pictures of approved posts, never other HQ files. Don't also let Muse post from the batches, or posts double up |
| `fingerprint()` or `checkClaim()` in `batch.js` | HQ's `instagram/_tools/common.py` (`fingerprint`, `check_claim`) must change the same way in the same week, or approved weeks stop posting. `test/batch.test.mjs` holds results made by the Python code |
| `/api/instagram/results` or the `/api/stats` event names | HQ's `instagram/_tools/pull_results.py` reads them every day |

## Ground rules

- The GitHub repo `emiliomadeit/safetoclone` is the only real copy of the code.
- Every merge to `main` redeploys the site automatically.
- No build step and no npm packages. Keep it that way unless there's a strong reason.
- Design rules: the top lines of `site.css` are the Hallmark stamp (the design decisions and any rule we chose to break, with the reason). `.hallmark/` holds Hallmark's notes; it is never published.
- No outside fonts: never link Google Fonts or another font service. Headline and label fonts live in `fonts/`; body text uses each device's own font (Apple's on Mac and iPhone). Keep new UI accessible: visible keyboard focus, text contrast of at least 4.5:1, and real buttons, links and `<details>` instead of clickable divs.
