// Scores every repo in repos.txt and writes data/directory.json.
// Runs every night on GitHub Actions (see .github/workflows/nightly.yml).
// Locally: GITHUB_TOKEN=xxx node scripts/build-directory.mjs
import { readFile, writeFile } from "node:fs/promises";
import { checkRepo } from "../score.js";

const list = (await readFile(new URL("../repos.txt", import.meta.url), "utf8"))
  .split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

const results = [];
for (const name of list) {
  try {
    const r = await checkRepo(name, { token: process.env.GITHUB_TOKEN });
    results.push({ name: r.name, url: r.url, description: r.description, score: r.score, grade: r.grade,
      level: r.level, label: r.label, verdict: r.verdict, flags: r.flags.map((f) => f.label),
      // Extra detail for the repo pages Google reads (/repo/owner/name, built in seo.js).
      warnings: r.flags.map(({ label, note, severity }) => ({ label, note, severity })),
      checks: r.checks, areas: r.areas, securityChecked: r.securityChecked, capReason: r.capReason, aiFilesFound: r.aiFilesFound, checkedAt: r.checkedAt });
    console.log(`${r.grade} ${String(r.score).padStart(3)}  ${r.securityChecked ? "scorecard" : "no-scorecard"}  ${r.name}`);
  } catch (e) {
    console.error(`skip ${name}: ${e.message}`);
  }
}
results.sort((a, b) => b.score - a.score);
await writeFile(new URL("../data/directory.json", import.meta.url),
  JSON.stringify({ updatedAt: new Date().toISOString(), example: false, repos: results }, null, 2) + "\n");
console.log(`wrote ${results.length} repos, ${results.filter((r) => r.securityChecked).length} with OpenSSF Scorecard data`);
