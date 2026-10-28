# For AI agents (Codex and others)

Read `CLAUDE.md` in this folder. It is the guide for every agent, not only Claude: what each file does,
what else to check when you change something, and the ground rules.

Current state, decisions already made and the owner's to-do list are in the private HQ repo
(`emiliomadeit/safetoclone-hq`): read `knowledge/status.md` there before starting.

Short version of the rules:
- This folder is the public website. Any new file not meant for visitors goes in `.assetsignore`.
- Work through pull requests. Emile merges; every merge to `main` goes live.
- Run the tests listed in `CLAUDE.md` before opening a PR.
- Never commit secrets. Explain changes to Emile in plain language: he is a beginner.
