// Checks the visitor counter (stats.js). Run with: node test/stats.test.mjs
import worker from "../worker.js";
import { sourceOf, EVENTS, count } from "../stats.js";
import assert from "node:assert";

const store = new Map();
const kv = { get: async (k, t) => (store.has(k) ? (t === "json" ? JSON.parse(store.get(k)) : store.get(k)) : null), put: async (k, v) => store.set(k, v), delete: async (k) => store.delete(k) };
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
await visit("/api/hit", { "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ event: "check_busy" }) });
const bad = await visit("/api/hit", {}, { method: "POST", body: JSON.stringify({ event: "home" }) });
assert.equal(bad.status, 400); // the browser can only report on-page events, not fake page views

// An AI agent checking grades through /mcp counts as agent_mcp, even when it looks like a bot.
await visit("/mcp", { "User-Agent": "python-httpx/0.27", "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_safety_scores" } }) });
// Asking about posts is not a repo check.
await visit("/mcp", { "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_upcoming_posts" } }) });

// The newsletter rating: three known votes, counted per day. Test copies, other words and POSTs don't count,
// and nothing from the address is shown back.
let thanks = await visit("/newsletter/rate/love");
assert.match(await thanks.text(), /Thanks!/);
await visit("/newsletter/rate/love");
await visit("/newsletter/rate/soso");
await visit("/newsletter/rate/good?test=1");
await visit("/newsletter/rate/home");
await visit("/newsletter/rate/%3Cscript%3E");
await visit("/newsletter/rate/love", {}, { method: "POST" });
await visit("/newsletter/rate/love", { "User-Agent": "Googlebot/2.1" });

const stats = await (await visit("/api/stats")).json();
assert.equal(stats.total.events.nl_love, 2);
assert.equal(stats.total.events.nl_soso, 1);
assert.equal(stats.total.events.nl_good, undefined);
assert.ok(Object.keys(stats.total.events).every((k) => EVENTS.includes(k)));
assert.equal(stats.total.events.agent_mcp, 1);
assert.equal(stats.total.events.home, 2);
assert.equal(stats.total.events.check, 1);
assert.equal(stats.total.events.check_busy, 1);
assert.deepEqual(stats.total.sources, { reddit: 1, "news.ycombinator.com": 1 });

// A busy day can't use up the KV store's daily writes: past 150 events, most are skipped and the rest count for more.
{
  const writes = []; const data = new Map();
  const kv2 = { get: async (k) => (data.has(k) ? JSON.parse(data.get(k)) : null), put: async (k, v) => { writes.push(k); data.set(k, v); } };
  const day = new Date().toISOString().slice(0, 10);
  data.set(`stats:${day}`, JSON.stringify({ events: { home: 3000 }, sources: {} }));
  const req = new Request("https://safetoclone.com/", { headers: { "User-Agent": "Mozilla/5.0" } });
  await count({ INSTAGRAM: kv2 }, req, "home", "", () => 0.5);   // unlucky draw: skipped, no write
  assert.equal(writes.length, 0);
  await count({ INSTAGRAM: kv2 }, req, "home", "reddit", () => 0.01); // lucky draw: counts for 3000/150 = 20
  assert.equal(writes.length, 1);
  assert.deepEqual(JSON.parse(data.get(`stats:${day}`)).events, { home: 3020 });
  assert.equal(JSON.parse(data.get(`stats:${day}`)).sources.reddit, 20);
  await count({ INSTAGRAM: kv2 }, req, "signup", "", () => 0.5);  // signups always count, even on a busy day
  assert.equal(JSON.parse(data.get(`stats:${day}`)).events.signup, 1);
  // A quiet day counts every event, one each.
  data.clear(); writes.length = 0;
  for (let i = 0; i < 100; i++) await count({ INSTAGRAM: kv2 }, req, "home", "", () => 0.99);
  assert.equal(JSON.parse(data.get(`stats:${day}`)).events.home, 100);
}

// Without the KV store (tests, previews) nothing breaks.
const plain = await worker.fetch(new Request("https://safetoclone.com/api/stats"), {});
assert.equal(plain.status, 200);

// ---- /api/watch: "tell me when alerts launch" is its own list, never the newsletter ----
const resendCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, ...rest) => (String(u).includes("resend.com") ? (resendCalls.push(String(u)), new Response("{}", { status: 200 })) : realFetch(u, ...rest));
const wenv = { ...env, RESEND_API_KEY: "re_test" }; // a key is present, so any accidental newsletter signup would show up as a Resend call
const watchPost = async (body, { form = false, e = wenv } = {}) => {
  const init = form
    ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" }, body: new URLSearchParams(body).toString() }
    : { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }, body: JSON.stringify(body) };
  const res = await worker.fetch(new Request("https://safetoclone.com/api/watch", init), e, ctx);
  await Promise.all(jobs.splice(0));
  return res;
};
const today = new Date().toISOString().slice(0, 10);
const statsToday = () => JSON.parse(store.get(`stats:${today}`)).events;
const signupsBefore = statsToday().signup || 0;

let w = await watchPost({ email: " Ann@Example.com ", repo: "git clone https://github.com/torvalds/linux" });
assert.equal(w.status, 200);
let kept = JSON.parse(store.get(`watch:${today}`));
assert.equal(kept.length, 1);
assert.equal(kept[0].email, "ann@example.com", "trimmed and lower-cased");
assert.equal(kept[0].repo, "torvalds/linux", "the repo goes through the same link reading as the checker");
assert.equal(statsToday().watch_signup, 1);
assert.equal(statsToday().signup || 0, signupsBefore, "never counted as a newsletter subscriber");
assert.equal(resendCalls.length, 0, "nothing reaches Resend, so nobody lands in the Sunday list");

w = await watchPost({ email: "ann@example.com", repo: "torvalds/linux" });
assert.equal(w.status, 200);
assert.equal(JSON.parse(store.get(`watch:${today}`)).length, 1, "the same email and repo is kept once");
await watchPost({ email: "ann@example.com", repo: "git/git" });
assert.equal(JSON.parse(store.get(`watch:${today}`)).length, 2, "the same email can watch another repo");

assert.equal((await watchPost({ email: "not-an-email", repo: "torvalds/linux" })).status, 400);
assert.equal((await watchPost({ email: "a".repeat(250) + "@example.com", repo: "torvalds/linux" })).status, 400, "too long");
assert.equal((await watchPost({ email: "bob@example.com", repo: "https://example.com/a/b" })).status, 400, "only GitHub repos");
assert.equal((await watchPost({ email: "bob@example.com" })).status, 400);
assert.equal(JSON.parse(store.get(`watch:${today}`)).length, 2, "refused sign-ups save nothing");

// One address can't fill the day, and the day has a hard ceiling (writes are shared with the newsletter's send-lock).
store.set(`watch:${today}`, JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ email: "many@example.com", repo: `o/r${i}`, at: "x" }))));
assert.equal((await watchPost({ email: "many@example.com", repo: "o/another" })).status, 429);
store.set(`watch:${today}`, JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ email: `u${i}@example.com`, repo: "o/r", at: "x" }))));
const before = store.get(`watch:${today}`);
assert.equal((await watchPost({ email: "late@example.com", repo: "o/r" })).status, 503);
assert.equal(store.get(`watch:${today}`), before, "past the ceiling nothing more is written");
store.delete(`watch:${today}`);

// Without JavaScript the form gets a page back that does not promise the Sunday email.
const page = await watchPost({ email: "carol@example.com", repo: "torvalds/linux" }, { form: true });
const pageHtml = await page.text();
assert.equal(page.status, 200);
assert.match(page.headers.get("Content-Type"), /text\/html/);
assert.ok(pageHtml.includes("alerts launch") && pageHtml.includes("not on the Sunday email list"));
assert.ok(!pageHtml.includes("weekly safety email comes"), "not the newsletter's thank-you page");

// No storage, or storage that fails: an honest error, nothing counted as a sign-up.
const { INSTAGRAM, ...noKv } = wenv;
assert.equal((await watchPost({ email: "dan@example.com", repo: "torvalds/linux" }, { e: noKv })).status, 503);
const countBefore = statsToday().watch_signup;
const broken = { ...wenv, INSTAGRAM: { get: async () => null, put: async () => { throw new Error("KV down"); } } };
assert.equal((await watchPost({ email: "dan@example.com", repo: "torvalds/linux" }, { e: broken })).status, 502);
assert.equal(statsToday().watch_signup, countBefore);
assert.equal((await worker.fetch(new Request("https://safetoclone.com/api/watch"), wenv, ctx)).status, 405, "POST only");

// The public stats never show the alert list.
const publicStats = await (await visit("/api/stats")).text();
assert.ok(!publicStats.includes("example.com") && !publicStats.includes("torvalds"), "/api/stats only reads stats: keys");
assert.equal(resendCalls.length, 0);
globalThis.fetch = realFetch;
console.log("stats tests passed");
