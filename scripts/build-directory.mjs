// Scores every repo in repos.txt and writes data/directory.json.
// Runs every night on GitHub Actions (see .github/workflows/nightly.yml).
// Locally: GITHUB_TOKEN=xxx node scripts/build-directory.mjs
import { readFile, writeFile } from "node:fs/promises";
import { checkRepo, directoryEntry } from "../score.js";

const list = (await readFile(new URL("../repos.txt", import.meta.url), "utf8"))
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

// GitHub allows about 1,000 calls an hour here. When they run out, wait for the next hour instead of skipping repos.
// Returns false if the 403 wasn't the hourly limit (then the repo is skipped as before).
async function waitForGitHub() {
  const headers = { "User-Agent": "safetoclone (+https://safetoclone.com)" };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const core = (await (await fetch("https://api.github.com/rate_limit", { headers })).json()).resources?.core;
  if (!core || core.remaining > 0) return false;
  const ms = Math.max(core.reset * 1000 - Date.now(), 0) + 10000;
  console.log(`GitHub's hourly limit reached, waiting ${Math.ceil(ms / 60000)} min`);
  await new Promise((r) => setTimeout(r, ms));
  return true;
}

const check = async (name) => {
  try { return await checkRepo(name, { token: process.env.GITHUB_TOKEN }); }
  catch (e) {
    if (e.code === "RATE_LIMIT" && await waitForGitHub().catch(() => false)) return checkRepo(name, { token: process.env.GITHUB_TOKEN });
    throw e;
  }
};

const results = [];
for (const name of list) {
  try {
    const r = await check(name);
    results.push(directoryEntry(r));
    console.log(`${r.grade} ${String(r.score).padStart(3)}  ${r.securityChecked ? (r.checks.some((c) => c.group === "Security habits" && c.label !== "Known security holes") ? "scorecard" : "osv-only  ") : "not-checked"}  ${r.name}`);
  } catch (e) {
    console.error(`skip ${name}: ${e.message}`);
  }
}
results.sort((a, b) => b.score - a.score);
await writeFile(new URL("../data/directory.json", import.meta.url),
  JSON.stringify({ updatedAt: new Date().toISOString(), example: false, repos: results }, null, 2) + "\n");
// Why some repos have no Scorecard data: print the answer for a few of them.
for (const r of results.filter((x) => !x.securityChecked).slice(0, 5)) {
  const res = await fetch(`https://api.scorecard.dev/projects/github.com/${r.name}`).catch((e) => ({ status: e.message, text: async () => "" }));
  console.log(`scorecard ${r.name}: ${res.status} ${(await res.text()).slice(0, 120)}`);
}
console.log(`wrote ${results.length} repos, ${results.filter((r) => r.securityChecked).length} with security data (Scorecard or OSV), ${results.filter((r) => r.checks.some((c) => c.label === "Known security holes")).length} checked for known security holes`);
