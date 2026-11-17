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

// ---- /api/watch: "tell me when alerts launch" is its own list, never the newsletter, and only after the person confirms ----
const resendCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (u, init = {}, ...rest) => {
  if (!String(u).includes("resend.com")) return realFetch(u, init, ...rest);
  resendCalls.push({ url: String(u), body: init.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ id: "e1" }), { status: 200 });
};
const wenv = { ...env, RESEND_API_KEY: "re_test" };
const send = async (path, init, e = wenv) => { const res = await worker.fetch(new Request("https://safetoclone.com" + path, init), e, ctx); await Promise.all(jobs.splice(0)); return res; };
const watchPost = (body, { form = false, e = wenv } = {}) => send("/api/watch", form
  ? { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "Mozilla/5.0" }, body: new URLSearchParams(body).toString() }
  : { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" }, body: JSON.stringify(body) }, e);
const today = new Date().toISOString().slice(0, 10);
const statsToday = () => JSON.parse(store.get(`stats:${today}`)).events;
const confirmed = () => JSON.parse(store.get(`watch:${today}`) || "[]");
const pending = () => JSON.parse(store.get(`watchpend:${today}`) || "[]");
const signupsBefore = statsToday().signup || 0;
const linkIn = (call) => call.body.text.match(/https:\/\/safetoclone\.com\/watch\/confirm\?t=([0-9a-f.-]+)/)[1];

let w = await watchPost({ email: " Ann@Example.com ", repo: "git clone https://github.com/torvalds/linux" });
assert.equal(w.status, 200);
assert.deepEqual(await w.json(), { ok: true, sent: true });
assert.equal(confirmed().length, 0, "nothing is on the list until the person confirms");
assert.equal(pending().length, 1);
assert.equal(pending()[0].email, "ann@example.com", "trimmed and lower-cased");
assert.deepEqual(pending()[0].repos, ["torvalds/linux"], "the repo goes through the same link reading as the checker");
assert.equal(resendCalls.length, 1);
assert.ok(resendCalls.every((c) => c.url === "https://api.resend.com/emails"), "only the confirmation email: never /contacts, /segments or /broadcasts");
const mail = resendCalls[0].body;
assert.deepEqual(mail.to, ["ann@example.com"]);
assert.equal(mail.subject, "Please confirm your email address", "no repo name in the subject: a stranger chose it");
assert.ok(!/torvalds|linux/i.test(mail.text + mail.html + mail.subject), "nothing a stranger typed is in the email");
assert.match(mail.text, /If this wasn't you, ignore this email/);
const token = linkIn(resendCalls[0]);
assert.ok(!JSON.stringify(pending()).includes(token), "only a hash of the token is stored");
assert.equal(statsToday().watch_request, 1);
assert.equal(statsToday().watch_signup || 0, 0, "not a sign-up until confirmed");
assert.equal(statsToday().signup || 0, signupsBefore, "never counted as a newsletter subscriber");

// Opening the link (a GET, which mail scanners do) shows a button and changes nothing.
let g = await send(`/watch/confirm?t=${token}`, { method: "GET", headers: { "User-Agent": "Mozilla/5.0" } });
let gHtml = await g.text();
assert.equal(g.status, 200);
assert.ok(gHtml.includes('method="post"') && gHtml.includes("Yes, tell me when alerts launch"));
assert.equal(confirmed().length, 0, "a GET never confirms");
assert.equal(statsToday().watch_signup || 0, 0);

// The button (POST) confirms. Doing it twice is harmless.
let c = await send(`/watch/confirm?t=${token}`, { method: "POST", headers: { "User-Agent": "Mozilla/5.0" } });
assert.ok((await c.text()).includes("You&#39;re confirmed"), "the page says so (the apostrophe is escaped)");
assert.equal(confirmed().length, 1);
assert.deepEqual(confirmed()[0], { email: "ann@example.com", repo: "torvalds/linux", at: confirmed()[0].at, confirmed: true });
assert.equal(statsToday().watch_signup, 1);
await send(`/watch/confirm?t=${token}`, { method: "POST", headers: { "User-Agent": "Mozilla/5.0" } });
assert.equal(confirmed().length, 1, "confirming twice adds nothing");
assert.equal(statsToday().watch_signup, 1, "and counts once");
assert.equal(statsToday().signup || 0, signupsBefore);

// One confirmation email per address a day, however many repos; a new repo joins the same request.
w = await watchPost({ email: "ann@example.com", repo: "git/git" });
assert.deepEqual(await w.json(), { ok: true, sent: false });
assert.equal(resendCalls.length, 1, "no second email to the same address");
assert.deepEqual(pending()[0].repos, ["torvalds/linux", "git/git"]);
const token2 = (await watchPost({ email: "bea@example.com", repo: "git/git" }), linkIn(resendCalls[1]));
assert.equal(resendCalls.length, 2);
assert.notEqual(token2, token);
await send(`/watch/confirm?t=${token2}`, { method: "POST", headers: { "User-Agent": "Mozilla/5.0" } });
assert.equal(confirmed().filter((x) => x.email === "bea@example.com").length, 1);

// Bad links and bad input.
for (const bad of ["", "abc", `${today}.${"0".repeat(48)}`, `1999-01-01.${"a".repeat(48)}`]) {
  const r = await send(`/watch/confirm?t=${bad}`, { method: "POST", headers: { "User-Agent": "Mozilla/5.0" } });
  assert.ok(!(await r.text()).includes("You&#39;re confirmed"), `bad link "${bad}" confirms nothing`);
}
const sendsBefore = resendCalls.length;
assert.equal((await watchPost({ email: "not-an-email", repo: "torvalds/linux" })).status, 400);
assert.equal((await watchPost({ email: "a".repeat(250) + "@example.com", repo: "torvalds/linux" })).status, 400, "too long");
assert.equal((await watchPost({ email: "bob@example.com", repo: "https://example.com/a/b" })).status, 400, "only GitHub repos");
assert.equal((await watchPost({ email: "bob@example.com" })).status, 400);
assert.equal(resendCalls.length, sendsBefore, "refused sign-ups send nothing");

// Ceilings: per address, and a low daily limit on emails (Resend's allowance is shared with the newsletter).
store.set(`watchpend:${today}`, JSON.stringify([{ email: "many@example.com", repos: Array.from({ length: 20 }, (_, i) => `o/r${i}`), th: "x", at: "x" }]));
assert.equal((await watchPost({ email: "many@example.com", repo: "o/another" })).status, 429);
store.set(`watchpend:${today}`, JSON.stringify(Array.from({ length: 20 }, (_, i) => ({ email: `u${i}@example.com`, repos: ["o/r"], th: "x", at: "x" }))));
const full = store.get(`watchpend:${today}`);
const beforeCap = resendCalls.length;
assert.equal((await watchPost({ email: "late@example.com", repo: "o/r" })).status, 503);
assert.equal(store.get(`watchpend:${today}`), full, "past the ceiling nothing more is written");
assert.equal(resendCalls.length, beforeCap, "and no email goes out");
store.delete(`watchpend:${today}`);

// Without JavaScript the form gets a page back that says to check the inbox, and is not the newsletter's thank-you page.
const page = await watchPost({ email: "carol@example.com", repo: "torvalds/linux" }, { form: true });
const pageHtml = await page.text();
assert.equal(page.status, 200);
assert.match(page.headers.get("Content-Type"), /text\/html/);
assert.ok(pageHtml.includes("Check your inbox") && pageHtml.includes("Nothing is saved until you do"));
assert.ok(!pageHtml.includes("weekly safety email comes"), "not the newsletter's thank-you page");
assert.equal(confirmed().filter((x) => x.email === "carol@example.com").length, 0);

// No storage, no Resend key, a failing store or a failing email: an honest error, nothing counted as asked.
const { INSTAGRAM, ...noKv } = wenv;
assert.equal((await watchPost({ email: "dan@example.com", repo: "torvalds/linux" }, { e: noKv })).status, 503);
const { RESEND_API_KEY, ...noMail } = wenv;
assert.equal((await watchPost({ email: "dan@example.com", repo: "torvalds/linux" }, { e: noMail })).status, 503, "no email key, no sign-up");
const asked = statsToday().watch_request;
const broken = { ...wenv, INSTAGRAM: { get: async () => null, put: async () => { throw new Error("KV down"); } } };
assert.equal((await watchPost({ email: "dan@example.com", repo: "torvalds/linux" }, { e: broken })).status, 502);
assert.equal(statsToday().watch_request, asked);
const realFetch2 = globalThis.fetch;
globalThis.fetch = async (u, ...rest) => (String(u).includes("resend.com") ? new Response("{}", { status: 500 }) : realFetch2(u, ...rest));
assert.equal((await watchPost({ email: "erin@example.com", repo: "torvalds/linux" })).status, 502, "a failed email is an error, not a success");
assert.equal(statsToday().watch_request, asked);
globalThis.fetch = realFetch2;
assert.equal((await send("/api/watch", { method: "GET" })).status, 405, "POST only");

// The public stats never show the list.
const publicStats = await (await visit("/api/stats")).text();
assert.ok(!publicStats.includes("example.com") && !publicStats.includes("torvalds"), "/api/stats only reads stats: keys");
assert.ok(resendCalls.every((c) => c.url === "https://api.resend.com/emails"), "the Sunday list is never touched");
globalThis.fetch = realFetch;

console.log("stats tests passed");
