// The approval lock for Instagram posts. The robot (worker.js) only posts from a weekly batch file in the
// private HQ repo (instagram/batches/<Monday>.json) that Emile approved, and only if nothing changed since.
// Rules and file layout: instagram/README.md in HQ. This file has no keys and talks to nothing: it only checks.
//
// A post goes out only when all of these are true:
// 1. Its week's batch has status "approved", passed review, and records Emile's tap (by, at, evidence).
// 2. The batch fingerprint (a SHA-256 of everything people see) equals the one Emile approved. HQ's
//    _tools/common.py makes the same fingerprint the same way, and test/batch.test.mjs checks they match.
// 3. The week isn't paused, and the post isn't on hold or dropped.
// 4. Every picture's own fingerprint still matches (checked again when Instagram downloads it).
// 5. The daily check in HQ (ops/nightly/<date>.md) says "pass" and is less than 36 hours old.
// 6. Its time (Ottawa) has come, but not more than 3 hours ago, so a missed slot never posts late in a bunch.

export const DEFAULT_TIME = "10:00";
export const CHECK_MAX_HOURS = 36;
export const LATE_MINUTES = 180;
const OTTAWA = "America/Toronto";

// Dates and times where Emile lives (Ottawa).
export const dateIn = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: OTTAWA });
export const timeIn = (d = new Date()) =>
  d.toLocaleTimeString("en-GB", { timeZone: OTTAWA, hour: "2-digit", minute: "2-digit", hour12: false }).replace(/^24/, "00");
export function addDays(date, n) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function mondayOf(date) {
  const weekday = (new Date(date + "T12:00:00Z").getUTCDay() + 6) % 7; // Monday = 0
  return addDays(date, -weekday);
}

export async function sha256(data) {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// What Emile's approval locks: each post's id, channel, date, time, pictures, picture fingerprints, alt text
// and caption. Status, approval, pause, holds and drops are left out on purpose: they can only stop posts.
// Must stay exactly the same as fingerprint() in HQ's instagram/_tools/common.py.
export async function fingerprint(batch) {
  const rows = [...(batch?.posts || [])]
    .sort((a, b) => a.n - b.n)
    .map((p) => {
      const get = (key, fallback) => (key in p ? p[key] : fallback);
      return [p.id, get("channel", "instagram"), p.date, p.time || DEFAULT_TIME,
        get("images", []), get("image_hashes", []), get("alts", []), get("caption", "")];
    });
  return sha256(JSON.stringify(rows));
}

// Can anything in this week post? Returns { ok: true } or { ok: false, reason, changed, paused }.
// `changed` means it was approved but something was edited after: that one deserves an alert email.
export async function checkBatch(batch) {
  if (!batch || !Array.isArray(batch.posts)) return { ok: false, reason: "no batch file" };
  if (batch.status !== "approved") return { ok: false, reason: `not approved (status: ${batch.status || "none"})` };
  const a = batch.approval || {};
  if (a.by !== "Emile" || !a.at || !a.evidence) return { ok: false, reason: "approval doesn't record Emile's tap" };
  if (batch.review?.verdict !== "pass") return { ok: false, reason: "review didn't pass" };
  const fp = await fingerprint(batch);
  if (a.hash !== fp || batch.review.hash !== fp) {
    return { ok: false, changed: true, reason: "posts changed after approval (the fingerprint doesn't match)" };
  }
  if (batch.pause?.paused) return { ok: false, paused: true, reason: `paused: ${batch.pause.reason || "no reason given"}` };
  return { ok: true, fingerprint: fp };
}

// Can this one post go out, in a batch that passed checkBatch? "" means yes, otherwise the reason it can't.
export function postProblem(batch, p) {
  if ((p.channel ?? "instagram") !== "instagram") return "not an Instagram post";
  if (p.hold) return `on hold: ${p.hold_reason || "no reason given"}`;
  if ((batch.approval?.dropped || []).includes(p.n)) return "dropped by Emile";
  const images = p.images || [];
  if (!images.length || images.length > 10) return `needs 1 to 10 pictures, has ${images.length}`;
  if ((p.image_hashes || []).length !== images.length) return "a picture has no fingerprint";
  if (!p.caption) return "no caption";
  return "";
}

// The daily check file: first line "pass" (or "fail: why"), and a line "checked_at: <UTC time>".
export function readDailyCheck(text) {
  const lines = String(text || "").split(/\r?\n/);
  const at = Date.parse((String(text || "").match(/^checked_at:\s*(\S+)/m) || [])[1] || "");
  return { pass: lines[0].trim() === "pass", at: Number.isNaN(at) ? null : at };
}

// The newest passing check among the files given. ok is false when it is missing, in the future or too old.
export function latestCheck(texts, now = Date.now()) {
  const passed = texts.map(readDailyCheck).filter((c) => c.pass && c.at && c.at <= now + 5 * 60e3);
  if (!passed.length) return { ok: false, reason: "no passing daily check in the last 3 days" };
  const at = Math.max(...passed.map((c) => c.at));
  const ageHours = Math.round(((now - at) / 36e5) * 10) / 10;
  if (ageHours > CHECK_MAX_HOURS) return { ok: false, checkedAt: new Date(at).toISOString(), ageHours, reason: `the last passing daily check is ${ageHours} hours old` };
  return { ok: true, checkedAt: new Date(at).toISOString(), ageHours };
}

const minutes = (hhmm) => {
  const [h, m] = String(hhmm).split(":").map(Number);
  return h * 60 + m;
};

// Is this post's slot open right now? From its time until 3 hours after.
export function dueNow(p, now = new Date()) {
  if (p.date !== dateIn(now)) return false;
  const late = minutes(timeIn(now)) - minutes(p.time || DEFAULT_TIME);
  return late >= 0 && late <= LATE_MINUTES;
}
