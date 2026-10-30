// Mirrors the successfully deployed main tree to one reserved preview branch.
// Uses GitHub's normal non-force ref update; never writes main or deploys a Worker.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REPO = "emiliomadeit/safetoclone";
export const BRANCH = "sandbox-baseline";
const MARKER = "Sandbox baseline: ";

export function github(method, path, body) {
  return JSON.parse(execFileSync("gh", ["api", "--method", method,
    `repos/${REPO}/${path}`, ...(body ? ["--input", "-"] : [])],
  { input: body ? JSON.stringify(body) : undefined, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }));
}

export async function sync(api = github) {
  const main = await api("GET", "git/ref/heads/main");
  const sha = main.object.sha;
  const checks = await api("GET", `commits/${sha}/check-runs?per_page=100`);
  const production = checks.check_runs.filter((c) => c.head_sha === sha &&
    c.app?.slug === "cloudflare-workers-and-pages" && c.name === "Workers Builds: safetoclone" &&
    /^https:\/\/dash\.cloudflare\.com\/[^/]+\/workers\/services\/view\/safetoclone\/production\/builds\/[^/]+$/.test(c.details_url || ""))
    .sort((a, b) => b.id - a.id)[0];
  if (!production || production.status !== "completed" || production.conclusion !== "success") {
    return { state: "waiting_for_production_build", source: sha };
  }
  const source = await api("GET", `git/commits/${sha}`);
  // Listing refs avoids treating authentication/network failures as "branch missing".
  const refs = await api("GET", `git/matching-refs/heads/${BRANCH}`);
  const baseline = refs.find((r) => r.ref === `refs/heads/${BRANCH}`);
  const previous = baseline ? await api("GET", `git/commits/${baseline.object.sha}`) : null;
  if (previous && !previous.message.startsWith(MARKER)) {
    throw new Error("Reserved baseline branch has an unrecognized commit; refusing to overwrite it.");
  }
  if (previous?.tree.sha === source.tree.sha && previous.message.includes(`Production-source: ${sha}\n`)) {
    return { state: "current", source: sha, baseline: baseline.object.sha };
  }
  const commit = await api("POST", "git/commits", {
    message: `${MARKER}${sha.slice(0, 7)}\n\nProduction-source: ${sha}\nProduction-build: ${production.details_url}\n`,
    tree: source.tree.sha, parents: previous ? [baseline.object.sha] : [sha],
  });
  // A newer deployment may have started while this run was preparing its commit.
  if ((await api("GET", "git/ref/heads/main")).object.sha !== sha) {
    return { state: "main_moved_retry_later", source: sha };
  }
  if (baseline) {
    await api("PATCH", `git/refs/heads/${BRANCH}`, { sha: commit.sha, force: false });
  } else {
    await api("POST", "git/refs", { ref: `refs/heads/${BRANCH}`, sha: commit.sha });
  }
  return { state: "preview_build_requested", source: sha, baseline: commit.sha,
    tree: source.tree.sha, productionBuild: production.details_url };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await sync(), null, 2)); }
  catch (error) { console.error("Baseline not updated:", error.message); process.exitCode = 1; }
}
