// Checks the newsletter robot (newsletter.js + worker.js) with a fake HQ and a fake Resend: a ready issue gets
// one test copy to Emile, an approved one is sent exactly once in its window, and nothing goes out if it
// changed after approval or a grade it names changed. Run with: node test/newsletter.test.mjs
import worker, { forgetPictures } from "../worker.js";
import { fingerprint, checkIssue, sendWindowOpen, issueClaimsProblem, renderHtml, renderText, pictures } from "../newsletter.js";
import { sha256 } from "../batch.js";
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
// "## " headings (also at the top of a paragraph), emoji, and the one-tap rating at the bottom.
const h = renderHtml({ ...issue0, body: "## This week 🔥\n\nText.\n\n## Tip\nDo **this**.\n\n## <b>x</b>" });
assert.match(h, /<h2[^>]*>This week 🔥<\/h2>/);
assert.match(h, /<h2[^>]*>Tip<\/h2><p[^>]*>Do <strong>this<\/strong>\.<\/p>/);
assert.match(h, /<h2[^>]*>&lt;b&gt;x&lt;\/b&gt;<\/h2>/);
assert.match(h, /How was this week's\?/);
for (const v of ["love", "good", "soso"]) assert.ok(h.includes(`href="https://safetoclone.com/newsletter/rate/${v}"`));
assert.match(h, /😍 Love it<\/a>.*🙂 Good<\/a>.*😐 So so<\/a>/);
assert.ok(renderHtml(issue0, { test: true }).includes("/newsletter/rate/love?test=1")); // Emile's own taps don't count
assert.match(renderText({ ...issue0, body: "## Tip\nDo it." }), /^Tip\nDo it\.[\s\S]*😍 Love it: https:\/\/safetoclone\.com\/newsletter\/rate\/love\n/);

// 3. The checks.
const approve = async (i) => ({ ...i, status: "approved", approval: { by: "Emile", at: "2026-10-25T16:30:00Z", evidence: "cmsg_1", hash: await fingerprint(i) } });

// Pictures: a line on its own, drawn full width with its alt text; the text version says [Picture: ...].
// fingerprint() is unchanged (the Python result in 1 still matches): the sha256 inside the body locks the picture.
const GIF = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 0, 0, 0, 59]);
const gifHash = await sha256(GIF);
const picLine = (path = "newsletter/images/2026-10-25/demo.gif", hash = gifHash, alt = "A dial <spinning>") => `![${alt}](${path}#sha256=${hash})`;
const withPic = { ...issue0, body: `Look:\n${picLine()}\nNice.` };
const ph = renderHtml(withPic);
assert.ok(ph.includes(`<img src="https://safetoclone.com/nl-media/newsletter/images/2026-10-25/demo.gif?v=${gifHash}" alt="A dial &lt;spinning&gt;"`));
assert.match(ph, /<p[^>]*>Look:<\/p><img [^>]*max-width:100%;height:auto;[^>]*border-radius:8px[^>]*><p[^>]*>Nice\.<\/p>/);
assert.match(renderText(withPic), /^Look:\n\n\[Picture: A dial <spinning>\]\n\nNice\./);
assert.deepEqual(pictures(withPic).list.map((x) => [x.path, x.hash, x.type]), [["newsletter/images/2026-10-25/demo.gif", gifHash, "image/gif"]]);
assert.equal((await checkIssue(await approve(withPic))).ok, true);
// Refused: a broken hash, outside newsletter/images/, "..", another date's folder, no alt text, other file types, outside links.
for (const bad of [picLine(undefined, "abc"), picLine(undefined, gifHash.toUpperCase()), picLine("instagram/images/2026-10-25/demo.gif"),
  picLine("newsletter/images/2026-10-25/../../../agents/x.png"), picLine("newsletter/images/2026-10-25/a..png"), picLine("newsletter/images/2026-10-18/demo.gif"),
  picLine(undefined, undefined, ""), picLine("newsletter/images/2026-10-25/demo.svg"), picLine("https://evil.example/x.gif")]) {
  const i = { ...issue0, body: `Hi.\n\n${bad}` };
  assert.ok(pictures(i).problem, bad);
  const c = await checkIssue(await approve(i));
  assert.equal(c.ok, false);
  assert.match(c.reason, /picture/);
}
const seven = { ...issue0, body: Array.from({ length: 7 }, (_, n) => picLine(`newsletter/images/2026-10-25/p${n}.gif`)).join("\n\n") };
assert.match(pictures(seven).problem, /at most 6/);
assert.equal(pictures({ ...seven, body: seven.body.split("\n\n").slice(1).join("\n\n") }).problem, "");
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
let hq, calls, segmentsList, failSend, busy = 0, contactExists = false, listEmpty = false;
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
    if (u.pathname === "/contacts" && !opts.body) return reply({ data: listEmpty ? [] : [{ id: "c1" }] });
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
assert.match(mails()[0].html, />Review and approve<\/a>/);
assert.ok(mails()[0].html.includes("/newsletter/rate/love?test=1"));
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
assert.equal(st.issue.approvedBy, "HQ file");
assert.equal(st.sent.state, "sent");
assert.equal(st.sent.approvedBy, "HQ file");
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

// The list is empty: no broadcast, one email to Emile, and it sends once someone is on the list.
reset();
put(await approve(issue0));
listEmpty = true;
e = env();
await run(e, "2026-10-25T17:00:00Z");
await run(e, "2026-10-25T17:30:00Z");
assert.equal(sends().length, 0);
assert.equal(mails().filter((m) => /list is empty/.test(m.subject)).length, 1);
assert.ok(calls.some((c) => c.path === "/contacts" && !c.body));
listEmpty = false;
await run(e, "2026-10-25T18:00:00Z");
assert.equal(sends().length, 1);
assert.equal(JSON.parse(e.INSTAGRAM.store["newsletter:sent:2026-10-25"]).state, "sent");

// The approve button. Opening the link shows the email but approves nothing; only the POST does.
const visit = async (e, url, method = "GET", at = "2026-10-25T16:00:00Z") => {
  clock = RealDate.parse(at); forgetHq();
  const r = await worker.fetch(new Request(url, { method }), e, { waitUntil() {} });
  return { status: r.status, text: await r.text(), cache: r.headers.get("Cache-Control") };
};
const link = (m) => m.text.match(/Review and approve: (\S+)/)[1];
reset();
const ready = { ...issue0, status: "ready" };
put(ready);
e = env();
await run(e, "2026-10-25T16:00:00Z");
let url = link(mails()[0]);
assert.match(url, /^https:\/\/safetoclone\.com\/newsletter\/approve\?d=2026-10-25&v=[0-9a-f]{8}&t=[0-9a-f]{64}$/);
let pg = await visit(e, url);
assert.equal(pg.status, 200);
assert.equal(pg.cache, "no-store");
assert.match(pg.text, /We graded 79 tools/);
assert.match(pg.text, /Most passed\./);
assert.match(pg.text, /<iframe[^>]*sandbox srcdoc="[^"]*Hi &amp;lt;there&amp;gt;/); // the full email, escaped twice inside srcdoc
assert.match(pg.text, /<form method="post"[^>]*>\s*<button class="btn" type="submit">Approve this version<\/button>/);
assert.match(pg.text, /noindex/);
assert.equal(e.INSTAGRAM.store["newsletter:approval:2026-10-25"], undefined);
await run(e, "2026-10-25T17:00:00Z");
assert.equal(sends().length, 0); // seen is not approved
// Wrong, malformed, mismatched and expired links are refused and approve nothing.
const t = url.match(/t=(\w+)/)[1];
for (const bad of [url.replace(t, "0".repeat(64)), url.replace(t, "nope"), url.replace(/&t=\w+/, ""), url.replace(/v=\w+/, "v=00000000"), url.replace("d=2026-10-25", "d=2026-10-26")]) {
  pg = await visit(e, bad, "POST");
  assert.equal(pg.status, 404);
  assert.match(pg.text, /This link doesn&#39;t work/);
}
const tok = JSON.parse(e.INSTAGRAM.store[`newsletter:token:${t}`]);
e.INSTAGRAM.store[`newsletter:token:${t}`] = JSON.stringify({ ...tok, at: "2026-10-17T16:00:00Z" }); // 8 days old
assert.equal((await visit(e, url, "POST")).status, 404);
e.INSTAGRAM.store[`newsletter:token:${t}`] = JSON.stringify(tok);
assert.equal(e.INSTAGRAM.store["newsletter:approval:2026-10-25"], undefined);
// HQ put it on hold: the button can't approve it.
put({ ...ready, status: "held" });
assert.equal((await visit(e, url, "POST")).status, 409);
put(ready);
// The right link, POSTed: approved, and it goes out once at its time.
pg = await visit(e, url, "POST");
assert.equal(pg.status, 200);
assert.match(pg.text, /Approved\. It will go out Sunday, October 25 at 13:00 Ottawa\./);
assert.equal(JSON.parse(e.INSTAGRAM.store["newsletter:approval:2026-10-25"]).source, "approve button");
assert.match((await visit(e, url)).text, /Approved\. It will go out/); // opening it again just says so
await run(e, "2026-10-25T16:30:00Z");
assert.equal(sends().length, 0); // not before its time
await run(e, "2026-10-25T17:00:00Z");
await run(e, "2026-10-25T17:30:00Z");
assert.equal(sends().length, 1);
assert.equal(JSON.parse(e.INSTAGRAM.store["newsletter:sent:2026-10-25"]).approvedBy, "approve button");
st = await (await worker.fetch(new Request("https://safetoclone.com/api/newsletter/status?date=2026-10-25"), e)).json();
assert.equal(st.issue.approvedBy, "approve button");
assert.equal(st.issue.buttonApproval.current, true);
// Approved after the window: it says it won't go out.
assert.match((await visit(env({ INSTAGRAM: e.INSTAGRAM }), url, "POST", "2026-10-25T21:00:00Z")).text, /has passed, so it won&#39;t go out/);

// Edited after the button approval: not sent, the old link no longer counts, and a new test copy with a new button goes out.
reset();
e = env();
put(ready);
await run(e, "2026-10-25T16:00:00Z");
url = link(mails()[0]);
assert.equal((await visit(e, url, "POST")).status, 200);
put({ ...ready, body: body + " Extra." });
await run(e, "2026-10-25T17:00:00Z");
await run(e, "2026-10-25T17:30:00Z");
assert.equal(sends().length, 0);
const fresh = mails().filter((m) => /^\[Test\]/.test(m.subject));
assert.equal(fresh.length, 2);
assert.notEqual(link(fresh[1]), url);
pg = await visit(e, url, "POST");
assert.equal(pg.status, 410);
assert.match(pg.text, /This version changed/);
assert.equal(sends().length, 0);
st = await (await worker.fetch(new Request("https://safetoclone.com/api/newsletter/status?date=2026-10-25"), e)).json();
assert.equal(st.issue.canSend, false);
assert.equal(st.issue.buttonApproval.current, false);
// Approving the new version sends it, once.
assert.equal((await visit(e, link(fresh[1]), "POST", "2026-10-25T17:40:00Z")).status, 200);
await run(e, "2026-10-25T18:00:00Z");
await run(e, "2026-10-25T18:30:00Z");
assert.equal(sends().length, 1);
assert.match(sends()[0].body.html, /Extra\./);

// Pictures, end to end. /nl-media/ serves only a picture that a ready or approved issue names, with its exact
// fingerprint, and only while HQ's bytes match it. A wrong or missing picture stops the test copy and the send.
const PIC = "newsletter/images/2026-10-25/demo.gif";
const picUrl = `/nl-media/${PIC}?v=${gifHash}`;
const putPic = (i, file = GIF) => { put(i); Object.assign(hq, { [PIC]: file, "newsletter/images/2026-10-25/other.gif": GIF, "agents/claude/inbox/secret.md": "secret" }); };
const media = async (e, path, method = "GET") => { clock = RealDate.parse("2026-10-25T16:00:00Z"); forgetHq(); forgetPictures(); return worker.fetch(new Request(`https://safetoclone.com${path}`, { method }), e, { waitUntil() {} }); };
const picReady = { ...ready, body: `${body}\n\n${picLine()}` };
reset();
putPic(picReady);
e = env();
let mr = await media(e, picUrl);
assert.equal(mr.status, 200);
assert.equal(mr.headers.get("Content-Type"), "image/gif");
assert.match(mr.headers.get("Cache-Control"), /max-age=31536000, immutable/);
assert.deepEqual(new Uint8Array(await mr.arrayBuffer()), GIF);
assert.equal((await media(e, picUrl, "HEAD")).status, 200);
for (const bad of [`/nl-media/${PIC}`, `/nl-media/${PIC}?v=${"0".repeat(64)}`, `/nl-media/newsletter/images/2026-10-25/other.gif?v=${gifHash}`,
  `/nl-media/agents/claude/inbox/secret.md?v=${gifHash}`, `/nl-media/newsletter/issues/2026-10-25.json`, `/nl-media/newsletter/images/2026-10-25/..%2f..%2f..%2fagents%2fclaude%2finbox%2fsecret.md?v=${gifHash}`,
  `/nl-media/newsletter/images/2026-10-26/demo.gif?v=${gifHash}`, "/nl-media/%E0%A4%A"]) {
  assert.equal((await media(e, bad)).status, 404, bad);
}
assert.equal((await media(env({ HQ_GITHUB_TOKEN: undefined }), picUrl)).status, 404);
for (const status of ["held", "draft", undefined]) { putPic({ ...picReady, status }); assert.equal((await media(e, picUrl)).status, 404); }
putPic(await approve(picReady));
assert.equal((await media(e, picUrl)).status, 200);
putPic(picReady, new Uint8Array([1, 2, 3])); // changed in HQ
assert.equal((await media(e, picUrl)).status, 409);
// A checked picture is kept in memory, so readers opening the email don't each cost a GitHub call.
putPic(picReady);
assert.equal((await media(e, picUrl)).status, 200);
delete hq[PIC];
clock = RealDate.parse("2026-10-25T16:00:00Z"); forgetHq();
assert.equal((await worker.fetch(new Request(`https://safetoclone.com${picUrl}`), e, {})).status, 200);
// A wrong picture: no test copy, Emile is told why.
reset();
putPic(picReady, new Uint8Array([1, 2, 3]));
e = env();
await run(e, "2026-10-25T16:00:00Z");
assert.equal(mails().filter((m) => /^\[Test\]/.test(m.subject)).length, 0);
assert.ok(mails().some((m) => /no test copy, a picture is wrong/.test(m.subject) && /fingerprint doesn't match/.test(m.text)));
// Right picture: the test copy shows it, and once approved it goes out with it.
reset();
putPic(picReady);
await run(e, "2026-10-25T16:30:00Z");
assert.equal(mails().filter((m) => /^\[Test\]/.test(m.subject)).length, 1);
assert.ok(mails().find((m) => /^\[Test\]/.test(m.subject)).html.includes(`nl-media/${PIC}?v=${gifHash}`));
assert.match(mails().find((m) => /^\[Test\]/.test(m.subject)).text, /\[Picture: A dial <spinning>\]/);
putPic(await approve(picReady));
await run(e, "2026-10-25T17:00:00Z");
assert.equal(sends().length, 1);
assert.ok(sends()[0].body.html.includes(`<img src="https://safetoclone.com/nl-media/${PIC}?v=${gifHash}"`));
// Approved, then the picture is changed or removed in HQ: not sent, Emile is told.
for (const file of [new Uint8Array([1, 2, 3]), null]) {
  reset();
  putPic(await approve(picReady), file);
  if (!file) delete hq[PIC];
  e = env();
  await run(e, "2026-10-25T17:00:00Z");
  await run(e, "2026-10-25T17:30:00Z");
  assert.equal(sends().length, 0);
  assert.equal(mails().filter((m) => /not sent, a picture is wrong/.test(m.subject)).length, 1);
}

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
// A form sent without JavaScript is saved the same way and gets a "you're on the list" page.
reset();
res = await worker.fetch(new Request("https://safetoclone.com/api/subscribe", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "email=Form%40Example.com" }), env());
assert.equal(res.status, 200);
assert.match(await res.text(), /You're on the list/);
assert.equal(calls.find((x) => x.path === "/contacts").body.email, "form@example.com");
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
