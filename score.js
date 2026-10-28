// SafeToClone scoring engine.
// Works in the browser and in Node 18+ (both have fetch).
// It reads public information about a GitHub repo and turns it into a 0-100 score.
// It is a set of warning signs, not a virus scan. A high score lowers risk; it never proves safety.

const API = "https://api.github.com";

// Words that show up again and again in malware repos that pretend to be free tools.
// Written so everyday phrases ("cheat sheet", "never share your seed phrase") don't count.
const SCAM_WORDS = [
  /\bcrack\s+(version|download|for|full)\b/i, /\bcracked\b(?!\s+(passwords?|hash(es)?))/i, /\bkeygen\b/i,
  /\bfree\s+robux\b/i, /\b(roblox|script)\s+executor\b/i,
  /\bcheat\s*(engine|menu|codes?)\b/i, /\b[Cc]heats?\s+(for|in)\s+[A-Z0-9]/, /\b(free|undetected|working)\s+cheats?\b/i, /\bmod\s+menu\b/i,
  /\bunlocked?\s+(premium|pro|full)\b/i,
  // "Free premium" offers, but not a real company's promo ("free premium Kimi plans", "free pro trial").
  /\bfree\s+(premium|pro|full\s+version)\b(?!(\s+[^\s.]+){0,3}\s+(plans?|trials?|months?|credits?|tiers?|subscriptions?|seats?)\b)/i,
  /\bspoofer\b/i, /\baimbot\b/i, /\bwallet\s+drainer\b/i,
];
const DISABLE_AV = /(disable|turn\s+off|deactivate)\s+(your\s+)?(anti-?virus|windows\s+defender|defender|real-?time\s+protection|smartscreen)/i;
// A password that is actually given out ("password: 1234", "the password is abc"), not just the word "password".
// "pass" only counts as "pass:" or "pass=" ("the tests pass is..." is not a password), and "no password is
// configured" or "without an admin password: ..." don't count either.
const PASSWORD_GIVEN = /(?<!\b(no|without|any)\s+(an?\s+)?((admin|root|sudo|user|account)\s+)?)\b(?:(password|pwd)\s*(is|:|=)|pass\s*[:=])\s*(?!(required|optional|needed|not|the|your|a|an|set|stored|saved|hashed|empty|blank|configured|now|changed|reset|missing|wrong|incorrect|invalid)\b)["'`*]*[^\s"'`*]{2,}/i;
const ARCHIVE_WORD = /\b(zip|rar|7z|archive|extract|unzip)\b/i;
const ARCHIVE_FILE = /\.(zip|rar|7z)$/i;
// True when a line mentions an archive and also hands out a password.
// Returns that line, so the warning can quote it.
const zipPassword = (text) => text.split("\n").find((line) => ARCHIVE_WORD.test(line) && PASSWORD_GIVEN.test(line));
// A short piece of text around a match, on one line, for quoting in a warning.
const around = (text, m) => text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).replace(/\s+/g, " ").trim();
const PIPE_TO_SHELL = /(curl|wget)[^\n|]*\|\s*(sudo\s+)?(ba|z)?sh\b|iwr[^\n|]*\|\s*iex|Invoke-Expression|irm[^\n|]*\|\s*iex|sh\s+-c\s+"\$\((curl|wget)/i;
const LONG_BASE64 = /[A-Za-z0-9+/]{400,}={0,2}/;
// Characters you can't see on screen but an AI still reads: "tag" letters, text-direction tricks, and runs of
// zero-width spaces. They are used to hide instructions inside files that look harmless.
const HIDDEN_CHARS = /[\u{E0000}-\u{E007F}]|[\u202A-\u202E\u2066-\u2069]|[\u200B\u200C\u200E\u200F\u2060-\u2064]{3,}/u;

// Files that give instructions to AI coding agents. A bad one can tell your AI to leak keys or run commands.
const AI_FILES = ["CLAUDE.md", "AGENTS.md", ".cursorrules", "SKILL.md", ".windsurfrules", "GEMINI.md", ".mcp.json", "mcp.json"];
// Hidden folders where AI tools also look for instructions and settings (.claude/settings.json, .cursor/rules/...).
const AI_FOLDERS = [".claude", ".cursor", ".github", ".vscode", ".windsurf", ".gemini"];
const AI_FOLDER_FILE = /^(CLAUDE\.md|AGENTS\.md|GEMINI\.md|copilot-instructions\.md|mcp\.json|settings(\.local)?\.json|.+\.mdc|rules\.md)$/i;
const AI_SUBFOLDERS = ["rules", "commands", "agents"]; // inside .claude/ and .cursor/
const AI_FILE_LIMIT = 12;
const PROMPT_INJECTION = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /do\s+not\s+(tell|inform|mention\s+(this\s+)?to)\s+the\s+user/i,
  /without\s+(asking|telling)\s+the\s+user/i,
  // Only counts when secrets are sent somewhere: "send the API key to https://...".
  /\b(send|upload|post|exfiltrate|forward|transmit)\b[^\n]{0,40}\b(api[_ -]?keys?|tokens?|\.env|credentials|ssh\s+keys?|secrets?)\b[^\n]{0,40}\b(to|at)\s+(https?:\/\/|an?\s+(external|remote)|this\s+(url|endpoint|server))/i,
  // Discord webhooks only count with a real numeric ID: projects often document their own as ".../webhooks/xxx".
  /(webhook\.site|requestbin|pipedream\.net|ngrok\.io|discord(app)?\.com\/api\/webhooks\/\d{6,})/i,
  /\bcat\s+~\/\.(ssh|aws)|\bprintenv\b|process\.env\b[^\n]{0,40}(fetch|post)/i,
];
// Ready-to-run programs and archives. Plain-text launch scripts (.bat, .ps1, .sh) are left out:
// many real projects ship them, and anyone can open them to read what they do.
const RISKY_FILE = /\.(exe|scr|msi|vbs|jar|dll|apk|dmg|pkg|zip|rar|7z)$/i;

const DAY = 24 * 60 * 60 * 1000;
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / DAY;

// ---- Plain-English text shown with every result (home page checker and the Google pages both use it) ----

// Grade cut-offs: a score of 85 or more is an A, 70 to 84 a B, and so on.
export const GRADES = [["A", 85], ["B", 70], ["C", 55], ["D", 40], ["F", 0]];
export const gradeOf = (pct) => GRADES.find(([, min]) => pct >= min)[0];
// Highest score each grade allows: an A can be 100, a B at most 84, and so on.
const TOP = { A: 100, B: 84, C: 69, D: 54, F: 39 };
const LETTERS = GRADES.map(([g]) => g);

// One letter per group of checks, so a visitor sees which part is strong and which is weak.
// Works on any list of checks, including older directory entries.
export function areaGrades(checks = []) {
  const areas = {};
  for (const c of checks) {
    const a = (areas[c.group] ||= { points: 0, max: 0 });
    a.points += c.points; a.max += c.max;
  }
  for (const a of Object.values(areas)) a.grade = gradeOf(a.max ? (100 * a.points) / a.max : 0);
  return areas;
}

// Every result gets one of these labels: a short verdict and what the visitor should do next.
export const LEVELS = {
  trusted: {
    label: "Strong",
    verdict: "Strong on every check. No grade is a guarantee, so only install what you need.",
    advice: "It's widely used, looked after, open about itself, and shows none of the malware tricks we check for. Download it only from its official GitHub page, never from a copy, a file-sharing site or a link in a video.",
  },
  fine: {
    label: "Probably fine",
    verdict: "Probably fine. Read the warnings first.",
    advice: "We found no malware tricks, but it misses some signs of a well-run project. Read the warning signs, and download it only from its official GitHub page.",
  },
  careful: {
    label: "Be careful",
    verdict: "Be careful. Ask someone technical before installing.",
    advice: "Something is missing or slightly off. It may be fine, but ask someone technical before you install it, and never put it on a work computer without your IT team's OK.",
  },
  unproven: {
    label: "Unproven",
    verdict: "No warning signs, but it's too new or little-known to trust yet. Only install it if you know who made it.",
    advice: "Nothing looks wrong, but it's too new or too little-known to trust yet. Only install it if you know and trust who made it. The grade can go up as more people use it.",
  },
  dangerous: {
    label: "Dangerous",
    verdict: "Don't download this. It shows signs of malware.",
    advice: "Don't download it. We found tricks that malware uses, like asking you to turn off your antivirus or hiding files in locked zips. If you already installed it, uninstall it, run a virus scan and change your passwords.",
  },
};

// The question each group of checks answers (same wording as "How we score" on the home page).
export const GROUPS = {
  Reputation: "Do people trust it?",
  Upkeep: "Is anyone looking after it?",
  Transparency: "Is it open about itself?",
  "Security habits": "Does it have good security habits?",
  "Red flags": "Any malware tricks?",
};

// Why each check matters, for curious visitors. Keyed by the check's label (or its group, for the red flags row).
export const WHY = {
  Stars: "Stars are like bookmarks. Malware repos rarely have many real users, and lots of stars means lots of people have looked at it. Stars can be bought, so we also check how fast they came.",
  Forks: "A fork is a copy another developer made to build on. Real projects get copied; fake ones rarely do.",
  "Owner history": "Scammers use brand-new accounts that get banned and replaced. An owner who has been around for years has more to lose.",
  "Recent updates": "Software nobody updates stops getting security fixes.",
  "Track record": "Older projects have had more time for problems to be spotted and reported.",
  Releases: "A release is an official, finished version. Without one, you download whatever is in the code that day.",
  License: "A license says whether you're allowed to use it. Serious projects almost always have one.",
  Instructions: "A README explains what the project does and how to use it. Malware often has a thin or copied one.",
  "Security contact": "A security policy tells people how to report problems privately, so they get fixed before attackers use them.",
  "Code review": "When a second person checks every change before it goes in, it's much harder to sneak in something bad. From OpenSSF Scorecard, an independent security check.",
  "Known security holes": "Security holes that are public but not fixed yet are what attackers look for first. From OpenSSF Scorecard, or, when it has no data, from the project's list of parts (its lock file) looked up in OSV, Google's free public database of known security holes.",
  "Safe automation": "Most projects use robots that build and publish the software. Robots with loose permissions have been used to slip malware into real, popular projects. From OpenSSF Scorecard.",
  "Red flags": "We look for tricks that keep showing up in malware: requests to turn off antivirus, locked zip files, cracks and free premium, hidden code, and AI instruction files that try to take over your assistant. Serious ones cap the grade, however popular the repo is.",
};

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

async function getText(url, limit = 200000) {
  try {
    const res = await fetch(url);
    if (!res.ok) return "";
    const t = await res.text();
    return t.slice(0, limit);
  } catch { return ""; }
}

// ---- Known security holes in the parts a project uses (its "dependencies") ----
// Most projects are built from hundreds of parts other people wrote. A "lock file" in the main folder lists
// every part and its exact version. We look those up in OSV (osv.dev), Google's free public database of
// known security holes. Only used when OpenSSF Scorecard has no answer for this repo.
export const OSV_URL = "https://api.osv.dev/v1/querybatch";
const LOCK_LIMIT = 8000000; // bigger lock files are skipped
const MAX_PARTS = 3000;
// File name -> how to read it. Each returns [{ name, version, ecosystem }].
const LOCKFILES = {
  "package-lock.json": (t) => {
    const j = JSON.parse(t);
    const out = [];
    if (j.packages) {
      for (const [path, p] of Object.entries(j.packages)) {
        // "" is the project itself. Parts only used while building it ("dev") never reach your computer as running code.
        if (!path || p.dev || p.link || !p.version) continue;
        out.push({ name: p.name || path.split("node_modules/").pop(), version: p.version, ecosystem: "npm" });
      }
    } else if (j.dependencies) {
      const walk = (deps) => {
        for (const [name, p] of Object.entries(deps || {})) {
          if (p.dev || !p.version) continue;
          out.push({ name, version: p.version, ecosystem: "npm" });
          walk(p.dependencies);
        }
      };
      walk(j.dependencies);
    }
    return out;
  },
  "requirements.txt": (t) => t.split("\n").map((l) => l.replace(/#.*/, "").trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*==\s*([A-Za-z0-9._+!-]+)/))
    .filter(Boolean).map((m) => ({ name: m[1], version: m[3], ecosystem: "PyPI" })),
  "poetry.lock": (t) => tomlPackages(t, "PyPI"),
  "uv.lock": (t) => tomlPackages(t, "PyPI", { skipLocal: true }),
  "Cargo.lock": (t) => tomlPackages(t, "crates.io", { skipLocal: true }),
  "go.mod": (t) => [...t.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+(v[0-9][^\s]*)/gim)]
    .map((m) => ({ name: m[1], version: m[2], ecosystem: "Go" })),
};
// poetry.lock, uv.lock and Cargo.lock list parts as [[package]] blocks with name = "..." and version = "...".
// Parts that live inside the project itself (no "source", or a local folder) aren't looked up.
function tomlPackages(text, ecosystem, { skipLocal = false } = {}) {
  return text.split(/^\[\[package\]\]\s*$/m).slice(1).map((block) => {
    const head = block.split(/^\[(?!\[package\]\])/m)[0];
    const name = head.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = head.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const source = head.match(/^source\s*=\s*(.+)$/m)?.[1] || "";
    if (!name || !version) return null;
    if (skipLocal && (!source || /editable|virtual|directory|path\s*=/.test(source))) return null;
    if (/^category\s*=\s*"dev"/m.test(head)) return null;
    return { name, version, ecosystem };
  }).filter(Boolean);
}

// Reads the lock files found in the main folder. Returns { files, parts } or null when there are none.
export function readLockfiles(texts) {
  const files = [];
  const seen = new Map();
  for (const [file, text] of Object.entries(texts)) {
    const read = LOCKFILES[file];
    if (!read || !text) continue;
    let parts;
    try { parts = read(text); } catch { continue; } // cut off or broken file: skip it
    if (!parts.length) continue;
    files.push(file);
    for (const p of parts) seen.set(`${p.ecosystem}:${p.name.toLowerCase()}@${p.version}`, p);
  }
  return files.length ? { files, parts: [...seen.values()].slice(0, MAX_PARTS) } : null;
}

// Asks OSV which of these parts have known security holes. Returns null if OSV can't be reached,
// so a network problem never looks like a clean result.
export async function getKnownHoles(lock, osvUrl = OSV_URL) {
  if (!lock) return null;
  const vulnerable = new Map(); // part name -> hole ids
  try {
    for (let i = 0; i < lock.parts.length; i += 1000) {
      const batch = lock.parts.slice(i, i + 1000);
      const res = await fetch(osvUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries: batch.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version })) }),
      });
      if (!res.ok) return null;
      const j = await res.json();
      if (!Array.isArray(j.results)) return null;
      j.results.forEach((r, k) => {
        if (!r?.vulns?.length) return;
        const key = `${batch[k].name}@${batch[k].version}`;
        vulnerable.set(key, [...new Set([...(vulnerable.get(key) || []), ...r.vulns.map((v) => v.id)])]);
      });
    }
  } catch { return null; }
  return { files: lock.files, parts: lock.parts.length, vulnerable: [...vulnerable].map(([part, ids]) => ({ part, ids: ids.slice(0, 5) })) };
}

// OpenSSF Scorecard: a free, independent security check of public GitHub projects (scorecard.dev).
// Returns null when it has no data for this repo or can't be reached. Then "Security habits" shows as not checked.
export async function getScorecard(fullName) {
  // Scorecard stores some repos in lower case, so try that too.
  for (const name of [...new Set([fullName, fullName.toLowerCase()])]) {
    try {
      const res = await fetch(`https://api.scorecard.dev/projects/github.com/${name}`);
      if (!res.ok) continue;
      const j = await res.json();
      if (Array.isArray(j.checks)) return { date: j.date, checks: j.checks.map(({ name: n, score }) => ({ name: n, score })) };
    } catch { /* unreachable: treat as no data */ }
  }
  return null;
}

// Collects everything the scorer needs. Kept separate so tests can feed in saved data.
export async function collect(owner, repo, { token, osvUrl } = {}) {
  const r = await getJSON(`${API}/repos/${owner}/${repo}`, token);
  if (!r) { const e = new Error("That repo doesn't exist or is private."); e.code = "NOT_FOUND"; throw e; }
  // If GitHub's hourly limit hits halfway, stop. Scoring with missing files could make a bad repo look clean.
  const orEmpty = (empty) => (e) => { if (e.code === "RATE_LIMIT") throw e; return empty; };
  const [user, contents, releases] = await Promise.all([
    getJSON(`${API}/users/${r.owner.login}`, token).catch(orEmpty(null)),
    getJSON(`${API}/repos/${owner}/${repo}/contents/`, token).catch(orEmpty([])),
    getJSON(`${API}/repos/${owner}/${repo}/releases?per_page=5`, token).catch(orEmpty([])),
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
  // AI instructions in hidden folders (.claude/, .cursor/rules/, .github/copilot-instructions.md ...).
  const list = (path) => getJSON(`${API}/repos/${owner}/${repo}/contents/${path}`, token).then((x) => (Array.isArray(x) ? x : [])).catch(orEmpty([]));
  const folderFiles = [];
  for (const dir of AI_FOLDERS.filter((d) => files.some((f) => f.type === "dir" && f.name === d))) {
    const inside = await list(dir);
    folderFiles.push(...inside.filter((f) => f.type === "file" && AI_FOLDER_FILE.test(f.name)));
    if (dir === ".claude" || dir === ".cursor") {
      for (const sub of inside.filter((f) => f.type === "dir" && AI_SUBFOLDERS.includes(f.name))) {
        folderFiles.push(...(await list(sub.path)).filter((f) => f.type === "file" && /\.(md|mdc)$/i.test(f.name)));
      }
    }
  }
  await Promise.all(folderFiles.slice(0, AI_FILE_LIMIT).map(async (f) => {
    if (f.download_url) aiFiles[f.path] = await getText(f.download_url);
  }));
  const scorecard = await getScorecard(r.full_name || `${owner}/${repo}`);
  // Known security holes: only needed when Scorecard didn't already answer that question.
  let deps = null;
  if (!scorecard?.checks?.some((c) => c.name === "Vulnerabilities" && c.score >= 0)) {
    const lockTexts = {};
    await Promise.all(Object.keys(LOCKFILES).map(async (n) => {
      const f = files.find((x) => x.type === "file" && x.name === n);
      if (f?.download_url && (f.size || 0) <= LOCK_LIMIT) lockTexts[n] = await getText(f.download_url, LOCK_LIMIT);
    }));
    deps = await getKnownHoles(readLockfiles(lockTexts), osvUrl);
  }
  return { repo: r, user, files, releases: Array.isArray(releases) ? releases : [], readme, pkg, aiFiles, scorecard, deps };
}

// "Does it cost money?" Doesn't change the grade. Many projects are free on GitHub with paid extras elsewhere.
const PAID_WORDS = /\b(pricing|paid (plans?|tiers?|version|features)|pro (plan|version|tier)|premium (plan|features|version|tier)|enterprise (edition|plan|features|license|version)|subscriptions?|upgrade to (pro|premium|plus|a paid)|free (tier|trial|plan)|commercial license|cloud (version|plan)|hosted (version|plan)|\$\d+(\.\d\d)?\s*(\/|per)\s*(mo|month|user|seat))\b/gi;
const NEEDS_ACCOUNT = /\b(requires?|needs?|you('ll)? need)\s+(an?\s+)?(paid\s+|active\s+)?(\w+\s+)?(account|subscription|api[ _-]?key|license key)\b/i;
const PAID_FOLDERS = /^(ee|enterprise|premium|pro)$/i;

export function costs({ readme = "", about = "", files = [] }) {
  const text = about + "\n" + readme.replace(/https?:\/\/\S+/g, "");
  const words = [...new Set([...text.matchAll(PAID_WORDS)].map((m) => m[0].toLowerCase()))].slice(0, 4);
  const account = text.match(NEEDS_ACCOUNT)?.[0] || null;
  const folder = files.find((f) => f.type === "dir" && PAID_FOLDERS.test(f.name))?.name || null;
  return { mentionsPaid: words.length > 0 || Boolean(folder), words, account, folder };
}

// Turns collected data into a score. Pure function: same input, same output.
export function score(data) {
  const { repo: r, user, files, releases, readme, pkg, aiFiles, scorecard, deps } = data;
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
    user ? `${user.type === "Organization" ? "Organization" : "Account"} created ${ownerAge >= 365 ? Math.round(ownerAge / 365 * 10) / 10 + " years" : Math.round(ownerAge) + " days"} ago.` : "Couldn't read the owner's profile.");

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
  // A standard open-source license, a license file with the owner's own terms (common for company products), or nothing.
  const standardLicense = r.license && r.license.spdx_id && r.license.spdx_id !== "NOASSERTION";
  const customLicense = !standardLicense && (r.license || files.some((f) => f.type === "file" && /^(licen[sc]e|copying)(\.|$)/i.test(f.name)));
  add("Transparency", "License", standardLicense ? 5 : customLicense ? 3 : 0, 5, standardLicense ? "good" : "warn",
    standardLicense ? `Uses the ${r.license.spdx_id} license.`
      : customLicense ? "Has its own license, not a standard open-source one. Read its terms before using it at work or in a product."
        : "No license. Legally you may not be allowed to use it.");
  const readmeLen = readme.length;
  add("Transparency", "Instructions", readmeLen > 1500 ? 5 : readmeLen > 300 ? 3 : 0, 5, readmeLen > 1500 ? "good" : "warn",
    readmeLen ? "Has a README that explains the project." : "No README. You can't tell what it does.");
  const hasSecurity = files.some((f) => /^security(\.md)?$/i.test(f.name));
  add("Transparency", "Security contact", hasSecurity ? 5 : 2, 5, hasSecurity ? "good" : "warn",
    hasSecurity ? "Tells people how to report security problems." : "No security policy file.");

  // 4. Security habits (10), from OpenSSF Scorecard. Scores are 0-10; -1 means Scorecard couldn't tell.
  const sc = (name) => { const c = scorecard?.checks?.find((x) => x.name === name); return c && c.score >= 0 ? c.score : null; };
  const review = sc("Code-Review");
  if (review !== null) {
    add("Security habits", "Code review", Math.round(review * 0.3), 3, review >= 8 ? "good" : review >= 4 ? "warn" : "bad",
      review >= 8 ? "Almost every change is checked by a second person before it goes in."
        : review >= 4 ? "Some changes go in without a second person checking them." : "Most changes go in without anyone else checking them.");
  }
  const vulns = sc("Vulnerabilities");
  if (vulns !== null) {
    const open = 10 - vulns;
    add("Security habits", "Known security holes", Math.round(vulns * 0.3), 3, vulns === 10 ? "good" : vulns >= 7 ? "warn" : "bad",
      vulns === 10 ? "No known security holes left unfixed." : `About ${open} known security hole${open > 1 ? "s" : ""} still unfixed${open >= 10 ? " (10 or more)" : ""}.`);
  }
  // No Scorecard answer: use our own lookup of the project's parts in OSV.
  // Gentler than Scorecard's version on purpose: big projects use hundreds of parts, OSV lists every known
  // hole however minor, and we can't tell which ones the project actually reaches. So a few holes cost a
  // little, many make this area a C, which keeps the overall grade at B at best (weakest-link rule). Never lower.
  if (vulns === null && deps) {
    const n = deps.vulnerable.length;
    const first = deps.vulnerable.slice(0, 2).map((x) => x.part).join(", ");
    add("Security habits", "Known security holes", n === 0 ? 5 : n < 5 ? 4 : 3, 5, n === 0 ? "good" : "warn",
      n === 0 ? `None of the ${deps.parts.toLocaleString("en")} parts it uses has a known security hole.`
        : `${n} of the ${deps.parts.toLocaleString("en")} parts it uses ${n > 1 ? "have" : "has"} a known security hole (for example ${first}). Not every hole affects you, but the owner should update them.`);
  }
  // Only the clearly dangerous setups count. Loose token permissions are too common to tell projects apart.
  const auto = sc("Dangerous-Workflow");
  if (auto !== null) {
    add("Security habits", "Safe automation", Math.round(auto * 0.4), 4, auto >= 8 ? "good" : auto >= 4 ? "warn" : "bad",
      auto >= 8 ? "Its build-and-publish robots are set up safely." : "Its build-and-publish robots are set up in a way attackers have used to take over projects.");
  }

  // 5. Red flags (30, deductions). Some are "hard" flags that cap the final score.
  let flagPts = 30;
  let cap = 100;
  let capReason = null;
  const softCap = (why, n) => { if (n < cap) { cap = n; capReason = why; } };
  const flags = [];
  const flag = (label, minus, note, hardCap) => {
    flagPts -= minus; flags.push({ label, note, severity: hardCap ? "high" : minus >= 8 ? "medium" : "low" });
    if (hardCap) softCap("flag", hardCap);
  };
  // Everything the owner wrote about the repo: name, description, topics, README and release notes.
  const releaseNotes = releases.map((x) => x.body || "").join("\n");
  const about = [r.name, r.description, ...(r.topics || [])].filter(Boolean).join(" ").replace(/[-_.]+/g, " ");
  const text = about + "\n" + readme + "\n" + releaseNotes;
  // A sentence that forbids or warns against cracks ("cracked copies are not allowed") isn't offering one.
  const NEGATED = /\b(not\s+(allowed|permitted|supported|authori[sz]ed)|unauthori[sz]ed|prohibited|forbidden|illegal|never|don'?t|do\s+not|violat\w*|against\s+(our|the)\s+(terms|rules|license))\b/i;
  // Sentences often wrap across lines in a README, so join wrapped lines first (not lists or headings).
  const joined = text.replace(/([^\n])\n(?!\n|\s*([-*+>#|]|\d+\.))/g, "$1 ");
  const scamSentence = joined.split(/(?<=[.!?])\s+|\n/).find((sentence) => SCAM_WORDS.some((re) => re.test(sentence)) && !NEGATED.test(sentence));
  const scam = scamSentence && SCAM_WORDS.map((re) => scamSentence.match(re)).find(Boolean);
  if (scam) flag("Scam-style wording", 15, `Mentions cracks, cheats, keygens or free premium. Most malware on GitHub looks like this. We found: "…${around(scamSentence, scam)}…"`, 35);
  if (DISABLE_AV.test(text)) flag("Asks you to turn off antivirus", 30, "Real software never needs this. This is the #1 sign of malware.", 15);
  // A password in the notes of a release that offers an archive counts too, even if the notes never say "zip".
  const lockedRelease = releases.find((x) => (x.assets || []).some((a) => ARCHIVE_FILE.test(a.name || "")) && PASSWORD_GIVEN.test(x.body || ""));
  const pwLine = zipPassword(text) || (lockedRelease && around(lockedRelease.body, lockedRelease.body.match(PASSWORD_GIVEN)));
  if (pwLine) flag("Password-protected download", 15, `Passwords on zip files stop antivirus from looking inside. We found: "${pwLine.trim().slice(0, 140)}"`, 30);
  const riskyRoot = files.filter((f) => f.type === "file" && RISKY_FILE.test(f.name)).map((f) => f.name);
  const riskyAssets = releases.flatMap((x) => (x.assets || []).map((a) => a.name)).filter((n) => RISKY_FILE.test(n));
  if (riskyRoot.length) flag("Programs sitting in the code", 10, `Ready-to-run files in the main folder: ${riskyRoot.slice(0, 3).join(", ")}. Source code projects rarely do this.`, stars < 100 ? 40 : null);
  if (riskyAssets.length && stars < 100) flag("Unknown programs to download", 8, `Releases offer ${riskyAssets.slice(0, 3).join(", ")} from a little-known project.`);
  if (PIPE_TO_SHELL.test(readme)) flag("Runs a script straight from the internet", 3, "The install step downloads and runs code in one line. Common with real tools too, but you can't see what runs.");
  // Pictures and badge icons are often stored as encoded text (also inside links, as %2B for "+"). Those are fine.
  // Diagram links (mermaid.live, kroki) also carry long encoded text inside the address. Links are left out too.
  const readmeNoImages = readme.replace(/base64,[A-Za-z0-9+/=%]+/gi, "").replace(/https?:\/\/[^\s)"'<>\]]+/gi, "");
  const encoded = readmeNoImages.match(LONG_BASE64);
  if (encoded) flag("Hidden encoded text", 10, `The README contains a long scrambled block of text. That can hide commands. It starts with "${encoded[0].slice(0, 40)}…".`);
  // Big companies launch repos that get famous in days, so only accounts with no long history are suspect.
  // It's a warning, not proof: it keeps the grade at C or below but doesn't mark the repo Dangerous by itself.
  const establishedOwner = user && (user.type === "Organization" || ownerAge > 730);
  if (age < 30 && stars > 500 && !establishedOwner) {
    flag("Suspiciously fast fame", 12, `${stars} stars in ${Math.round(age)} days from a young account. Fake stars are bought to make malware look popular.`);
    softCap("fame", 69);
  }
  if (user && ownerAge < 30) flag("Brand-new owner account", 8, "The account behind it is less than a month old.");
  try {
    const scripts = pkg ? JSON.parse(pkg).scripts || {} : {};
    const hooks = ["preinstall", "install", "postinstall"].filter((k) => scripts[k]);
    if (hooks.length) flag("Runs code during install", 4, `package.json runs "${scripts[hooks[0]].slice(0, 60)}" the moment you install it.`);
  } catch { /* not valid JSON, ignore */ }

  // AI-agent check: instruction files that could hijack your AI assistant.
  const aiNames = Object.keys(aiFiles);
  const injected = aiNames.filter((n) => PROMPT_INJECTION.some((re) => re.test(aiFiles[n])) || LONG_BASE64.test(aiFiles[n]));
  if (injected.length) {
    // Quote the line we found, so anyone can check our work.
    const text = aiFiles[injected[0]];
    const hit = PROMPT_INJECTION.map((re) => text.match(re)).find(Boolean);
    const line = hit ? text.slice(0, hit.index).split("\n").length : null;
    const quote = hit ? text.split("\n")[line - 1].trim().slice(0, 140) : "a long block of scrambled text";
    flag("Could hijack your AI assistant", 25, `${injected.join(", ")} contains instructions that try to override your AI, hide things from you, or send data away. ${hit ? `Line ${line} of ${injected[0]}: "${quote}"` : `It contains ${quote}.`}`, 20);
  }
  const hidden = aiNames.filter((n) => !injected.includes(n) && HIDDEN_CHARS.test(aiFiles[n].replace(/^\uFEFF/, "")));
  if (hidden.length) flag("Hidden text for your AI", 25, `${hidden.join(", ")} contains invisible characters. Your AI can read them, you can't. This is a known way to hide instructions.`, 20);

  flagPts = Math.max(0, flagPts);
  add("Red flags", flags.length ? `${flags.length} warning sign${flags.length > 1 ? "s" : ""}` : "No warning signs found", flagPts, 30,
    flagPts >= 25 ? "good" : flagPts >= 15 ? "warn" : "bad", flags.length ? "Each one is explained under Warning signs." : "We didn't find any of the common malware tricks.");

  // Paperwork (license, README, security file) takes minutes to add. Without real users, the best grade is C.
  if (stars < 50) softCap("users", 69);
  // Nobody fixes an archived project, and a year without changes means no security fixes either.
  if (r.archived) softCap("archived", 69);
  else if (lastPush > 365) softCap("stale", 84);
  // Without a license you may not be allowed to use it at all.
  if (!standardLicense && !customLicense) softCap("license", 84);

  // Weakest link: the overall grade can be at most one letter better than the weakest safety area.
  // So lots of stars can't cover for a project nobody looks after.
  // "Is it open about itself?" is left out: missing paperwork (license, security file) lowers the points
  // and a missing license caps at B, but it doesn't make a project unsafe.
  const areas = areaGrades(checks);
  const [weakGroup, weak] = Object.entries(areas).filter(([g]) => g !== "Transparency").sort((a, b) => LETTERS.indexOf(b[1].grade) - LETTERS.indexOf(a[1].grade))[0];
  const weakIdx = LETTERS.indexOf(weak.grade);
  if (weakIdx >= 2) softCap("weak", TOP[LETTERS[weakIdx - 1]]);

  // Points are out of 100. When the security check had no data, the other areas are scaled up to 100.
  const got = checks.reduce((s, c) => s + c.points, 0);
  const max = checks.reduce((s, c) => s + c.max, 0);
  const raw = Math.round((100 * got) / max);
  const total = Math.max(0, Math.min(cap, raw));
  const grade = gradeOf(total);
  // A low score can mean two different things. "Dangerous" means we found malware tricks.
  // "Unproven" means nothing looks wrong, the project is just too new or little-known to trust yet.
  const dangerous = flags.some((f) => f.severity === "high") || flagPts <= 15;
  // D or F without malware tricks: "Unproven" when the weak spot is that few people use it,
  // "Be careful" when it's something else (abandoned, poor security habits...).
  const littleKnown = ["D", "F"].includes(areas.Reputation?.grade) || stars < 50;
  const level = dangerous ? "dangerous"
    : grade === "A" ? "trusted" : grade === "B" ? "fine" : grade === "C" || !littleKnown ? "careful" : "unproven";
  const { label, verdict } = LEVELS[level];

  return {
    name: r.full_name,
    url: r.html_url,
    description: r.description || "",
    score: total,
    grade,
    level,
    label,
    verdict,
    capped: cap < raw ? cap : null,
    capReason: cap < raw ? {
      flag: "it has a serious warning sign", fame: "it got famous suspiciously fast", users: "fewer than 50 people have starred it",
      archived: "the owner archived it, so nobody fixes problems anymore", stale: "nobody has changed it in over a year",
      license: "it has no license", weak: `its weakest area ("${GROUPS[weakGroup] || weakGroup}") only gets ${/^[AEF]/.test(weak.grade) ? "an" : "a"} ${weak.grade}`,
    }[capReason] : null,
    areas,
    securityChecked: Boolean(areas["Security habits"]),
    checks,
    flags,
    aiFilesFound: aiNames,
    costs: costs({ readme, about, files }),
    checkedAt: new Date().toISOString(),
  };
}

export async function checkRepo(input, opts = {}) {
  const p = parseRepo(input);
  if (!p) { const e = new Error("Paste a GitHub link like github.com/owner/repo."); e.code = "BAD_INPUT"; throw e; }
  const data = await collect(p.owner, p.repo, opts);
  return score(data);
}
