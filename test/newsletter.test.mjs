// Checks the newsletter robot (newsletter.js + worker.js) with a fake HQ and a fake Resend: a ready issue gets
// one test copy to Emile, an approved one is sent exactly once in its window, and nothing goes out if it
// changed after approval or a grade it names changed. Run with: node test/newsletter.test.mjs
import worker from "../worker.js";
import { fingerprint, checkIssue, sendWindowOpen, issueClaimsProblem, renderHtml, renderText } from "../newsletter.js";
import { forgetHq } from "../hq.js";
import assert from "node:assert";

// 1. Same fingerprint as HQ's newsletter/_tools/issue.py (made with the Python code on 2026-10-25).
const PY = { date: "2026-11-01", time: "09:30", subject: "Café “quotes” \\ é 🙂", preview: "Line\ttab \"q\"", body: "**Bold**\n\n- a\n- b \u0007" };
assert.equal(await fingerprint(PY), "22ad133a21996a7c1a3531f656e0b0f1d4de3d69a4b1ff5dcecb64d258262715");
assert.notEqual(await fingerprint({ ...PY, body: PY.body + "!" }), await fingerprint(PY));
assert.notEqual(await fingerprint({ ...PY, time: "10:00" }), await fingerprint(PY));

// 2. Drawing: the approved words, bold, lists, links, escaping, the hidden preview line and the unsubscribe link.
const body = "Hi <there> & welcome.\n\n**This week**\n\n- **Ollama** (A, 97/100). Runs AI.\n- Two\n\nGo to https://safetoclone.com/?ref=newsletter now.\n\n*It can be wrong.*";
const issue0 = { date: "2026-10-25", time: "13:00", subject: "We graded 79 tools", preview: "Most passed.", body, claims: [{ kind: "grade", repo: "ollama/ollama", expect: "A", text: "Ollama gets an A" }, { kind: "score", repo: "ollama/ollama", expect: 97, text: "Ollama scores 97" }] };
const html = renderHtml(issue0);
assert.match(html, /Hi &lt;there&gt; &amp; welcome\./);
assert.match(html, /<strong>This week<\/strong>/);
assert.match(html, /<li[^>]*><strong>Ollama<\/strong> \(A, 97\/100\)\. Runs AI\.<\/li>/);
assert.match(html, /<a href="https:\/\/safetoclone\.com\/\?ref=newsletter"[^>]*>safetoclone\.com<\/a> now\./);
assert.match(html, /<em>It can be wrong\.<\/em>/);
assert.match(html, /display:none[^>]*>Most passed\.</);
assert.match(html, /href="\{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}"/);
const text = renderText(issue0);
assert.match(text, /^Hi <there>/);
assert.ok(!text.includes("**"));
assert.match(text, /Unsubscribe: \{\{\{RESEND_UNSUBSCRIBE_URL\}\}\}/);

// 3. The checks.
const approve = async (i) => ({ ...i, status: "approved", approval: { by: "Emile", at: "2026-10-25T16:30:00Z", evidence: "cmsg_1", hash: await fingerprint(i) } });
assert.equal((await checkIssue(await approve(issue0))).ok, true);
assert.match((await checkIssue({ ...issue0, status: "ready" })).reason, /not approved/);
assert.match((await checkIssue({ ...(await approve(issue0)), approval: { by: "Claude", at: "x", evidence: "y", hash: "z" } })).reason, /Emile/);
const edited = { ...(await approve(issue0)), body: body + " Extra." };
assert.deepEqual([(await checkIssue(edited)).ok, (await checkIssue(edited)).changed], [false, true]);
assert.equal(sendWindowOpen(issue0, new Date("2026-10-25T17:05:00Z")), true); // 13:05 Ottawa
assert.equal(sendWindowOpen(issue0, new Date("2026-10-25T16:55:00Z")), false); // 12:55, too early
assert.equal(sendWindowOpen(issue0, new Date("2026-10-25T20:05:00Z")), false); // 16:05, over 3 hours late
assert.equal(sendWindowOpen({ ...issue0, time: undefined }, new Date("2026-10-25T13:10:00Z")), true); // default 09:00
assert.equal(sendWindowOpen(issue0, new Date("2026-10-26T17:05:00Z")), false); // wrong day
const dirA = { repos: [{ name: "ollama/ollama", grade: "A", score: 97, label: "Strong", flags: [] }] };
assert.equal(issueClaimsProblem(issue0, dirA), "");
assert.match(issueClaimsProblem(issue0, { repos: [{ ...dirA.repos[0], score: 95 }] }), /Ollama scores 97/);
assert.match(issueClaimsProblem(issue0, { repos: [{ ...dirA.repos[0], grade: "B" }] }), /Ollama gets an A/);
assert.match(issueClaimsProblem(issue0, null), /grades/);

// 4. The robot, end to end.
const RealDate = Date;
let clock;
globalThis.Date = class extends RealDate {
  constructor(...args) { super(...(args.length ? args : [clock])); }
  static now() { return clock; }
};
let hq, calls, segmentsList, failSend, busy = 0, contactExists = false;
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(url);
  const reply = (x, status = 200) => new Response(JSON.stringify(x), { status });
  if (u.hostname === "api.github.com") {
    const path = decodeURIComponent(u.pathname.replace("/repos/emiliomadeit/safetoclone-hq/contents/", ""));
    return path in hq ? new Response(hq[path]) : new Response("Not Found", { status: 404 });
  }
  if (u.hostname === "api.resend.com") {
    calls.push({ path: u.pathname, body: opts.body ? JSON.parse(opts.body) : null });
    if (u.pathname === "/segments") return reply({ data: segmentsList });
    if (u.pathname === "/broadcasts") return reply({ id: "b1" });
    if (u.pathname === "/contacts" && contactExists) return reply({ message: "Contact already exists" }, 409);
    if (u.pathname.endsWith("/send") && busy > 0) { busy--; return reply({ message: "Too many requests" }, 429); }
    if (u.pathname.endsWith("/send")) return failSend ? reply({ message: "oops" }, 500) : reply({ id: "b1" });
    return reply({ id: "e1" });
  }
  // Instagram: nothing to post in these tests.
  return reply({ data: [] });
};
const kv = () => { const store = {}; return { store, async get(k, t) { const v = store[k]; return v === undefined ? null : t === "json" ? JSON.parse(v) : v; }, async put(k, v) { store[k] = v; }, async delete(k) { delete store[k]; } }; };
const env = (extra = {}) => ({ HQ_GITHUB_TOKEN: "hq", RESEND_API_KEY: "re", INSTAGRAM: kv(), ASSETS: { fetch: async () => new Response(JSON.stringify(dirA)) }, ...extra });
const run = (e, at) => { clock = RealDate.parse(at); forgetHq(); return worker.scheduled({}, e, {}); };
const sends = () => calls.filter((c) => c.path === "/broadcasts");
const mails = () => calls.filter((c) => c.path === "/emails").map((c) => c.body);
const put = (i) => { hq = { "newsletter/issues/2026-10-25.json": JSON.stringify(i) }; };
const reset = () => { calls = []; segmentsList = [{ id: "seg1", name: "General" }]; failSend = false; };

// A ready issue: one test copy to Emile, with a banner and no real unsubscribe link, and no broadcast.
reset();
put({ ...issue0, status: "ready" });
let e = env();
await run(e, "2026-10-25T16:00:00Z");
await run(e, "2026-10-25T16:30:00Z");
assert.equal(mails().length, 1);
assert.equal(mails()[0].to[0], "hello@safetoclone.com");
assert.match(mails()[0].subject, /^\[Test\] We graded 79 tools$/);
assert.match(mails()[0].html, /Test copy for Emile, version [0-9a-f]{8}/);
assert.ok(!mails()[0].html.includes("RESEND_UNSUBSCRIBE_URL"));
assert.equal(sends().length, 0);
// A new version gets a new test copy.
put({ ...issue0, status: "ready", subject: "New subject" });
await run(e, "2026-10-25T17:00:00Z");
assert.equal(mails().length, 2);

// Approved: nothing before its time, then sent once to the only segment, then never again.
reset();
put(await approve(issue0));
e = env();
await run(e, "2026-10-25T16:30:00Z"); // 12:30 Ottawa
assert.equal(sends().length, 0);
await run(e, "2026-10-25T17:00:00Z"); // 13:00
assert.equal(sends().length, 1);
const b = sends()[0].body;
assert.equal(b.segment_id, "seg1");
assert.equal(b.from, "Emile from SafeToClone <hello@safetoclone.com>");
assert.equal(b.subject, "We graded 79 tools");
assert.match(b.html, /RESEND_UNSUBSCRIBE_URL/);
assert.equal(calls.filter((c) => c.path === "/broadcasts/b1/send").length, 1);
assert.equal(JSON.parse(e.INSTAGRAM.store["newsletter:sent:2026-10-25"]).state, "sent");
assert.ok(mails().some((m) => /^Newsletter sent/.test(m.subject))); // Emile hears it went out
await run(e, "2026-10-25T17:30:00Z");
await run(e, "2026-10-25T18:00:00Z");
assert.equal(sends().length, 1);
// The status page shows it.
let st = await (await worker.fetch(new Request("https://safetoclone.com/api/newsletter/status?date=2026-10-25"), e)).json();
assert.equal(st.issue.canSend, true);
assert.equal(st.sent.state, "sent");
assert.equal(st.sendsTo, "General");

// RESEND_SEGMENT_ID wins; several segments without it means no send and an email to Emile.
reset();
e = env({ RESEND_SEGMENT_ID: "segX" });
segmentsList = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
await run(e, "2026-10-25T17:00:00Z");
assert.equal(sends()[0].body.segment_id, "segX");
reset();
segmentsList = [{ id: "a", name: "A" }, { id: "b", name: "B" }];
e = env();
await run(e, "2026-10-25T17:00:00Z");
assert.equal(sends().length, 0);
assert.ok(mails().some((m) => /no list/.test(m.subject)));

// Edited after approval: not sent, Emile is told.
reset();
put({ ...(await approve(issue0)), body: body + " Extra." });
e = env();
await run(e, "2026-10-25T17:00:00Z");
assert.equal(sends().length, 0);
assert.ok(mails().some((m) => /changed after approval/.test(m.subject)));

// A grade changed since: not sent.
reset();
put(await approve(issue0));
e = env({ ASSETS: { fetch: async () => new Response(JSON.stringify({ repos: [{ ...dirA.repos[0], grade: "B" }] })) } });
await run(e, "2026-10-25T17:00:00Z");
assert.equal(sends().length, 0);
assert.ok(mails().some((m) => /grade changed/.test(m.subject)));

// Resend fails on "send": it never tries again (no double copies) and asks Emile to look.
reset();
put(await approve(issue0));
failSend = true;
e = env();
await run(e, "2026-10-25T17:00:00Z");
await run(e, "2026-10-25T17:30:00Z");
assert.equal(sends().length, 1);
assert.equal(JSON.parse(e.INSTAGRAM.store["newsletter:sent:2026-10-25"]).state, "unsure");
assert.match(JSON.parse(e.INSTAGRAM.store["newsletter:sent:2026-10-25"]).resendSaid, /^500 .*oops/);
assert.ok(mails().some((m) => /check Resend/.test(m.subject) && /500/.test(m.text)));
assert.equal(calls.filter((c) => c.path === "/broadcasts/b1/send").length, 1); // a real refusal is never retried

// Resend says "too many requests" once: it waits and asks again, and the issue goes out once.
reset();
put(await approve(issue0));
busy = 1;
e = env();
await run(e, "2026-10-25T17:00:00Z");
assert.equal(calls.filter((c) => c.path === "/broadcasts/b1/send").length, 2);
assert.equal(JSON.parse(e.INSTAGRAM.store["newsletter:sent:2026-10-25"]).state, "sent");
assert.equal(sends().length, 1);

// No issue file today: nothing at all.
reset();
hq = {};
await run(env(), "2026-10-25T17:00:00Z");
assert.equal(calls.length, 0);

// 5. Signups join the segment the newsletter goes to, even without RESEND_SEGMENT_ID.
const signup = (e) => worker.fetch(new Request("https://safetoclone.com/api/subscribe", { method: "POST", body: JSON.stringify({ email: "New@Example.com" }) }), e);
reset();
let res = await signup(env());
assert.equal(res.status, 200);
let c = calls.find((x) => x.path === "/contacts").body;
assert.equal(c.email, "new@example.com");
assert.deepEqual(c.segments, [{ id: "seg1" }]);
// Already a contact: it still gets added to the segment.
reset();
contactExists = true;
res = await signup(env());
assert.equal(res.status, 200);
assert.ok(calls.some((x) => x.path === "/contacts/new%40example.com/segments/seg1"));
contactExists = false;
// RESEND_SEGMENT_ID wins.
reset();
await signup(env({ RESEND_SEGMENT_ID: "segX" }));
assert.deepEqual(calls.find((x) => x.path === "/contacts").body.segments, [{ id: "segX" }]);
// Resend can't list segments: the signup is still saved.
reset();
segmentsList = [];
res = await signup(env());
assert.equal(res.status, 200);
assert.equal(calls.find((x) => x.path === "/contacts").body.segments, undefined);

globalThis.Date = RealDate;
console.log("newsletter tests passed");
