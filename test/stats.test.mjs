// Checks the visitor counter (stats.js). Run with: node test/stats.test.mjs
import worker from "../worker.js";
import { sourceOf } from "../stats.js";
import assert from "node:assert";

const store = new Map();
const kv = { get: async (k, t) => (store.has(k) ? (t === "json" ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => store.set(k, v) };
const env = { INSTAGRAM: kv, ASSETS: { fetch: async (req) => new URL(req.url).pathname === "/data/directory.json"
  ? new Response(JSON.stringify({ repos: [] }))
  : new Response("<html><title>x</title></html>", { headers: { "Content-Type": "text/html" } }) } };
const jobs = [];
const ctx = { waitUntil: (p) => jobs.push(p) };
const visit = async (path, headers = {}, init = {}) => {
  const res = await worker.fetch(new Request("https://safetoclone.com" + path, { headers: { "User-Agent": "Mozilla/5.0", ...headers }, ...init }), env, ctx);
  await Promise.all(jobs.splice(0));
  return res;
};

// Where people come from: our own ?ref= tag first, then the linking site.
assert.equal(sourceOf(new Request("https://safetoclone.com/?ref=Reddit")), "reddit");
assert.equal(sourceOf(new Request("https://safetoclone.com/", { headers: { Referer: "https://www.news.ycombinator.com/item?id=1" } })), "news.ycombinator.com");
assert.equal(sourceOf(new Request("https://safetoclone.com/", { headers: { Referer: "https://safetoclone.com/repos" } })), "");
assert.equal(sourceOf(new Request("https://safetoclone.com/?ref=<script>")), "");

await visit("/?ref=reddit");
await visit("/", { Referer: "https://news.ycombinator.com/" });
await visit("/", { "User-Agent": "Googlebot/2.1" }); // bots don't count
await visit("/api/hit", { "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ event: "check" }) });
const bad = await visit("/api/hit", {}, { method: "POST", body: JSON.stringify({ event: "home" }) });
assert.equal(bad.status, 400); // the browser can only report on-page events, not fake page views

// An AI agent checking grades through /mcp counts as agent_mcp, even when it looks like a bot.
await visit("/mcp", { "User-Agent": "python-httpx/0.27", "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_safety_scores" } }) });
// Asking about posts is not a repo check.
await visit("/mcp", { "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_upcoming_posts" } }) });

const stats = await (await visit("/api/stats")).json();
assert.equal(stats.total.events.agent_mcp, 1);
assert.equal(stats.total.events.home, 2);
assert.equal(stats.total.events.check, 1);
assert.deepEqual(stats.total.sources, { reddit: 1, "news.ycombinator.com": 1 });

// Without the KV store (tests, previews) nothing breaks.
const plain = await worker.fetch(new Request("https://safetoclone.com/api/stats"), {});
assert.equal(plain.status, 200);
console.log("stats tests passed");
