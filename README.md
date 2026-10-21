# SafeToClone

A website that gives non-technical people a safety grade (A to F) for any GitHub repo before they download it, including checks for files that try to hijack AI assistants (CLAUDE.md, AGENTS.md, SKILL.md, .cursorrules, MCP configs).

## What's in here

| File | What it does |
|---|---|
| `index.html` | The whole website: checker, directory, scoring explainer, pricing, newsletter form |
| `score.js` | The scoring engine. Reads public GitHub data and returns a 0–100 score |
| `data/directory.json` | Scores for the directory. Rewritten every night |
| `repos.txt` | Which repos the directory covers. Add a line to add a repo |
| `scripts/build-directory.mjs` | Scores everything in `repos.txt` |
| `.github/workflows/nightly.yml` | Runs the script every night on GitHub for free |
| `worker.js` + `wrangler.jsonc` | Runs the site on Cloudflare and handles newsletter signups through Resend |
| `.assetsignore` | Files Cloudflare should not publish |
| `CLAUDE.md` | Guide for AI helpers: what each file does and what a change affects |
| `test/score.test.mjs` | Checks the scoring still works: `node test/score.test.mjs` |
| `seo.js` | Pages for Google: `safetoclone.com/repo/owner/name` for every graded repo, `/repos`, and `/sitemap.xml` |
| `share-card.js`, `share/` | Sharing: the "Download image" card, and the pictures shown when someone pastes a `safetoclone.com/?repo=owner/name` link |

## How the score works

100 points across four questions: reputation, upkeep, transparency and red flags. Serious warning signs cap the score no matter how popular the repo is. Each result gets a grade (A to F) and a label (Trusted, Probably fine, Be careful, Unproven or Dangerous).

The exact points, caps and grade cut-offs live in one place only: `score.js`. Read it there so this page never goes out of date.

**Limits:** it only reads the README, the top folder, releases and AI instruction files. It never runs code. It is a warning-sign checker, not antivirus. Visitors' browsers call GitHub directly, so each visitor gets about 12 checks an hour before GitHub's free limit kicks in.

## Run it on your computer

```
python3 -m http.server 8000
```
Then open http://localhost:8000

Live at **https://safetoclone.com**. Contact: hello@safetoclone.com (Cloudflare Email Routing forwards it to the owner's Gmail).

## Put it online (Cloudflare Workers, free and allowed for business use)

1. Sign up at dash.cloudflare.com.
2. Workers & Pages → Create → Import a repository → pick this repo → Deploy. Cloudflare reads `wrangler.jsonc`, so no settings are needed.
3. For the newsletter, add `RESEND_API_KEY` (type Secret, a Full access key from resend.com → API keys) under the Worker's Settings → Variables and Secrets. Signups appear in Resend → Audience → Contacts. Optionally add `RESEND_SEGMENT_ID` to put signups in a segment.

`www.safetoclone.com` and the old `workers.dev` address redirect to `safetoclone.com` (see `worker.js`).

Every change to `main`, including the nightly score update, redeploys the site by itself.

