// Checks shared result links (safetoclone.com/?repo=owner/name) get the right link preview. Run with: node test/share.test.mjs
import worker, { shareRepoName } from "../worker.js";
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
console.log("Share tests passed");
