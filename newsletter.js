// The newsletter robot's rules. The issue lives in the private HQ repo (newsletter/issues/<date>.json).
// worker.js reads it and sends it through Resend. This file has no keys and talks to nothing: it only
// checks and draws. Rules and file layout: newsletter/README.md in HQ.
//
// What happens to an issue:
// 1. status "ready": the robot emails Emile one test copy (once per version), so he sees exactly what
//    subscribers will get.
// 2. Emile says yes in his thread. Claude records it (status "approved", approval.by "Emile", at, evidence,
//    hash = the fingerprint below).
// 3. On the issue's date, from its time (Ottawa) until 3 hours after, the robot sends it once, if the
//    fingerprint still matches and every grade it names is still true today.
import { checkClaim, dateIn, timeIn, sha256 } from "./batch.js";

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

// Can this issue be sent? { ok: true } or { ok: false, reason, changed }.
export async function checkIssue(issue) {
  if (!issue) return { ok: false, reason: "no issue file" };
  for (const key of ["date", "subject", "preview", "body"]) {
    if (!issue[key]) return { ok: false, reason: `the issue has no ${key}` };
  }
  if (issue.status !== "approved") return { ok: false, reason: `not approved (status: ${issue.status || "none"})` };
  const a = issue.approval || {};
  if (a.by !== "Emile" || !a.at || !a.evidence) return { ok: false, reason: "approval doesn't record Emile's yes" };
  if (a.hash !== (await fingerprint(issue))) return { ok: false, changed: true, reason: "the issue changed after Emile approved it" };
  return { ok: true };
}

// Is the send window open? On the issue's date, from its time until 3 hours after.
export function sendWindowOpen(issue, now = new Date()) {
  if (issue?.date !== dateIn(now)) return false;
  const min = (t) => { const [h, m] = String(t).split(":").map(Number); return h * 60 + m; };
  const late = min(timeIn(now)) - min(issue.time || NEWSLETTER_TIME);
  return late >= 0 && late <= SEND_LATE_MINUTES;
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

// ---- Drawing the email ----
// The body is plain Markdown-ish text, the same words Emile approved: blank lines between paragraphs,
// **bold**, *italic*, "- " for list items, and bare https:// links.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(text) {
  return esc(text)
    .replace(/https:\/\/[^\s<]+[^\s<.,;:!?)]/g, (u) => `<a href="${u}" style="color:#0b6b3a">${u.replace(/\?ref=\w+$/, "").replace(/^https:\/\//, "").replace(/\/$/, "")}</a>`)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

const blocks = (body) => String(body).replace(/\r/g, "").trim().split(/\n\s*\n/);

export function renderHtml(issue, { unsubscribe = UNSUBSCRIBE, banner = "" } = {}) {
  const p = 'style="margin:0 0 16px;font-size:16px;line-height:1.55"';
  const parts = blocks(issue.body).map((b) => {
    const lines = b.split("\n");
    if (lines.every((l) => l.startsWith("- "))) {
      return `<ul style="margin:0 0 16px;padding-left:22px;font-size:16px;line-height:1.55">${lines.map((l) => `<li style="margin:0 0 8px">${inline(l.slice(2))}</li>`).join("")}</ul>`;
    }
    return `<p ${p}>${lines.map(inline).join("<br>")}</p>`;
  });
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(issue.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:#ffffff;color:#1a1a1a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(issue.preview)}</div>` +
    `<div style="max-width:560px;margin:0 auto;padding:24px 16px">` +
    (banner ? `<p style="margin:0 0 20px;padding:10px 12px;background:#fff4d6;border-radius:6px;font-size:14px;line-height:1.5">${esc(banner)}</p>` : "") +
    `${parts.join("")}` +
    `<hr style="border:none;border-top:1px solid #dddddd;margin:24px 0 16px">` +
    `<p style="margin:0;font-size:13px;line-height:1.5;color:#555555">You're getting this because you signed up at safetoclone.com. ` +
    `<a href="${unsubscribe}" style="color:#555555">Unsubscribe</a></p></div></body></html>`;
}

export function renderText(issue, { unsubscribe = UNSUBSCRIBE } = {}) {
  const body = blocks(issue.body).map((b) => b.replace(/\*\*(.+?)\*\*/g, "$1").replace(/\*(.+?)\*/g, "$1")).join("\n\n");
  return `${body}\n\n---\nYou're getting this because you signed up at safetoclone.com. Unsubscribe: ${unsubscribe}\n`;
}
