// Reads the weekly Instagram batches, the daily check and the pictures from the private HQ repo
// (emiliomadeit/safetoclone-hq). The website only runs the robot; the posts live in HQ.
//
// Setting in Cloudflare > Workers & Pages > safetoclone:
//   HQ_GITHUB_TOKEN  (Secret) a GitHub key that can only READ the HQ repo. Without it, the robot
//                    has no posts to read.
const HQ_REPO = "emiliomadeit/safetoclone-hq";

// Get one file from HQ. Tries twice, because GitHub sometimes has a short hiccup.
export async function hqFile(env, path) {
  const url = `https://api.github.com/repos/${HQ_REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    Authorization: `Bearer ${env.HQ_GITHUB_TOKEN}`,
    Accept: "application/vnd.github.raw",
    "User-Agent": "safetoclone-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let last;
  for (let i = 0; i < 2; i++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r;
    last = new Error(`HQ ${path}: GitHub said ${r.status}`);
    if (r.status === 404 || r.status === 401 || r.status === 403) break; // no point retrying
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw last;
}

// One text file, or null when the file doesn't exist. Any other problem (GitHub down, bad key) throws,
// so the robot stops instead of guessing. Answers are remembered for 60 seconds (in memory only), so a burst of
// visits to /api/instagram/status, /mcp or /ig-media/ can't use up the GitHub key's hourly limit and stop the robot.
const KEEP_MS = 60e3;
const memory = new Map();
export const forgetHq = () => memory.clear(); // for tests

export async function hqText(env, path) {
  const kept = memory.get(path);
  if (kept && performance.now() - kept.at < KEEP_MS) return kept.text;
  let text;
  try {
    text = await (await hqFile(env, path)).text();
  } catch (e) {
    if (!/said 404$/.test(e.message)) throw e;
    text = null;
  }
  memory.set(path, { text, at: performance.now() });
  return text;
}

export async function hqJson(env, path) {
  const text = await hqText(env, path);
  return text === null ? null : JSON.parse(text);
}

// The week files the robot needs: last week (for yesterday's pictures), this week and next week.
export const batchPath = (monday) => `instagram/batches/${monday}.json`;
export const checkPath = (date) => `ops/nightly/${date}.md`;
