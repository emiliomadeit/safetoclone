// Checks the pages built for Google: /repo/owner/name, /repos and /sitemap.xml. Run with: node test/seo.test.mjs
import worker from "../worker.js";
import { repoPage } from "../seo.js";
import { LEVELS, WHY } from "../score.js";
import assert from "node:assert";
import { readFile } from "node:fs/promises";

// Pretend to be Cloudflare's file server: read files from this folder.
const env = {
  ASSETS: {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      try { return new Response(await readFile(new URL(".." + path, import.meta.url))); }
      catch { return new Response("Not found", { status: 404 }); }
    },
  },
};
const get = (path) => worker.fetch(new Request("https://safetoclone.com" + path), env);
const dir = JSON.parse(await readFile(new URL("../data/directory.json", import.meta.url), "utf8"));
const first = dir.repos[0];

// Every graded repo has its own page with a clear title, a canonical address and structured data.
for (const r of dir.repos) {
  const res = await get(`/repo/${r.name}`);
  assert.equal(res.status, 200, r.name);
  const html = await res.text();
  assert.ok(html.includes(`<title>Is ${r.name} safe to download? Grade ${r.grade}`), r.name);
  assert.ok(html.includes(`<link rel="canonical" href="https://safetoclone.com/repo/${r.name}">`), r.name);
  assert.ok(html.includes(`<h1>Is ${r.name} safe to download?</h1>`), r.name);
  const desc = html.match(/<meta name="description" content="([^"]*)"/)[1].replace(/&[#a-z0-9]+;/g, "x");
  assert.ok(desc.length <= 160 && desc.length > 50, `description length for ${r.name}`);
  // Structured data must be valid JSON.
  for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([^<]*)<\/script>/g)) JSON.parse(json);
  // Visitors can go straight to the repo on GitHub, and get told what to do.
  assert.ok(html.includes(`href="${r.url || `https://github.com/${r.name}`}" target="_blank" rel="noopener">View on GitHub`), `GitHub button for ${r.name}`);
  assert.ok(html.includes(LEVELS[r.level].advice.replace(/'/g, "&#39;")), `advice for ${r.name}`);
  assert.ok(html.includes('<link rel="stylesheet" href="/site.css">'));
}

// Wrong upper/lower case or a trailing slash sends you to the one real address.
const moved = await get(`/repo/${first.name.toLowerCase()}/`);
assert.equal(moved.status, 301);
assert.equal(moved.headers.get("Location"), `https://safetoclone.com/repo/${first.name}`);

// A repo we haven't graded: friendly page, 404, and hidden from Google.
const missing = await get("/repo/someone/brand-new-thing");
assert.equal(missing.status, 404);
const missingHtml = await missing.text();
assert.ok(missingHtml.includes('<meta name="robots" content="noindex">'));
assert.ok(missingHtml.includes('href="/?repo=someone/brand-new-thing"'));
assert.equal((await get("/repo/%E0%A4%A")).status, 404);
assert.ok(!(await (await get('/repo/"><script>alert(1)</script>')).text()).includes("<script>alert(1)"));

// The list page links to every repo page.
const list = await (await get("/repos")).text();
for (const r of dir.repos) assert.ok(list.includes(`href="/repo/${r.name}"`), r.name);

// The sitemap lists the home page, the list page and every repo page.
const sm = await get("/sitemap.xml");
assert.ok(sm.headers.get("Content-Type").includes("xml"));
const xml = await sm.text();
const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
assert.equal(locs.length, dir.repos.length + 2);
assert.ok(locs.includes("https://safetoclone.com/repos"));
assert.ok(locs.includes(`https://safetoclone.com/repo/${first.name}`));

// Full details from the nightly build (warnings with notes, checks) show up on the page. Text is escaped.
const rich = repoPage({
  name: "example/tool", url: "https://github.com/example/tool", description: "A <b>tool</b>", score: 30, grade: "F", level: "dangerous",
  label: "Dangerous", verdict: "Don't download this. It shows signs of malware.", flags: ["Asks you to turn off antivirus"],
  warnings: [{ label: "Asks you to turn off antivirus", note: "Real software never needs this.", severity: "high" }],
  checks: [{ group: "Reputation", label: "Stars", points: 3, max: 15, level: "bad", note: "12 people starred it." }],
  capReason: "it has a serious warning sign", checkedAt: "2026-10-21T07:00:00Z",
}, dir);
assert.ok(rich.includes("Real software never needs this."));
assert.ok(rich.includes("12 people starred it."));
assert.ok(rich.includes("A &lt;b&gt;tool&lt;/b&gt;"));
assert.ok(rich.includes("share/F-dangerous.png"));
// "Why this grade" explains the score, the cap and why each check matters.
assert.ok(rich.includes("Why this grade?"));
assert.ok(rich.includes("but the score is capped at 30 because it has a serious warning sign"));
assert.ok(rich.includes(WHY.Stars.replace(/'/g, "&#39;")));

// The rest of the site is untouched.
assert.equal((await get("/robots.txt")).status, 200);
console.log("SEO tests passed");
