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
| `api/subscribe.js` | Same thing, for Vercel instead |
| `test/score.test.mjs` | Checks the scoring still works: `node test/score.test.mjs` |

## How the score works

100 points across four questions. Serious warning signs cap the score no matter how popular the repo is.

- **Reputation (30):** stars, forks, how old the owner's account is
- **Upkeep (25):** last update, repo age, official releases
- **Transparency (15):** license, README, security policy
- **Red flags (30, points taken away):** "disable your antivirus" (caps at 15), AI-hijacking instructions (caps at 20), scam words like crack/free premium (caps at 35), password-protected zips (caps at 30), fake-looking star growth (caps at 50), brand-new owner accounts, programs sitting in the code, hidden encoded text, install scripts, pipe-to-shell installs

Grades: A 85+, B 70+, C 55+, D 40+, F below 40. Each result also gets a label: Trusted (A), Probably fine (B), Be careful (C), Unproven (D or F with no serious red flags) or Dangerous (any serious red flag, or red-flag points at 15 or below).

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
3. For the newsletter, add `RESEND_API_KEY` and `RESEND_AUDIENCE_ID` under the Worker's Settings → Variables and Secrets.

`www.safetoclone.com` and the old `workers.dev` address redirect to `safetoclone.com` (see `worker.js`).

Every change to `main`, including the nightly score update, redeploys the site by itself.

Vercel works too (`api/subscribe.js`), but its free plan doesn't allow commercial use.
