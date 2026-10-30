# Website sandbox

The website repository remains the only source of website code. HQ keeps the
entry point, current evidence and morning handoff. Cloudflare hosts the previews.

## Three places

- **Production:** https://safetoclone.com — the real website. Only Emile merges
  website pull requests to main; a merge deploys.
- **Baseline:** the reserved `sandbox-baseline` branch. Once this setup is merged,
  automation copies the exact Git tree of main only after its latest Cloudflare
  production build succeeds. Cloudflare then builds that branch as a Preview.
- **Feature preview:** a separate branch and pull request for each change. Branch
  pushes update its own Cloudflare Preview. Open `/__sandbox` on the returned URL
  to compare it with production, at desktop or phone width.

The baseline is refreshed on main pushes and checked every 15 minutes. GitHub
schedule delays and Cloudflare build time can add lag; this is eventual sync,
not an instantaneous or independent second source of truth. A failed production
build does not advance the baseline. The reserved baseline branch is disposable
automation output: never develop features there. Its commit message records the
production source commit and build. Feature branches never get reset by this job.

## What works in previews

The actual homepage, fonts, styles, directory, repository pages, share images,
public GitHub checker and OSV lookup run from the branch's website code and data.
`/__sandbox/status` identifies the preview version and disconnected services.
The homepage is visually unchanged; the comparison hub is a separate page.

Newsletter signup returns an explicit sandbox message and saves nothing. There
are no email deliveries, Instagram actions, production analytics writes, private
HQ reads or production KV bindings. The application passes only `ASSETS` into
preview request handlers, including on unknown/custom preview hosts. Preview
configuration sets `SAFETOCLONE_ENV=sandbox`; its scheduled handler is a no-op.
Native Worker Previews do not receive Cron Triggers. Do not deploy an old-style
version URL or separate Worker with production settings as a substitute.

Production's three existing hostnames retain their current behavior. New
production domains must be deliberately added to `PRODUCTION_HOSTS` in sandbox.js.
Preview HTML/API responses use `noindex`; native workers.dev preview responses
also receive Cloudflare's noindex header. Preview URLs are **public**, not an
authenticated private HQ page. Never put private HQ data or credentials into them.

## Agent workflow

1. Fetch current main; create a feature branch. Keep private notes/artifacts in HQ.
2. Make the change; run every test listed in CLAUDE.md, plus the sandbox tests.
3. Push the branch and open a PR. Wait for the actual Cloudflare check and inspect
   the returned preview, including `/__sandbox/status`, home and a repository page.
4. Save the exact commit, preview URL, test evidence and any limitations in HQ.
5. Emile reviews the visual result and merges when ready. After deployment the
   baseline follows. Close unmerged PRs to abandon changes; never merge to test.

For a local preview (Node 22+), from this repository:

```sh
npx --yes wrangler@4.156.0 dev --local --var SAFETOCLONE_ENV:sandbox
```

Open http://localhost:8787/__sandbox. No Cloudflare login is needed for local
mode. Do not load production `.dev.vars` or `.env` files. Local state is disposable.

## Automation and recovery

`.github/workflows/sandbox.yml` runs `scripts/sync-sandbox.mjs` with its repository
token. The script only reads main/checks and creates or fast-forwards the one
reserved baseline ref. It refuses a foreign branch tip, uses the exact production
tree, rechecks main before updating, and never force-pushes or updates main. A
concurrent ref update fails safely. It records `preview_build_requested`, not
"preview deployed"; verify the subsequent Cloudflare check/URL separately.

The workflow becomes active only after Emile merges this setup PR. Verify one
real scheduled cycle and one production update before declaring automatic sync
proven. If the token-created push does not trigger the external Cloudflare app,
leave the baseline marked stale and configure the supported Cloudflare preview
build trigger; do not add personal tokens or production deploy steps silently.

If a baseline refresh fails, keep using the last verified URL and inspect the
workflow run. Do not reset feature branches. If main is ahead of its successful
production build, wait; never label an unbuilt main commit as live production.

Cloudflare documentation checked October 30, 2026:
- https://developers.cloudflare.com/workers/previews/
- https://developers.cloudflare.com/workers/previews/configuration/
- https://developers.cloudflare.com/workers/ci-cd/builds/build-branches/

Native Worker Previews require Wrangler 4.135.0+. This implementation was locally
tested with 4.156.0; Cloudflare's existing repository integration supplies remote
deployment credentials. No new product dependencies or build step are introduced.
