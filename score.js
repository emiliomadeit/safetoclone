// SafeToClone scoring engine.
// Works in the browser and in Node 18+ (both have fetch).
// It reads public information about a GitHub repo and turns it into a 0-100 score.
// It is a set of warning signs, not a virus scan. A high score lowers risk; it never proves safety.

const API = "https://api.github.com";

// Words that show up again and again in malware repos that pretend to be free tools.
const SCAM_WORDS = [
  /\bcrack(ed)?\b/i, /\bkeygen\b/i, /\bfree\s+robux\b/i, /\bcheat\s*(engine|menu)?\b/i,
  /\bunlocked?\s+(premium|pro|full)\b/i, /\bfree\s+(premium|pro|full\s+version)\b/i,
  /\bspoofer\b/i, /\baimbot\b/i, /\bwallet\s+drainer\b/i, /\bseed\s+phrase\b/i,
];
const DISABLE_AV = /(disable|turn\s+off|deactivate)\s+(your\s+)?(anti-?virus|windows\s+defender|defender|real-?time\s+protection|smartscreen)/i;
const ZIP_PASSWORD = /\b(zip|rar|7z|archive|extract|unzip)\b[^\n]{0,80}\b(password|pwd)\b|\b(password|pwd)\b[^\n]{0,80}\b(zip|rar|7z|archive|extract|unzip)\b/i;
const PIPE_TO_SHELL = /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b|iwr[^\n|]*\|\s*iex|Invoke-Expression|irm[^\n|]*\|\s*iex|sh\s+-c\s+"\$\((curl|wget)/i;
const LONG_BASE64 = /[A-Za-z0-9+/]{400,}={0,2}/;

// Files that give instructions to AI coding agents. A bad one can tell your AI to leak keys or run commands.
const AI_FILES = ["CLAUDE.md", "AGENTS.md", ".cursorrules", "SKILL.md", ".windsurfrules", "GEMINI.md", ".mcp.json", "mcp.json"];
const PROMPT_INJECTION = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /do\s+not\s+(tell|inform|mention\s+(this\s+)?to)\s+the\s+user/i,
  /without\s+(asking|telling)\s+the\s+user/i,
  /(send|upload|post|exfiltrate)[^\n]{0,60}(api[_ -]?key|token|\.env|credentials|ssh)/i,
  /(webhook\.site|requestbin|pipedream\.net|ngrok\.io|discord(app)?\.com\/api\/webhooks)/i,
  /\bcat\s+~\/\.(ssh|aws)|\bprintenv\b|process\.env\b[^\n]{0,40}(fetch|post)/i,
];
const RISKY_FILE = /\.(exe|scr|bat|cmd|msi|vbs|ps1|jar|dll|apk|dmg|pkg|zip|rar|7z)$/i;

const DAY = 24 * 60 * 60 * 1000;
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / DAY;

// Accepts "owner/repo", "github.com/owner/repo" or a full URL.
export function parseRepo(input) {
  const s = String(input || "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = s.match(/(?:github\.com[/:])?([A-Za-z0-9-_.]+)\/([A-Za-z0-9-_.]+)(?:\/.*)?$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function getJSON(url, token) {
  const headers = { Accept: "application/vnd.github+json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) {
    const err = new Error("GitHub's free hourly limit was reached. Try again in a few minutes.");
    err.code = "RATE_LIMIT";
    throw err;
  }
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${url}`);
  return res.json();
}

async function getText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return "";
    const t = await res.text();
    return t.slice(0, 200000);
  } catch { return ""; }
}

// Collects everything the scorer needs. Kept separate so tests can feed in saved data.
export async function collect(owner, repo, { token } = {}) {
  const r = await getJSON(`${API}/repos/${owner}/${repo}`, token);
  if (!r) { const e = new Error("That repo doesn't exist or is private."); e.code = "NOT_FOUND"; throw e; }
  const [user, contents, releases] = await Promise.all([
    getJSON(`${API}/users/${r.owner.login}`, token).catch(() => null),
    getJSON(`${API}/repos/${owner}/${repo}/contents/`, token).catch(() => []),
    getJSON(`${API}/repos/${owner}/${repo}/releases?per_page=5`, token).catch(() => []),
  ]);
  const files = Array.isArray(contents) ? contents : [];
  const byName = (n) => files.find((f) => f.name.toLowerCase() === n.toLowerCase());
  const readmeFile = files.find((f) => /^readme(\.|$)/i.test(f.name));
  const readme = readmeFile?.download_url ? await getText(readmeFile.download_url) : "";
  const pkg = byName("package.json")?.download_url ? await getText(byName("package.json").download_url) : "";
  const aiFiles = {};
  await Promise.all(AI_FILES.map(async (n) => {
    const f = byName(n);
    if (f?.download_url) aiFiles[f.name] = await getText(f.download_url);
  }));
  return { repo: r, user, files, releases: Array.isArray(releases) ? releases : [], readme, pkg, aiFiles };
}

// Turns collected data into a score. Pure function: same input, same output.
export function score(data) {
  const { repo: r, user, files, releases, readme, pkg, aiFiles } = data;
  const checks = []; // { group, label, points, max, note, level: good|warn|bad }
  const add = (group, label, points, max, level, note) => checks.push({ group, label, points, max, level, note });

  // 1. Reputation (30)
  const stars = r.stargazers_count || 0;
  const starPts = Math.min(15, Math.round(Math.log10(stars + 1) * 4.3)); // 1k stars ≈ 13, 3k+ = 15
  add("Reputation", "Stars", starPts, 15, stars >= 500 ? "good" : stars >= 50 ? "warn" : "bad",
    `${stars.toLocaleString("en")} people starred it.`);
  const forks = r.forks_count || 0;
  add("Reputation", "Forks", Math.min(5, Math.round(Math.log10(forks + 1) * 2)), 5, forks >= 50 ? "good" : "warn",
    `${forks.toLocaleString("en")} copies made by other developers.`);
  const ownerAge = user ? daysSince(user.created_at) : 0;
  const ownerPts = ownerAge > 730 ? 10 : ownerAge > 180 ? 6 : ownerAge > 30 ? 3 : 0;
  add("Reputation", "Owner history", ownerPts, 10, ownerPts >= 6 ? "good" : ownerPts >= 3 ? "warn" : "bad",
    user ? `${user.type === "Organization" ? "Organization" : "Account"} created ${Math.round(ownerAge / 365 * 10) / 10} years ago.` : "Couldn't read the owner's profile.");

  // 2. Upkeep (25)
  const lastPush = daysSince(r.pushed_at);
  const pushPts = r.archived ? 0 : lastPush < 30 ? 12 : lastPush < 180 ? 9 : lastPush < 365 ? 5 : 2;
  add("Upkeep", "Recent updates", pushPts, 12, pushPts >= 9 ? "good" : pushPts >= 5 ? "warn" : "bad",
    r.archived ? "The owner archived it. Nobody fixes problems anymore." : `Last change ${Math.round(lastPush)} days ago.`);
  const age = daysSince(r.created_at);
  const agePts = age > 365 ? 8 : age > 90 ? 5 : age > 30 ? 2 : 0;
  add("Upkeep", "Track record", agePts, 8, agePts >= 5 ? "good" : agePts >= 2 ? "warn" : "bad",
    `Repo is ${age > 365 ? Math.round(age / 365 * 10) / 10 + " years" : Math.round(age) + " days"} old.`);
  add("Upkeep", "Releases", releases.length ? 5 : 2, 5, releases.length ? "good" : "warn",
    releases.length ? "Publishes versioned releases." : "No official releases. You'd be downloading work in progress.");

  // 3. Transparency (15)
  add("Transparency", "License", r.license ? 5 : 0, 5, r.license ? "good" : "warn",
    r.license ? `Uses the ${r.license.spdx_id || r.license.name} license.` : "No license. Legally you may not be allowed to use it.");
  const readmeLen = readme.length;
  add("Transparency", "Instructions", readmeLen > 1500 ? 5 : readmeLen > 300 ? 3 : 0, 5, readmeLen > 1500 ? "good" : "warn",
    readmeLen ? "Has a README that explains the project." : "No README. You can't tell what it does.");
  const hasSecurity = files.some((f) => /^security(\.md)?$/i.test(f.name));
  add("Transparency", "Security contact", hasSecurity ? 5 : 2, 5, hasSecurity ? "good" : "warn",
    hasSecurity ? "Tells people how to report security problems." : "No security policy file.");

  // 4. Red flags (30, deductions). Some are "hard" flags that cap the final score.
  let flagPts = 30;
  let cap = 100;
  const flags = [];
  const flag = (label, minus, note, hardCap) => {
    flagPts -= minus; flags.push({ label, note, severity: hardCap ? "high" : minus >= 8 ? "medium" : "low" });
    if (hardCap) cap = Math.min(cap, hardCap);
  };
  const text = readme + "\n" + (r.description || "");
  if (SCAM_WORDS.some((re) => re.test(text))) flag("Scam-style wording", 15, "Mentions cracks, cheats, free premium, or crypto seed phrases. Most malware on GitHub looks like this.", 35);
  if (DISABLE_AV.test(text)) flag("Asks you to turn off antivirus", 30, "Real software never needs this. This is the #1 sign of malware.", 15);
  if (ZIP_PASSWORD.test(text)) flag("Password-protected download", 15, "Passwords on zip files stop antivirus from looking inside.", 30);
  const riskyRoot = files.filter((f) => f.type === "file" && RISKY_FILE.test(f.name)).map((f) => f.name);
  const riskyAssets = releases.flatMap((x) => (x.assets || []).map((a) => a.name)).filter((n) => RISKY_FILE.test(n));
  if (riskyRoot.length) flag("Programs sitting in the code", 10, `Ready-to-run files in the main folder: ${riskyRoot.slice(0, 3).join(", ")}. Source code projects rarely do this.`, stars < 100 ? 40 : null);
  if (riskyAssets.length && stars < 100) flag("Unknown programs to download", 8, `Releases offer ${riskyAssets.slice(0, 3).join(", ")} from a little-known project.`);
  if (PIPE_TO_SHELL.test(readme)) flag("Runs a script straight from the internet", 3, "The install step downloads and runs code in one line. Common with real tools too, but you can't see what runs.");
  const readmeNoImages = readme.replace(/data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+/gi, "");
  if (LONG_BASE64.test(readmeNoImages)) flag("Hidden encoded text", 10, "The README contains a long scrambled block of text. That can hide commands.");
  if (age < 30 && stars > 500) flag("Suspiciously fast fame", 12, `${stars} stars in ${Math.round(age)} days. Fake stars are bought to make malware look popular.`, 50);
  if (user && ownerAge < 30) flag("Brand-new owner account", 8, "The account behind it is less than a month old.");
  try {
    const scripts = pkg ? JSON.parse(pkg).scripts || {} : {};
    const hooks = ["preinstall", "install", "postinstall"].filter((k) => scripts[k]);
    if (hooks.length) flag("Runs code during install", 4, `package.json runs "${scripts[hooks[0]].slice(0, 60)}" the moment you install it.`);
  } catch { /* not valid JSON, ignore */ }

  // AI-agent check: instruction files that could hijack your AI assistant.
  const aiNames = Object.keys(aiFiles);
  const injected = aiNames.filter((n) => PROMPT_INJECTION.some((re) => re.test(aiFiles[n])) || LONG_BASE64.test(aiFiles[n]));
  if (injected.length) flag("Could hijack your AI assistant", 25, `${injected.join(", ")} contains instructions that try to override your AI, hide things from you, or send data away.`, 20);

  flagPts = Math.max(0, flagPts);
  add("Red flags", flags.length ? `${flags.length} warning sign${flags.length > 1 ? "s" : ""}` : "No warning signs found", flagPts, 30,
    flagPts >= 25 ? "good" : flagPts >= 15 ? "warn" : "bad", flags.length ? "See the list below." : "We didn't find any of the common malware tricks.");

  const raw = checks.reduce((s, c) => s + c.points, 0);
  const total = Math.max(0, Math.min(cap, raw));
  const grade = total >= 85 ? "A" : total >= 70 ? "B" : total >= 55 ? "C" : total >= 40 ? "D" : "F";
  const verdict = {
    A: "Looks trustworthy. Still only install what you need.",
    B: "Probably fine. Read the warnings first.",
    C: "Be careful. Ask someone technical before installing.",
    D: "Risky. We wouldn't install this on a work computer.",
    F: "Don't download this.",
  }[grade];

  return {
    name: r.full_name,
    url: r.html_url,
    description: r.description || "",
    score: total,
    grade,
    verdict,
    capped: cap < raw ? cap : null,
    checks,
    flags,
    aiFilesFound: aiNames,
    checkedAt: new Date().toISOString(),
  };
}

export async function checkRepo(input, opts = {}) {
  const p = parseRepo(input);
  if (!p) { const e = new Error("Paste a GitHub link like github.com/owner/repo."); e.code = "BAD_INPUT"; throw e; }
  const data = await collect(p.owner, p.repo, opts);
  return score(data);
}
