// Checks that the robot reads posts from the private HQ repo, and that /ig-media/ only hands out
// pictures of queued posts (never other HQ files). Run with: node test/hq.test.mjs
import worker from "../worker.js";
import assert from "node:assert";

const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });
const hq = {
  "instagram/posts.json": JSON.stringify({ posts: [
    { id: "t", date: today, images: ["instagram/images/t/1.jpg", "instagram/images/t/2.jpg"], alts: ["one", "two"], caption: "Today" },
    { id: "old", date: "2020-01-01", image: "instagram/images/old.jpg", alt: "old", caption: "Old" },
  ] }),
  "instagram/images/t/1.jpg": "JPEG1",
  "instagram/images/old.jpg": "OLD",
  "agents/claude/inbox/secret.md": "private",
};
let githubCalls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  assert.equal(u.hostname, "api.github.com");
  githubCalls.push({ path: u.pathname, auth: opts.headers?.Authorization });
  const path = decodeURIComponent(u.pathname.replace("/repos/emiliomadeit/safetoclone-hq/contents/", ""));
  return path in hq ? new Response(hq[path]) : new Response("Not Found", { status: 404 });
};
const env = {
  HQ_GITHUB_TOKEN: "hq-key",
  ASSETS: { async fetch() { return new Response(JSON.stringify({ posts: [{ id: "local", date: today, image: "x.jpg", caption: "Local" }] })); } },
};
const get = (path, e = env) => worker.fetch(new Request("https://safetoclone.com" + path), e);
const mcp = async (e) => {
  const r = await worker.fetch(new Request("https://safetoclone.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_next_post" } }) }), e);
  return JSON.parse((await r.json()).result.content[0].text);
};

// With the key: today's post comes from HQ, pictures point at /ig-media/.
let post = await mcp(env);
assert.equal(post.id, "t");
assert.deepEqual(post.image_urls, ["https://safetoclone.com/ig-media/instagram/images/t/1.jpg", "https://safetoclone.com/ig-media/instagram/images/t/2.jpg"]);
assert.ok(githubCalls.every((c) => c.auth === "Bearer hq-key"));

// /ig-media/ serves a queued picture...
let r = await get("/ig-media/instagram/images/t/1.jpg");
assert.equal(r.status, 200);
assert.equal(await r.text(), "JPEG1");
assert.equal(r.headers.get("Content-Type"), "image/jpeg");
// ...but never other HQ files, old posts' pictures, or tricks with ../
for (const bad of ["/ig-media/agents/claude/inbox/secret.md", "/ig-media/instagram/posts.json", "/ig-media/instagram/images/old.jpg", "/ig-media/instagram/images/t/../../../agents/claude/inbox/secret.md"]) {
  assert.equal((await get(bad)).status, 404, bad);
}

// Without the key: falls back to the website copy, and /ig-media/ is off.
post = await mcp({ ASSETS: env.ASSETS });
assert.equal(post.id, "local");
assert.equal(post.image_url, "https://safetoclone.com/x.jpg");
assert.equal((await get("/ig-media/instagram/images/t/1.jpg", { ASSETS: env.ASSETS })).status, 404);

// GitHub down: falls back to the website copy instead of missing the day.
globalThis.fetch = async () => new Response("Bad Gateway", { status: 502 });
post = await mcp(env);
assert.equal(post.id, "local");

console.log("HQ tests passed");
