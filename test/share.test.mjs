// Checks shared result links (safetoclone.com/?repo=owner/name) get the right link preview. Run with: node test/share.test.mjs
import worker, { shareRepoName } from "../worker.js";
import { GRADES } from "../score.js";
import { SIGNUP_PROMISE } from "../report.js";
import assert from "node:assert";
import { readFile, access } from "node:fs/promises";

// Pretend to be Cloudflare's file server: read files from this folder ("/" means index.html).
const env = {
  ASSETS: {
    async fetch(req) {
      let path = new URL(req.url).pathname;
      if (path === "/") path = "/index.html";
      try {
        const type = path.endsWith(".html") ? "text/html; charset=utf-8" : "application/json";
        return new Response(await readFile(new URL(".." + path, import.meta.url)), { headers: { "Content-Type": type } });
      } catch { return new Response("Not found", { status: 404 }); }
    },
  },
};
const get = async (q) => (await worker.fetch(new Request("https://safetoclone.com/" + q), env)).text();
const meta = (html, key) => html.match(new RegExp(`<meta (?:property|name)="${key}" content="([^"]*)"`))?.[1];

// Links people might paste are cleaned up; anything else is ignored.
assert.equal(shareRepoName("ollama/ollama"), "ollama/ollama");
assert.equal(shareRepoName("https://github.com/ollama/ollama.git"), "ollama/ollama");
assert.equal(shareRepoName("<script>/x"), null);
assert.equal(shareRepoName("a/b/c"), null);

// The plain home page keeps its normal preview.
const home = await get("");
assert.equal(meta(home, "og:image"), "https://safetoclone.com/share/default.png");
assert.equal(meta(home, "og:url"), "https://safetoclone.com/");

// A repo from the nightly directory shows its grade and the matching picture.
const dir = JSON.parse(await readFile(new URL("../data/directory.json", import.meta.url), "utf8"));
const known = dir.repos[0];
const page = await get(`?repo=${known.name.toLowerCase()}`);
assert.ok(meta(page, "og:title").includes(`grade ${known.grade}`));
assert.equal(meta(page, "og:url"), `https://safetoclone.com/?repo=${known.name}`);
assert.equal(meta(page, "og:image"), `https://safetoclone.com/share/${known.grade}-${known.level}.png`);

// A repo we haven't graded gets a question, never a made-up grade.
const unknown = await get("?repo=someone/brand-new-thing&grade=A");
assert.equal(meta(unknown, "og:title"), "Is someone/brand-new-thing safe to download? Check it on SafeToClone");
assert.equal(meta(unknown, "og:image"), "https://safetoclone.com/share/default.png");

// Junk in the link can't break the page.
const junk = await get('?repo="><script>alert(1)</script>');
assert.ok(!junk.includes("<script>alert(1)"));
assert.equal(meta(junk, "og:url"), "https://safetoclone.com/");

// Every preview picture the Worker can point to exists.
for (const g of ["default", ...["A-trusted", "B-fine", "C-careful", "D-unproven", "F-unproven"], ..."ABCDF".split("").map((x) => `${x}-dangerous`)]) {
  await access(new URL(`../share/${g}.png`, import.meta.url));
}
// The home page: Google's question-and-answer data must match the questions people can see, word for word.
const faq = JSON.parse(home.match(/<script type="application\/ld\+json">\s*(\{"@context":"https:\/\/schema.org","@type":"FAQPage"[\s\S]*?)<\/script>/)[1]);
for (const q of faq.mainEntity) {
  assert.ok(home.includes(`<summary>${q.name}</summary>`), `visible question: ${q.name}`);
  assert.ok(home.includes(`<p>${q.acceptedAnswer.text}</p>`), `visible answer for: ${q.name}`);
}
// "What the grades mean" uses the same cut-offs as score.js.
for (const [g, min] of GRADES.slice(0, 3)) assert.ok(home.includes(`<span class="g">${g}<span class="range">${min}–`), `grade ${g} range`);
assert.ok(!home.includes("fonts.googleapis.com"), "no outside fonts");
// The site's own fonts: every font site.css loads must be in fonts/, and nothing comes from another website.
const css = await readFile(new URL("../site.css", import.meta.url), "utf8");
const fontFiles = [...css.matchAll(/url\("\/(fonts\/[^"]+)"\)/g)].map((m) => m[1]);
assert.ok(fontFiles.length >= 2, "site.css loads its fonts from /fonts");
for (const f of fontFiles) await access(new URL("../" + f, import.meta.url));
assert.ok(!/url\(["']?https?:/.test(css), "site.css loads nothing from other websites");
// The home page's email band promises exactly what every other signup box promises, and says which box it is.
const raw = await readFile(new URL("../index.html", import.meta.url), "utf8");
const band = raw.slice(raw.indexOf('id="newsletter"'), raw.indexOf("</section>", raw.indexOf('id="newsletter"')));
const items = (h) => [...h.matchAll(/<li>([^<]+)<\/li>/g)].map((m) => m[1]);
assert.ok(items(SIGNUP_PROMISE).length >= 3);
assert.deepEqual(items(band), items(SIGNUP_PROMISE), "home email band and SIGNUP_PROMISE list the same things");
assert.ok(band.includes('<input type="hidden" name="from" value="home">'));
// The email band comes right after the directory, not at the bottom of the page.
assert.ok(raw.indexOf('id="newsletter"') < raw.indexOf('id="method"') && raw.indexOf('id="newsletter"') > raw.indexOf('id="directory"'));
console.log("Share tests passed");
