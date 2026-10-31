// The newsletter robot's rules. The issue lives in the private HQ repo (newsletter/issues/<date>.json).
// worker.js reads it and sends it through Resend. This file has no keys and talks to nothing: it only
// checks and draws. Rules and file layout: newsletter/README.md in HQ.
//
// What happens to an issue:
// 1. status "ready": the robot emails Emile one test copy (once per version), so he sees exactly what
//    subscribers will get.
//    The test copy has a "Review and approve" button: a one-time link to safetoclone.com/newsletter/approve for
//    that exact version. Opening it shows the email; only tapping Approve there (a POST) records his yes, in
//    the INSTAGRAM KV store (the website can't write to HQ).
// 2. Or Emile says yes in his thread. Claude records it in HQ (status "approved", approval.by "Emile", at,
//    evidence, hash = the fingerprint below).
// 3. On the issue's date, from its time (Ottawa) until 3 hours after, the robot sends it once, if the
//    fingerprint still matches and every grade it names is still true today.
import { checkClaim, dateIn, timeIn, sha256 } from "./batch.js";

const SITE = "https://safetoclone.com";

export const NEWSLETTER_TIME = "09:00";
export const SEND_LATE_MINUTES = 180;
export const issuePath = (date) => `newsletter/issues/${date}.json`;
export const FROM = "Emile from SafeToClone <hello@safetoclone.com>";
export const UNSUBSCRIBE = "{{{RESEND_UNSUBSCRIBE_URL}}}"; // Resend swaps in each reader's own link

// What Emile's yes locks: everything a reader sees, plus when it goes out.
// Must stay the same as fingerprint() in HQ's newsletter/_tools/issue.py (test/newsletter.test.mjs checks).
export async function fingerprint(issue) {
  const i = issue || {};
  return sha256(JSON.stringify([i.date, i.time || NEWSLETTER_TIME, i.subject, i.preview, i.body]));
}

// Can this issue be sent? { ok: true, source } or { ok: false, reason, changed }.
// Approved = the HQ file records Emile's yes for this exact version, or `button` (his tap on the approve
// page, kept in KV) is for this exact version and HQ still says "ready" or "approved" (so HQ can still hold it).
export async function checkIssue(issue, button = null) {
  if (!issue) return { ok: false, reason: "no issue file" };
  for (const key of ["date", "subject", "preview", "body"]) {
    if (!issue[key]) return { ok: false, reason: `the issue has no ${key}` };
  }
  const pics = pictures(issue);
  if (pics.problem) return { ok: false, reason: pics.problem };
  const fp = await fingerprint(issue);
  const a = issue.approval || {};
  let problem;
  if (issue.status !== "approved") problem = { reason: `not approved (status: ${issue.status || "none"})` };
  else if (a.by !== "Emile" || !a.at || !a.evidence) problem = { reason: "approval doesn't record Emile's yes" };
  else if (a.hash !== fp) problem = { changed: true, reason: "the issue changed after Emile approved it" };
  if (!problem) return { ok: true, source: "HQ file" };
  if (button?.hash === fp && ["ready", "approved"].includes(issue.status)) return { ok: true, source: "approve button" };
  return { ok: false, ...problem };
}

// Is the send window open? On the issue's date, from its time until 3 hours after.
const lateBy = (issue, now) => { const min = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; }; return min(timeIn(now)) - min(issue.time || NEWSLETTER_TIME); };
export function sendWindowOpen(issue, now = new Date()) {
  if (issue?.date !== dateIn(now)) return false;
  const late = lateBy(issue, now);
  return late >= 0 && late <= SEND_LATE_MINUTES;
}
// Too late to go out at all (the approve page says so instead of promising a send).
export function sendWindowPassed(issue, now = new Date()) {
  const today = dateIn(now);
  return issue.date === today ? lateBy(issue, now) > SEND_LATE_MINUTES : issue.date < today;
}

// "" when every grade and score the issue names is still true in today's directory.
export function issueClaimsProblem(issue, dir) {
  if (!dir?.repos) return "couldn't read today's grades";
  for (const c of issue.claims || []) {
    let res;
    if (c.kind === "score") {
      const r = dir.repos.find((x) => x.name.toLowerCase() === String(c.repo).toLowerCase());
      res = r ? { ok: Number(r.score) === Number(c.expect), now: r.score } : { ok: false, now: "not in the directory" };
    } else {
      res = checkClaim(c, dir);
    }
    if (res.ok === false) return `"${c.text}" is no longer true (expected ${c.expect}, now ${res.now})`;
  }
  return "";
}

// ---- Pictures ----
// A line on its own: ![alt text](newsletter/images/<issue date>/<file>.png|gif|jpg#sha256=<64 hex>).
// The sha256 is part of the body, so the fingerprint above already locks the pictures too. worker.js serves
// them at /nl-media/<path>?v=<sha256> and checks the bytes still match before every test copy and send.
export const MAX_PICTURES = 6;
export const MAX_PICTURE_BYTES = 3 * 1024 * 1024;
export const PICTURE_TYPES = { png: "image/png", gif: "image/gif", jpg: "image/jpeg" };
const PICTURE = /^!\[([^\]]+)\]\((newsletter\/images\/(\d{4}-\d{2}-\d{2})\/[\w-][\w.-]*\.(png|gif|jpg))#sha256=([0-9a-f]{64})\)$/;
const parsePicture = (line) => {
  const m = String(line).trim().match(PICTURE);
  return m && !m[2].includes("..") ? { alt: m[1], path: m[2], date: m[3], type: PICTURE_TYPES[m[4]], hash: m[5] } : null;
};
export const pictureUrl = (pic) => `${SITE}/nl-media/${pic.path}?v=${pic.hash}`;

// Every picture in the issue, or a plain reason it can't go out.
export function pictures(issue) {
  const list = [];
  for (const line of String(issue?.body || "").split("\n")) {
    if (!line.trim().startsWith("![")) continue;
    const pic = parsePicture(line);
    if (!pic) return { list, problem: `a picture line isn't written right (${line.trim().slice(0, 100)})` };
    if (pic.date !== issue.date) return { list, problem: `picture ${pic.path} must be in newsletter/images/${issue.date}/` };
    list.push(pic);
  }
  if (list.length > MAX_PICTURES) return { list, problem: `it has ${list.length} pictures (at most ${MAX_PICTURES})` };
  return { list, problem: "" };
}

// ---- Drawing the email ----
// The body is plain Markdown-ish text, the same words Emile approved: blank lines between paragraphs,
// "## " section headings, **bold**, *italic*, "- " for list items, bare https:// links and pictures (above).
// Every email ends with the one-tap rating (/newsletter/rate/<vote>, counted in stats.js) and the unsubscribe link.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  return esc(text)
    .replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:#0b6b3a">${u.replace(/\?ref=\w+$/, "").replace(/^https:\/\//, "").replace(/\/$/, "")}</a>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

// A picture line is always its own block.
const blocks = (body) => String(body).replace(/\r/g, "").replace(/^[ \t]*(!\[.*)$/gm, "\n$1\n").trim().split(/\n\s*\n/);

export const RATINGS = [["love", "😍", "Love it"], ["good", "🙂", "Good"], ["soso", "😐", "So so"]];
// test: the rating links in Emile's test copy and on the approve page don't count.
const rateUrl = (vote, test) => `${SITE}/newsletter/rate/${vote}${test ? "?test=1" : ""}`;

export function renderHtml(issue, { unsubscribe = UNSUBSCRIBE, banner = "", approveUrl = "", test = false } = {}) {
  const p = 'style="margin:0 0 16px;font-size:16px;line-height:1.55"';
  const parts = blocks(issue.body).map((b) => {
    const pic = parsePicture(b);
    if (pic) return `<img src="${pictureUrl(pic)}" alt="${esc(pic.alt)}" width="528" style="display:block;width:100%;max-width:100%;height:auto;border:0;border-radius:8px;margin:0 0 16px">`;
    const lines = b.split("\n");
    let out = "";
    while (lines[0]?.startsWith("## ")) out += `<h2 style="margin:28px 0 12px;font-size:20px;line-height:1.3">${inline(lines.shift().slice(3))}</h2>`;
    if (!lines.length) return out;
    if (lines.every((l) => l.startsWith("- "))) {
      return out + `<ul style="margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.55">${lines.map((l) => `<li style="margin:0 0 8px">${inline(l.slice(2))}</li>`).join("")}</ul>`;
    }
    return out + `<p ${p}>${lines.map(inline).join("<br>")}</p>`;
  });
  const rate = RATINGS.map(([v, emoji, label]) => `<a href="${rateUrl(v, test)}" style="display:inline-block;margin:0 8px 8px 0;padding:8px 14px;border:1px solid #cccccc;border-radius:20px;color:#1a1a1a;text-decoration:none;font-size:15px">${emoji} ${label}</a>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(issue.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(issue.preview)}</div>` +
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px">` +
    (banner ? `<p style="margin:0 0 20px;padding:10px 12px;background:#fff4d6;border-radius:6px;font-size:14px;line-height:1.5">${esc(banner)}</p>` : "") +
    (approveUrl ? `<p style="margin:0 0 28px"><a href="${esc(approveUrl)}" style="display:inline-block;padding:14px 26px;background:#0b6b3a;color:#ffffff;border-radius:24px;font-size:17px;font-weight:600;text-decoration:none">Review and approve</a></p>` : "") +
    `${parts.join("")}` +
    `<hr style="border:none;border-top:1px solid #dddddd;margin:24px 0 16px">` +
    `<p style="margin:0 0 10px;font-size:15px;font-weight:600">How was this week's?</p><p style="margin:0 0 20px">${rate}</p>` +
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#555555">You're getting this because you signed up at safetoclone.com. ` +
    `<a href="${unsubscribe}" style="color:#555555">Unsubscribe</a></p></div></body></html>`;
}

export function renderText(issue, { unsubscribe = UNSUBSCRIBE, test = false } = {}) {
  const body = blocks(issue.body).map((b) => parsePicture(b) ? `[Picture: ${parsePicture(b).alt}]` : b.replace(/^## /gm, "").replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1")).join("\n\n");
  const rate = RATINGS.map(([v, emoji, label]) => `${emoji} ${label}: ${rateUrl(v, test)}`).join("\n");
  return `${body}\n\n---\nHow was this week's?\n${rate}\n\nYou're getting this because you signed up at safetoclone.com. Unsubscribe: ${unsubscribe}\n`;
}
