// Checks the Instagram robot end to end with a fake HQ repo, a fake Instagram and a fake email service:
// it posts only approved, unchanged posts while the daily check is fresh, /ig-media/ hands out only those
// pictures (never other HQ files), and Emile gets an email when a post is skipped for a reason he should know.
// Run with: node test/hq.test.mjs
import worker from "../worker.js";
import { fingerprint, sha256 } from "../batch.js";
import { forgetHq } from "../hq.js";
import assert from "node:assert";

// A fixed clock: Tuesday Nov 10 2026, 10:05 in Ottawa (15:05 UTC).
const RealDate = Date;
let clock = RealDate.parse("2026-11-10T15:05:00Z");
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
};

const pics = { "instagram/images/2026-11-09/a/1.jpg": "JPEG-A1", "instagram/images/2026-11-09/a/2.jpg": "JPEG-A2", "instagram/images/2026-11-09/b/1.jpg": "JPEG-B1", "instagram/images/2026-11-09/c/1.jpg": "JPEG-C1" };
const hashOf = async (path) => sha256(new TextEncoder().encode(pics[path]));
const post = async (n, id, time, extra = {}) => {
  const images = Object.keys(pics).filter((p) => p.includes(`/${id}/`));
  return { n, id, channel: "instagram", date: "2026-11-10", time, images, image_hashes: await Promise.all(images.map(hashOf)), alts: images.map((_, i) => `Slide ${i + 1}`), caption: `Caption ${id}`, ...extra };
};
async function approve(batch) {
  const fp = await fingerprint(batch);
  batch.review = { verdict: "pass", hash: fp };
  batch.approval = { by: "Emile", at: "2026-11-07T14:00:00Z", how: "card", evidence: "cmsg_1", hash: fp, dropped: [] };
  return batch;
}
// This week: a (10:00, due now), b (10:00, on hold), c (18:00, later today).
const claimA = { kind: "grade", repo: "ollama/ollama", expect: "A", text: "Ollama gets an A" };
const week = await approve({ week: "2026-11-09", status: "approved", pause: { paused: false }, posts: [await post(1, "a", "10:00", { repo: "ollama/ollama", claims: [claimA] }), await post(2, "b", "10:00", { hold: true, hold_reason: "grade changed" }), await post(3, "c", "18:00")] });
// Next week: made but not approved yet.
const nextWeek = { week: "2026-11-16", status: "ready", posts: [{ n: 1, id: "draft", date: "2026-11-16", time: "10:00", images: ["instagram/images/2026-11-16/draft/1.jpg"], image_hashes: ["x"], alts: ["x"], caption: "Draft" }] };
const freshCheck = "pass\nchecked_at: 2026-11-10T13:31:00Z\nAll fine.";

let hq;
const reset = () => {
  forgetHq();
  hq = {
    "instagram/batches/2026-11-09.json": JSON.stringify(week),
    "instagram/batches/2026-11-16.json": JSON.stringify(nextWeek),
    "ops/nightly/2026-11-10.md": freshCheck,
    ...pics,
    "instagram/images/2026-11-16/draft/1.jpg": "DRAFT",
    "instagram/posts.json": "{}",
    "agents/claude/inbox/secret.md": "private",
  };
};
let githubDown = false;
let keyExpiry = null; // what GitHub says about the key's expiry date (header)
let published = [];
let emails = [];
let githubAuth = new Set();
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const reply = (x, status = 200) => new Response(JSON.stringify(x), { status });
  if (u.hostname === "api.github.com") {
    if (githubDown) return new Response("Bad Gateway", { status: 502 });
    githubAuth.add(opts.headers?.Authorization);
    const path = decodeURIComponent(u.pathname.replace("/repos/emiliomadeit/safetoclone-hq/contents/", ""));
    return path in hq ? new Response(hq[path], { headers: keyExpiry ? { "github-authentication-token-expiration": keyExpiry } : {} }) : new Response("Not Found", { status: 404 });
  }
  if (u.hostname === "api.resend.com") { emails.push(JSON.parse(opts.body)); return reply({ id: "e1" }); }
  const params = Object.fromEntries(opts.body ? new URLSearchParams(opts.body) : u.searchParams);
  if (u.pathname.endsWith("/me")) return reply({ user_id: "123" });
  if (u.pathname.endsWith("/123/media") && opts.method === "POST") { if (params.caption) published.push(params.caption); return reply({ id: "c1" }); }
  if (u.pathname.endsWith("/123/media")) return reply({ data: published.map((caption) => ({ caption })) });
  if (u.pathname.endsWith("/c1")) return reply({ status_code: "FINISHED" });
  if (u.pathname.endsWith("/media_publish")) return reply({ id: "p1" });
  return reply({ error: { message: "unexpected " + u.pathname } }, 400);
};
const kv = () => { const store = {}; return { store, async get(k, t) { const v = store[k]; return v === undefined ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { store[k] = v; }, async delete(k) { delete store[k]; } }; };
// The site's own copy of today's grades (data/directory.json), which the robot rechecks right before posting.
let directory;
const gradeA = () => { directory = { repos: [{ name: "ollama/ollama", grade: "A", label: "Strong", flags: [] }] }; };
gradeA();
const makeEnv = () => ({ HQ_GITHUB_TOKEN: "hq-key", INSTAGRAM_TOKEN: "ig", RESEND_API_KEY: "re", INSTAGRAM: kv(), ASSETS: { fetch: async (req) => new URL(req.url).pathname === "/data/directory.json" ? new Response(JSON.stringify(directory)) : new Response("Not found", { status: 404 }) } });
const get = (path, env) => worker.fetch(new Request("https://safetoclone.com" + path), env);
const tool = async (name, env) => {
  const r = await worker.fetch(new Request("https://safetoclone.com/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name } }) }), env);
  return JSON.parse((await r.json()).result.content[0].text);
};
const run = async (env) => { published = []; emails = []; await worker.scheduled({}, env, {}); };

// --- A normal day ---
reset();
let env = makeEnv();
// /mcp shows approved posts only: not the held one, not next week's draft.
let list = await tool("list_upcoming_posts", env);
assert.deepEqual(list.posts.map((p) => [p.id, p.due_now]), [["a", true], ["c", false]]);
assert.deepEqual(list.posts[0].image_urls, ["https://safetoclone.com/ig-media/instagram/images/2026-11-09/a/1.jpg", "https://safetoclone.com/ig-media/instagram/images/2026-11-09/a/2.jpg"]);
assert.equal((await tool("get_next_post", env)).id, "a");
assert.deepEqual([...githubAuth], ["Bearer hq-key"]);
// A burst of visits reads each HQ file once a minute at most.
let reads = 0;
const counted = globalThis.fetch;
globalThis.fetch = async (url, o) => { if (new URL(url).hostname === "api.github.com") reads++; return counted(url, o); };
for (let i = 0; i < 20; i++) await get("/api/instagram/status", env);
assert.equal(reads, 3); // only the 3 daily check files, the first time; the batches were already read
globalThis.fetch = counted;

// The robot posts a, and only a.
await run(env);
assert.deepEqual(published, ["Caption a"]);
assert.equal(emails.length, 0);
// 30 minutes later: a is already up, nothing new.
clock += 30 * 60e3;
await worker.scheduled({}, env, {});
assert.deepEqual(published, ["Caption a"]);

// /ig-media/ serves approved pictures...
let r = await get("/ig-media/instagram/images/2026-11-09/a/1.jpg", env);
assert.equal(r.status, 200);
assert.equal(await r.text(), "JPEG-A1");
assert.equal(r.headers.get("Content-Type"), "image/jpeg");
// ...but never held posts, unapproved weeks, other HQ files, or tricks with ../
for (const bad of ["/ig-media/instagram/images/2026-11-09/b/1.jpg", "/ig-media/instagram/images/2026-11-16/draft/1.jpg", "/ig-media/agents/claude/inbox/secret.md",
  "/ig-media/instagram/posts.json", "/ig-media/instagram/batches/2026-11-09.json", "/ig-media/instagram/images/2026-11-09/a/../../../../agents/claude/inbox/secret.md"]) {
  assert.equal((await get(bad, env)).status, 404, bad);
}
// A picture swapped in HQ after approval is refused, even though its path is approved.
hq["instagram/images/2026-11-09/a/1.jpg"] = "SWAPPED"; // pictures are never remembered
assert.equal((await get("/ig-media/instagram/images/2026-11-09/a/1.jpg", env)).status, 409);

// The status page shows what the robot sees.
let status = (await (await get("/api/instagram/status", env)).json()).posting;
assert.equal(status.dailyCheck.ok, true);
assert.deepEqual(status.weeks.map((w) => [w.week, w.status, w.canPost]), [["2026-11-09", "approved", true], ["2026-11-16", "ready", false]]);
assert.deepEqual(status.weeks[0].onHold, [{ id: "b", reason: "grade changed" }]);
assert.equal(status.weeks[1].onHold, undefined); // unapproved weeks show no details
assert.deepEqual(status.openNow, ["a"]);
assert.deepEqual(status.next, { id: "c", date: "2026-11-10", time: "18:00" });

// --- Things that must stop posts ---
clock = RealDate.parse("2026-11-10T15:05:00Z");

// A picture changed after approval: a doesn't post, and Emile gets one email.
reset();
env = makeEnv();
hq["instagram/images/2026-11-09/a/2.jpg"] = "SWAPPED";
await run(env);
assert.deepEqual(published, []);
assert.equal(emails.length, 1);
assert.match(emails[0].subject, /a did not post/);
assert.match(emails[0].text, /picture 2 changed after approval/);
assert.deepEqual(emails[0].to, ["hello@safetoclone.com"]);
assert.equal(emails[0].from, "SafeToClone robot <robot@safetoclone.com>");
await run(env); // the next run doesn't send the same email again
assert.equal(emails.length, 0);

// A caption edited after approval: nothing in that week posts, Emile gets an email.
reset();
env = makeEnv();
const edited = structuredClone(week);
forgetHq();
edited.posts[0].caption = "Edited after approval";
hq["instagram/batches/2026-11-09.json"] = JSON.stringify(edited);
await run(env);
assert.deepEqual(published, []);
assert.match(emails[0].text, /fingerprint/);
assert.equal((await tool("list_upcoming_posts", env)).posts.length, 0);

// A broken batch file: nothing posts, and the status page says so.
reset();
hq["instagram/batches/2026-11-09.json"] = "{ not json";
env = makeEnv();
await run(env);
assert.deepEqual(published, []);
status = (await (await get("/api/instagram/status", env)).json()).posting;
assert.deepEqual(status.weeks[0], { week: "2026-11-09", status: "unreadable", canPost: false, problem: "the batch file isn't valid JSON" });

// Daily check too old (over 36 hours): nothing posts, Emile gets an email.
reset();
env = makeEnv();
delete hq["ops/nightly/2026-11-10.md"];
forgetHq();
hq["ops/nightly/2026-11-08.md"] = "pass\nchecked_at: 2026-11-08T13:31:00Z";
await run(env);
assert.deepEqual(published, []);
assert.match(emails[0].text, /daily check/);
// Yesterday's check is still fresh enough (25 hours): it posts.
hq["ops/nightly/2026-11-09.md"] = "pass\nchecked_at: 2026-11-09T13:31:00Z";
forgetHq();
await run(makeEnv());
assert.deepEqual(published, ["Caption a"]);
// A failed check doesn't count.
reset();
hq["ops/nightly/2026-11-10.md"] = "fail: directory is 40 hours old\nchecked_at: 2026-11-10T13:31:00Z";
forgetHq();
await run(makeEnv());
assert.deepEqual(published, []);

// Paused, not approved, or dropped: nothing posts and no email (those are on purpose).
for (const change of [(b) => { b.pause = { paused: true, reason: "Emile said stop" }; }, (b) => { b.status = "ready"; }, (b) => { b.approval.dropped = [1]; }]) {
  reset();
  const b = structuredClone(week);
  change(b);
  hq["instagram/batches/2026-11-09.json"] = JSON.stringify(b);
  forgetHq();
  await run(makeEnv());
  assert.deepEqual([published, emails], [[], []]);
}

// The grade changed after the morning check: a doesn't post, and Emile gets an email saying why.
reset();
env = makeEnv();
directory = { repos: [{ name: "ollama/ollama", grade: "C", label: "Be careful", flags: [] }] };
await run(env);
assert.deepEqual(published, []);
assert.match(emails[0].text, /"Ollama gets an A" is no longer true \(expected A, now C\)/);
// Or the repo it names turned Dangerous.
reset();
directory = { repos: [{ name: "ollama/ollama", grade: "A", label: "Strong", flags: [] }] };
const badRepo = structuredClone(week);
badRepo.posts[0].claims = [];
hq["instagram/batches/2026-11-09.json"] = JSON.stringify(badRepo);
directory.repos[0] = { ...directory.repos[0], grade: "F", label: "Dangerous" };
forgetHq();
await run(makeEnv());
assert.deepEqual(published, []);
assert.match(emails[0].text, /now graded F \(Dangerous\)/);
gradeA();

// Missed slots never post late: at 13:30, a (10:00) is more than 3 hours old.
reset();
clock = RealDate.parse("2026-11-10T18:31:00Z");
await run(makeEnv());
assert.deepEqual(published, []);
// And at 18:00, c goes out.
clock = RealDate.parse("2026-11-10T23:00:00Z");
await run(makeEnv());
assert.deepEqual(published, ["Caption c"]);
clock = RealDate.parse("2026-11-10T15:05:00Z");

// GitHub down: nothing posts, /mcp says so, /ig-media/ answers 502. There is no other copy to fall back on.
reset();
githubDown = true;
forgetHq();
env = makeEnv();
await run(env);
assert.deepEqual(published, []);
assert.match((await tool("get_next_post", env)).error, /Couldn't read/);
assert.equal((await get("/ig-media/instagram/images/2026-11-09/a/1.jpg", env)).status, 502);
githubDown = false;

// No HQ key: nothing to post, /ig-media/ is off.
forgetHq();
const noKey = { ...makeEnv(), HQ_GITHUB_TOKEN: undefined };
assert.match((await tool("get_next_post", noKey)).message, /No approved posts/);
assert.equal((await get("/ig-media/instagram/images/2026-11-09/a/1.jpg", noKey)).status, 404);
await run(noKey);
assert.deepEqual(published, []);

// --- Alerts when HQ can't be read, and before the key expires ---
const hqMails = () => emails.filter((e) => /HQ/.test(e.subject));
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f) => realSetTimeout(f, 0); // skip GitHub's 2-second retry pause in the long outage test
const runAgain = async (env) => { forgetHq(); await run(env); };
reset();
githubDown = true;
env = makeEnv();
// A short outage (4 runs = 90 minutes): no email.
for (let i = 0; i < 4; i++) { await runAgain(env); assert.equal(hqMails().length, 0); clock += 30 * 60e3; }
assert.ok(env.INSTAGRAM.store["hq:down-since"]);
// 2 hours in a row: exactly one email, in plain words, with the status link. More failures the same day: no second one.
await runAgain(env);
assert.equal(hqMails().length, 1);
assert.match(hqMails()[0].text, /expired|GitHub is down/);
assert.match(hqMails()[0].text, /safetoclone\.com\/api\/instagram\/status/);
const sentEarlier = hqMails()[0];
clock += 30 * 60e3;
await runAgain(env);
assert.equal(hqMails().length, 0); // run() clears the list; the day's alert is already in KV
assert.ok(env.INSTAGRAM.store[`alert:hq-down:2026-11-10`]);
// GitHub is back: the failure clock is cleared, so a new outage starts counting from zero.
githubDown = false;
await runAgain(env);
assert.equal(env.INSTAGRAM.store["hq:down-since"], undefined);
githubDown = true;
await runAgain(env);
assert.equal(env.INSTAGRAM.store["hq:down-since"], new Date(clock).toISOString());
assert.equal(sentEarlier.to[0], "hello@safetoclone.com");
githubDown = false;

// Key expiry: fewer than 14 days left = one warning a day; more than that, or no header = nothing.
reset();
env = makeEnv();
keyExpiry = "2026-11-20 00:00:00 UTC"; // 9 days from the fake clock
await runAgain(env);
assert.equal(emails.filter((e) => /key expires/.test(e.subject)).length, 1);
assert.match(emails.find((e) => /key expires/.test(e.subject)).text, /2026-11-20/);
await runAgain(env);
assert.equal(emails.filter((e) => /key expires/.test(e.subject)).length, 0); // same day: already told
assert.match((await (await get("/api/instagram/status", env)).json()).hqKeyExpires, /2026-11-20 00:00:00 UTC \(9 days left\)/);
reset(); env = makeEnv(); keyExpiry = "2027-03-01 00:00:00 UTC";
await runAgain(env);
assert.equal(emails.length, 0);
reset(); env = makeEnv(); keyExpiry = null; // no header = the key doesn't expire
await runAgain(env);
assert.equal(emails.length, 0);
assert.match((await (await get("/api/instagram/status", env)).json()).hqKeyExpires, /doesn't expire/);

globalThis.setTimeout = realSetTimeout;
console.log("HQ tests passed");
