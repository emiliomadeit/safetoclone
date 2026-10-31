// Cloudflare Worker: serves the website files, fills in link previews for shared results (/?repo=owner/name),
// handles the newsletter signup, counts visits (stats.js, read them at /api/stats),
// posts approved Instagram posts (batch.js decides, instagram.js posts; status at /api/instagram/status,
// numbers at /api/instagram/results), sends the approved Sunday newsletter (newsletter.js decides; status at
// /api/newsletter/status), and runs /mcp, a read-only connector any AI agent can use.
// Needs one setting in Cloudflare > Workers & Pages > safetoclone > Settings > Variables and Secrets:
//   RESEND_API_KEY     (Secret, from resend.com > API keys, "Full access"). Also sends the robot's alert emails.
// Optional:
//   RESEND_SEGMENT_ID  (from resend.com > Audience > Segments) the list signups join and the newsletter goes to
//                      (without it: the account's only segment)
//   ALERT_EMAIL        where the robot's alert emails go (default hello@safetoclone.com)
import { autopost, status as instagramStatus, listing as igListing, metrics as igMetrics } from "./instagram.js";
import { hqFile, hqText, hqJson, batchPath, checkPath, hqHealth, hqKeyDaysLeft } from "./hq.js";
import { checkBatch, postProblem, claimsProblem, latestCheck, dueNow, dateIn, timeIn, addDays, mondayOf, sha256, DEFAULT_TIME, LATE_MINUTES } from "./batch.js";
import { repoPage, reposPage, missingPage, sitemap, findRepo, repoPath, subscribedPage } from "./seo.js";
import { count, sourceOf, hit, report as statsReport } from "./stats.js";
import { isSandbox, sandboxFetch } from "./sandbox.js";
import { checkIssue, fingerprint as issueFingerprint, sendWindowOpen, issueClaimsProblem, issuePath, renderHtml, renderText, FROM, NEWSLETTER_TIME } from "./newsletter.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const isForm = (request) => /application\/x-www-form-urlencoded|multipart\/form-data/.test(request.headers.get("Content-Type") || "");

async function subscribe(request, env) {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  const form = isForm(request);
  const { email: raw } = form ? Object.fromEntries(await request.formData().catch(() => new Map())) : await request.json().catch(() => ({}));
  const email = String(raw || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email address doesn't look right." }, 400);
  if (!env.RESEND_API_KEY) return json({ error: "Newsletter isn't connected yet." }, 503);
  // Every signup goes into the segment the newsletter robot sends to (RESEND_SEGMENT_ID, or the account's
  // only segment). Without this, contacts landed outside it and the Oct 26 issue had nobody to go to.
  const segment = await pickSegment(env, true).catch(() => null);
  const contact = { email, unsubscribed: false };
  if (segment) contact.segments = [{ id: segment.id }];
  const r = await resend(env, "/contacts", contact);
  // 409 = this email is already a contact, which is fine; make sure it's in the segment too.
  if (r.status === 409 && segment) await resend(env, `/contacts/${encodeURIComponent(email)}/segments/${segment.id}`, {}).catch(() => {});
  if (!r.ok && r.status !== 409) return json({ error: "Couldn't save your email. Try again later." }, 502);
  return json({ ok: true });
}

// ---- /mcp: a small read-only MCP server (https://modelcontextprotocol.io) ----
// Any AI agent can add it as a custom connector: to check grades before installing a repo, or (Meta Muse)
// to see which approved posts are coming. It only returns approved posts and public grades, so it needs no password.
const SITE = "https://safetoclone.com";
const TOOLS = [
  {
    name: "get_next_post",
    description: "Get the next approved SafeToClone Instagram post: the one dated today, or the next one coming up. The website posts it by itself at its time, so don't publish it. Returns the date, the time (Ottawa) it goes out, the image URL (image_urls has every slide when the post is a carousel), the caption and the image alt text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_upcoming_posts",
    description: "List every approved SafeToClone Instagram post dated today or later, in order. The website posts them by itself.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_safety_scores",
    description: "Get the latest SafeToClone safety grades (A to F) for popular AI tools on GitHub. Use it to answer questions in comments or DMs.",
    inputSchema: { type: "object", properties: {} },
  },
];
const MCP_INSTRUCTIONS =
  "SafeToClone grades GitHub projects for safety. Before installing a GitHub repo, call get_safety_scores to see its grade. " +
  "The website posts to the @safetoclone Instagram account by itself, only from weeks the owner approved. " +
  "get_next_post and list_upcoming_posts show what is coming. Never publish those posts yourself, or they would go out twice.";

async function readJson(env, path) {
  const r = await env.ASSETS.fetch(new Request(SITE + path));
  return r.ok ? r.json() : null;
}

// ---- Instagram: what may post (the rules are in batch.js) ----
// Posts live in the private HQ repo, one file per week (instagram/batches/<Monday>.json). Pictures are
// served through /ig-media/..., because Instagram needs a public link. If GitHub can't be reached, nothing
// posts and the next run (30 minutes later) tries again. There is no other copy to fall back on, on purpose.
const MEDIA = `${SITE}/ig-media/`;

// The weeks that matter now: last week (for yesterday's pictures), this week and next week.
async function loadWeeks(env) {
  if (!env.HQ_GITHUB_TOKEN) return [];
  const now = dateIn();
  const mondays = [...new Set([mondayOf(addDays(now, -1)), mondayOf(now), addDays(mondayOf(now), 7)])];
  return Promise.all(mondays.map(async (week) => {
    const text = await hqText(env, batchPath(week)); // throws if GitHub is down
    if (text === null) return { week, batch: null, check: { ok: false, reason: "no batch file" } };
    let batch;
    try { batch = JSON.parse(text); } catch { return { week, batch: null, check: { ok: false, changed: true, reason: "the batch file isn't valid JSON" } }; }
    return { week, batch, check: await checkBatch(batch) };
  }));
}

// Every post in those weeks, in time order, with the reason it can't go out ("" means it can).
function slots(weeks) {
  const out = [];
  for (const { batch, check } of weeks) {
    for (const p of batch?.posts || []) {
      out.push({ p, problem: check.ok ? postProblem(batch, p) : check.reason, changed: Boolean(check.changed) });
    }
  }
  const key = (s) => `${s.p.date || ""} ${s.p.time || DEFAULT_TIME}`;
  return out.sort((a, b) => key(a).localeCompare(key(b)));
}

// A post the way the robot (and /mcp) hands it out.
function forRobot(p, now = new Date()) {
  return {
    id: p.id,
    date: p.date,
    time: p.time || DEFAULT_TIME,
    due_today: p.date === dateIn(now),
    // due_now: its time has come, less than 3 hours ago. The robot only posts these.
    due_now: dueNow(p, now),
    image_url: MEDIA + p.images[0],
    image_urls: p.images.map((i) => MEDIA + i),
    caption: p.caption,
    alt_text: p.alts?.[0] || "",
    alt_texts: p.images.map((_, i) => p.alts?.[i] || ""),
  };
}

async function upcomingPosts(env) {
  const now = new Date();
  const today = dateIn(now);
  return slots(await loadWeeks(env))
    .filter((s) => !s.problem && s.p.date >= today)
    .map((s) => forRobot(s.p, now));
}

// The newest passing daily check (ops/nightly/<date>.md in HQ), from the last 3 days.
async function dailyCheck(env, now = new Date()) {
  const today = dateIn(now);
  const texts = await Promise.all([0, 1, 2].map((d) => hqText(env, checkPath(addDays(today, -d)))));
  return latestCheck(texts.filter(Boolean), now.getTime());
}

// Do the pictures in HQ still match the ones Emile approved?
async function picturesProblem(env, p) {
  for (let i = 0; i < p.images.length; i++) {
    const r = await hqFile(env, p.images[i]).catch(() => null);
    if (!r) return { problem: `couldn't read picture ${i + 1} from HQ` };
    if ((await sha256(await r.arrayBuffer())) !== p.image_hashes[i]) return { problem: `picture ${i + 1} changed after approval`, changed: true };
  }
  return { problem: "" };
}

// Emails Emile (through Resend, which the newsletter already uses) when the robot skips a post for a reason
// he should know about. At most once per post per day, so a problem doesn't send an email every 30 minutes.
async function alert(env, key, subject, text) {
  if (!env.RESEND_API_KEY || !env.INSTAGRAM) return false;
  if (await env.INSTAGRAM.get(key)) return false;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "SafeToClone robot <robot@safetoclone.com>", to: [env.ALERT_EMAIL || "hello@safetoclone.com"], subject, text }),
  }).catch(() => null);
  if (!r?.ok) return false;
  await env.INSTAGRAM.put(key, "1", { expirationTtl: 3 * 86400 });
  return true;
}

// Called after each robot run. Emails Emile (at most once a day each) when HQ couldn't be read for 2 hours in a
// row (one short GitHub hiccup is fine) and when the HQ key has fewer than 14 days left. Posting rules are untouched.
async function watchHq(env, now = new Date()) {
  if (!env.INSTAGRAM) return;
  const today = dateIn(now);
  if (hqHealth.expires !== undefined) await env.INSTAGRAM.put("hq:expires", hqHealth.expires ?? "none");
  if (hqHealth.fail) {
    const since = await env.INSTAGRAM.get("hq:down-since");
    if (!since) await env.INSTAGRAM.put("hq:down-since", now.toISOString());
    else if (now - new Date(since) >= 2 * 3600e3) {
      await alert(env, `alert:hq-down:${today}`, "SafeToClone: the website can't read HQ, so posts and the newsletter are stopped",
        `Since ${since} the website has not been able to read the private HQ repo (${hqHealth.error}).\n\n` +
        `While that lasts, nothing posts to Instagram and no newsletter goes out. The likely cause is that the GitHub key ` +
        `(HQ_GITHUB_TOKEN in Cloudflare) has expired or was revoked, or that GitHub is down. If GitHub is fine, make a new ` +
        `read-only key and paste it into Cloudflare.\n\nStatus: ${SITE}/api/instagram/status`);
    }
  } else if (hqHealth.ok && await env.INSTAGRAM.get("hq:down-since")) await env.INSTAGRAM.delete("hq:down-since");
  const left = hqKeyDaysLeft(hqHealth.expires, now);
  if (left !== null && left < 14) {
    await alert(env, `alert:hq-key-expiry:${today}`, `SafeToClone: the HQ GitHub key expires in ${Math.max(left, 0)} days`,
      `The GitHub key the website uses to read HQ (HQ_GITHUB_TOKEN in Cloudflare) expires on ${hqHealth.expires}.\n\n` +
      `After that, posts and the newsletter stop. Make a new read-only key on GitHub and paste it into Cloudflare before then.\n\nStatus: ${SITE}/api/instagram/status`);
  }
}

// When the HQ key expires, for /api/instagram/status. Live answer if we just talked to GitHub, else the last one the robot saw.
async function hqKeyStatus(env, now = new Date()) {
  const raw = hqHealth.expires !== undefined ? hqHealth.expires ?? "none" : await env.INSTAGRAM?.get("hq:expires");
  if (!raw) return "unknown (not seen yet)";
  if (raw === "none") return "no expiry date (the key doesn't expire)";
  const days = hqKeyDaysLeft(raw, now);
  return days === null ? raw : `${raw} (${days} days left)`;
}

// The last 20 posting errors, shown on the status page so the daily check can see them.
async function recordError(env, entry) {
  if (!env.INSTAGRAM) return;
  const list = (await env.INSTAGRAM.get("errors", "json")) || [];
  await env.INSTAGRAM.put("errors", JSON.stringify([entry, ...list].slice(0, 20)));
}

// One run of the robot (every 30 minutes, see wrangler.jsonc).
async function postDue(env, now = new Date()) {
  let weeks;
  try { weeks = await loadWeeks(env); } catch (e) { return console.log("Instagram: couldn't read HQ, nothing posts this run:", e.message); }
  const open = slots(weeks).filter((s) => dueNow(s.p, now));
  if (!open.length) return console.log("Instagram: nothing due now.");
  const today = dateIn(now);
  const tell = (p, why) => alert(env, `alert:${today}:${p.id}`, `Instagram: ${p.id} did not post`,
    `The robot skipped the post ${p.id} (${p.date} at ${p.time || DEFAULT_TIME}, Ottawa) because ${why}.\n\n` +
    `It tries again every 30 minutes until 3 hours after the post's time. Status: ${SITE}/api/instagram/status`);
  for (const s of open) {
    if (s.changed) await tell(s.p, s.problem); // approved, then edited: it never posts until approved again
    if (s.problem) console.log(`Instagram: ${s.p.id} skipped (${s.problem})`);
  }
  const due = open.filter((s) => !s.problem);
  if (!due.length) return;
  let check;
  try { check = await dailyCheck(env, now); } catch (e) { return console.log("Instagram: couldn't read the daily check, nothing posts:", e.message); }
  if (!check.ok) {
    for (const s of due) await tell(s.p, `${check.reason}. Posts only go out while the daily check in HQ (ops/nightly) has passed in the last 36 hours`);
    return console.log("Instagram: skipped, daily check:", check.reason);
  }
  // Today's grades (deployed with the site after each nightly build) and HQ's named repo groups, for the recheck.
  const dir = await readJson(env, "/data/directory.json").catch(() => null);
  const groups = await hqJson(env, "instagram/_shared/groups.json").catch(() => null);
  for (const s of due) {
    const claims = s.p.claims?.some((c) => c.kind === "count") && !groups ? "couldn't read the repo groups from HQ" : claimsProblem(s.p, dir, groups || {});
    if (claims) {
      await tell(s.p, claims);
      console.log(`Instagram: ${s.p.id} skipped (${claims})`);
      continue;
    }
    const pictures = await picturesProblem(env, s.p);
    if (pictures.problem) {
      if (pictures.changed) await tell(s.p, pictures.problem);
      console.log(`Instagram: ${s.p.id} skipped (${pictures.problem})`);
      continue;
    }
    const result = await autopost(env, forRobot(s.p, now)).catch((e) => ({ ok: false, post: s.p.id, error: e.message }));
    console.log("Instagram:", JSON.stringify(result));
    if (!result.ok) await recordError(env, { post: s.p.id, at: now.toISOString(), error: result.error || result.reason });
  }
}

// What the robot sees, for /api/instagram/status. Weeks that aren't approved only show their status.
async function postingStatus(env) {
  if (!env.HQ_GITHUB_TOKEN) return { error: "HQ_GITHUB_TOKEN isn't set, so nothing can post." };
  try {
    const now = new Date();
    const today = dateIn(now);
    const weeks = await loadWeeks(env);
    const daily = await dailyCheck(env, now);
    const ok = slots(weeks).filter((s) => !s.problem);
    const next = ok.find((s) => s.p.date > today || (s.p.date === today && (s.p.time || DEFAULT_TIME) > timeIn(now)));
    return {
      rule: `Posts only from approved weeks whose fingerprint still matches, while the daily check is under 36 hours old, from each post's time until ${LATE_MINUTES / 60} hours after.`,
      dailyCheck: daily,
      weeks: weeks.filter((w) => w.batch || w.check.changed).map(({ week, batch, check }) => (!batch ? { week, status: "unreadable", canPost: false, problem: check.reason } : batch.status === "approved" ? {
        week, status: batch.status, canPost: check.ok, problem: check.ok ? null : check.reason,
        paused: Boolean(batch.pause?.paused), pauseReason: batch.pause?.reason || null, posts: batch.posts.length,
        onHold: batch.posts.filter((p) => p.hold).map((p) => ({ id: p.id, reason: p.hold_reason || "" })),
        dropped: batch.approval?.dropped || [],
      } : { week, status: batch.status, canPost: false, problem: check.reason, posts: batch.posts?.length || 0 })),
      // Slots open right now (posted already, or about to be), then the next one coming up.
      openNow: ok.filter((s) => dueNow(s.p, now)).map((s) => s.p.id),
      next: next ? { id: next.p.id, date: next.p.date, time: next.p.time || DEFAULT_TIME } : null,
      recentErrors: env.INSTAGRAM ? (await env.INSTAGRAM.get("errors", "json")) || [] : [],
    };
  } catch (e) {
    return { error: `Couldn't read HQ: ${e.message}` };
  }
}

// safetoclone.com/ig-media/<path>: hands Instagram a picture from HQ. Only pictures of approved posts dated
// yesterday or later, and only if the picture is still the one Emile approved. So this can never be used
// to read anything else in the private repo.
async function igMedia(env, pathname) {
  const notFound = () => new Response("Not found", { status: 404 });
  if (!env.HQ_GITHUB_TOKEN) return notFound();
  let path = pathname.slice("/ig-media/".length);
  try { path = decodeURIComponent(path); } catch { return notFound(); }
  if (!/\.(jpe?g|png)$/i.test(path)) return notFound();
  let weeks;
  try { weeks = await loadWeeks(env); } catch { return new Response("HQ unreachable", { status: 502 }); }
  const yesterday = addDays(dateIn(), -1);
  let want = null;
  for (const { p, problem } of slots(weeks)) {
    if (problem || p.date < yesterday) continue;
    const i = p.images.indexOf(path);
    if (i >= 0) want = p.image_hashes[i];
  }
  if (!want) return notFound();
  const r = await hqFile(env, path).catch(() => null);
  if (!r) return new Response("HQ unreachable", { status: 502 });
  const bytes = await r.arrayBuffer();
  if ((await sha256(bytes)) !== want) return new Response("This picture changed after it was approved", { status: 409 });
  return new Response(bytes, {
    headers: { "Content-Type": /\.png$/i.test(path) ? "image/png" : "image/jpeg", "Cache-Control": "public, max-age=3600" },
  });
}

// safetoclone.com/api/instagram/results: numbers for the daily task in HQ (pull_results.py).
//   no ?ids   follower count and our latest 50 posts (id, time, start of caption)
//   ?ids=1,2  reach, saves, shares and so on for up to 20 of those posts
// Only numbers, never the key. Answers are kept for 30 minutes so nobody can make us call Instagram over and over.
async function igResults(env, url, ctx) {
  const ids = (url.searchParams.get("ids") || "").split(",").filter((x) => /^\d{1,30}$/.test(x)).slice(0, 20);
  const key = new Request(`${SITE}/api/instagram/results${ids.length ? "?ids=" + ids.join(",") : ""}`);
  const cache = globalThis.caches?.default;
  const kept = cache ? await cache.match(key) : null;
  if (kept) return kept;
  let body;
  try { body = ids.length ? await igMetrics(env, ids) : await igListing(env); } catch (e) { body = { error: e.message }; }
  const res = new Response(JSON.stringify(body, null, 2), {
    status: body.error ? 502 : 200,
    headers: { "Content-Type": "application/json", "Cache-Control": body.error ? "no-store" : "public, max-age=1800" },
  });
  if (cache && !body.error) {
    const job = cache.put(key, res.clone());
    if (ctx?.waitUntil) ctx.waitUntil(job); else await job;
  }
  return res;
}

async function callTool(name, env, track) {
  if (name === "get_next_post" || name === "list_upcoming_posts") {
    let posts;
    try { posts = await upcomingPosts(env); } catch { return { error: "Couldn't read the posts right now. Try again later." }; }
    if (name === "list_upcoming_posts") return { today: dateIn(), posts };
    return posts[0] || { message: "No approved posts are coming up." };
  }
  if (name === "get_safety_scores") {
    track?.("agent_mcp");
    const d = await readJson(env, "/data/directory.json");
    return {
      updated: d?.updatedAt,
      repos: (d?.repos || []).map((r) => ({ name: r.name, grade: r.grade, score: r.score, label: r.label, warnings: r.flags.map((f) => f.label || f) })),
    };
  }
  return null;
}

async function rpc(msg, env, track) {
  const { id, method, params } = msg || {};
  if (id === undefined || id === null) return null; // a notification: no reply needed
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  if (method === "initialize") {
    return ok({
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "safetoclone", version: "1.0.0" },
      instructions: MCP_INSTRUCTIONS,
    });
  }
  if (method === "ping") return ok({});
  if (method === "tools/list") return ok({ tools: TOOLS });
  if (method === "tools/call") {
    const out = await callTool(params?.name, env, track);
    if (!out) return fail(-32602, `Unknown tool: ${params?.name}`);
    return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
  }
  return fail(-32601, `Unknown method: ${method}`);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version",
};

async function mcp(request, env, track) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  // We never push messages to the client, so there is no event stream to open.
  if (request.method !== "POST") return new Response("Use POST", { status: 405, headers: { ...CORS, Allow: "POST" } });
  const body = await request.json().catch(() => undefined);
  if (body === undefined) {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Body is not JSON" } }), {
      status: 400, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  const replies = Array.isArray(body)
    ? (await Promise.all(body.map((m) => rpc(m, env, track)))).filter(Boolean)
    : [await rpc(body, env, track)].filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202, headers: CORS });
  return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---- Shared result links: safetoclone.com/?repo=owner/name ----
// The page itself runs the check in the visitor's browser. Here we only fill in the link preview
// (the title, text and picture that WhatsApp, Slack, LinkedIn, X... show when someone pastes the link).
// If the repo is in our nightly directory, the preview shows its grade. Otherwise it shows a general picture,
// because we never trust a grade written into the link itself (anyone could fake one).
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const SHARE_IMAGES = ["A-trusted", "B-fine", "C-careful", "D-careful", "F-careful", "D-unproven", "F-unproven", "A-dangerous", "B-dangerous", "C-dangerous", "D-dangerous", "F-dangerous"];

export function shareRepoName(param) {
  // Same rules as parseRepo in score.js: owner/name, letters, numbers, - _ . only.
  const m = String(param || "").trim().replace(/^https?:\/\//, "").replace(/^github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "")
    .match(/^([A-Za-z0-9-_.]{1,100})\/([A-Za-z0-9-_.]{1,100})$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function sharePreview(html, name, known) {
  const link = `${SITE}/?repo=${name}`;
  const title = known ? `${name}: grade ${known.grade} (${known.label}) on SafeToClone` : `Is ${name} safe to download? Check it on SafeToClone`;
  const description = known
    ? `${known.verdict} Score ${known.score}/100 in our last nightly check. Open the link for the full report.`
    : "A free safety grade from A to F, with a plain-English list of warning signs. Built for people who don't code.";
  const image = known && SHARE_IMAGES.includes(`${known.grade}-${known.level}`) ? `${known.grade}-${known.level}` : "default";
  const set = (attr, key, value) => {
    html = html.replace(new RegExp(`(<meta ${attr}="${key}" content=")[^"]*(")`), `$1${escAttr(value)}$2`);
  };
  set("property", "og:title", title);
  set("property", "og:description", description);
  set("property", "og:url", link);
  set("property", "og:image", `${SITE}/share/${image}.png`);
  set("property", "og:image:alt", known ? `SafeToClone grade ${known.grade}: ${known.label}` : "SafeToClone safety grade from A to F");
  set("name", "twitter:title", title);
  set("name", "twitter:description", description);
  set("name", "description", description);
  return html.replace(/<title>[^<]*<\/title>/, `<title>${escAttr(name)} safety check · SafeToClone</title>`);
}

async function homePage(request, env, url) {
  const page = await env.ASSETS.fetch(request);
  const name = shareRepoName(url.searchParams.get("repo"));
  if (!name || !page.ok || !(page.headers.get("Content-Type") || "").includes("text/html")) return page;
  const dir = await readJson(env, "/data/directory.json").catch(() => null);
  const known = (dir?.repos || []).find((r) => r.name.toLowerCase() === name.toLowerCase());
  const html = sharePreview(await page.text(), known ? known.name : name, known);
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" } });
}

// ---- Pages for Google (built in seo.js from the nightly directory) ----
// /repo/owner/name  one page per graded repo ("Is owner/name safe to download?")
// /repos            the list of every graded repo
// /sitemap.xml      the list of pages Google should read
async function seoPage(env, url) {
  const { pathname } = url;
  const dir = await readJson(env, "/data/directory.json").catch(() => null);
  const html = (body, status = 200) =>
    new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  if (pathname === "/sitemap.xml") {
    return new Response(sitemap(dir), { headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" } });
  }
  if (pathname === "/repos") return html(reposPage(dir));
  if (pathname === "/repos/") return Response.redirect(`${SITE}/repos`, 301);
  let rest = pathname.slice("/repo/".length);
  try { rest = decodeURIComponent(rest); } catch { /* bad % code in the address: use it as typed */ }
  const name = shareRepoName(rest);
  if (!name) return html(missingPage("this repo"), 404);
  const known = findRepo(dir, name);
  if (!known) return html(missingPage(name), 404);
  // One address per repo, so Google doesn't see copies: fix upper/lower case and trailing slashes.
  if (pathname !== repoPath(known.name)) return Response.redirect(SITE + repoPath(known.name), 301);
  return html(repoPage(known, dir));
}

// ---- Newsletter: sends the approved Sunday issue (the rules are in newsletter.js) ----
// The issue lives in HQ (newsletter/issues/<date>.json). Every 30 minutes the robot looks at today's file:
// a "ready" issue gets one test copy emailed to Emile; an approved one is sent once through Resend
// Broadcasts in its window. What was sent is remembered in the INSTAGRAM KV store (it's the robot's notebook).
// Optional setting: RESEND_SEGMENT_ID, the Resend segment to send to. Without it, the robot uses the
// account's only segment, and refuses if there are several.
const resend = (env, path, body) => fetch(`https://api.resend.com${path}`, {
  method: body === undefined ? "GET" : "POST",
  headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

let segmentsKept = null;
async function segments(env, fresh = false) {
  if (!fresh && segmentsKept && Date.now() - segmentsKept.at < 10 * 60e3) return segmentsKept.list;
  const r = await resend(env, "/segments");
  if (!r.ok) throw new Error(`Resend said ${r.status} when listing segments`);
  const list = ((await r.json()).data || []).map((x) => ({ id: x.id, name: x.name }));
  segmentsKept = { at: Date.now(), list };
  return list;
}

// The send itself always asks Resend fresh; the status page may use a 10-minute-old answer.
async function pickSegment(env, fresh = false) {
  if (env.RESEND_SEGMENT_ID) return { id: env.RESEND_SEGMENT_ID, how: "RESEND_SEGMENT_ID" };
  const list = await segments(env, fresh);
  if (list.length === 1) return { id: list[0].id, name: list[0].name, how: "the only segment" };
  throw new Error(list.length ? `Resend has ${list.length} segments, so set RESEND_SEGMENT_ID to pick one` : "Resend has no segment to send to");
}

// True only when Resend clearly says the segment has no contacts.
async function segmentIsEmpty(env, segmentId) {
  const r = await resend(env, `/contacts?segment_id=${encodeURIComponent(segmentId)}&limit=1`).catch(() => null);
  if (!r?.ok) return false;
  const body = await r.json().catch(() => null);
  return Array.isArray(body?.data) && body.data.length === 0;
}

const sentKey = (date) => `newsletter:sent:${date}`;

async function sendNewsletter(env, now = new Date()) {
  if (!env.RESEND_API_KEY || !env.HQ_GITHUB_TOKEN || !env.INSTAGRAM) return;
  const date = dateIn(now);
  let issue;
  try { issue = await hqJson(env, issuePath(date)); } catch (e) { return console.log("Newsletter: couldn't read HQ:", e.message); }
  if (!issue) return;
  const fp = await issueFingerprint(issue);
  const tell = (key, subject, text) => alert(env, `alert:newsletter:${date}:${key}`, subject, `${text}\n\nStatus: ${SITE}/api/newsletter/status`);

  // A ready issue: email Emile one test copy of this exact version.
  if (issue.status === "ready" && !(await env.INSTAGRAM.get(`newsletter:test:${fp}`))) {
    const banner = `Test copy for Emile, version ${fp.slice(0, 8)}. Subscribers get exactly this. If it looks right, say "yes" in your to-do thread.`;
    const r = await resend(env, "/emails", {
      from: FROM, to: [env.ALERT_EMAIL || "hello@safetoclone.com"], subject: `[Test] ${issue.subject}`,
      html: renderHtml(issue, { unsubscribe: SITE, banner }), text: `${banner}\n\n${renderText(issue, { unsubscribe: SITE })}`,
    }).catch(() => null);
    if (r?.ok) await env.INSTAGRAM.put(`newsletter:test:${fp}`, now.toISOString(), { expirationTtl: 14 * 86400 });
    return console.log("Newsletter: test copy", r?.ok ? "sent" : "failed");
  }

  const check = await checkIssue(issue);
  if (!check.ok) {
    if (check.changed) await tell(fp.slice(0, 8), "Newsletter: not sent, it changed after approval", `Today's issue was edited after you said yes, so it won't go out until you approve the new version.`);
    return console.log("Newsletter:", check.reason);
  }
  if (!sendWindowOpen(issue, now)) return;
  if (await env.INSTAGRAM.get(sentKey(date))) return; // already sent (or tried): never twice
  const dir = await readJson(env, "/data/directory.json").catch(() => null);
  const claims = issueClaimsProblem(issue, dir);
  if (claims) return tell("claims", "Newsletter: not sent, a grade changed", `Today's issue wasn't sent because ${claims}. Ask Claude to update it, then approve again.`);
  let segment;
  try { segment = await pickSegment(env, true); } catch (e) {
    return tell("segment", "Newsletter: not sent, no list to send to", `Today's issue wasn't sent: ${e.message}.`);
  }
  // An empty list makes Resend refuse the send (Oct 26). Stop before making a broadcast and tell Emile; it
  // tries again every 30 minutes in the window. If Resend can't answer, carry on rather than block the send.
  if (await segmentIsEmpty(env, segment.id)) {
    return tell("empty", "Newsletter: not sent, the list is empty", `Today's issue wasn't sent because the Resend segment "${segment.name || segment.id}" has no contacts. Open Resend > Audience, add your subscribers to it, and the robot sends within 30 minutes (up to 3 hours after the send time).`);
  }

  // Write down "sending" first, so a crash halfway can never lead to a second copy.
  await env.INSTAGRAM.put(sentKey(date), JSON.stringify({ state: "sending", at: now.toISOString(), version: fp.slice(0, 8) }));
  const made = await resend(env, "/broadcasts", {
    segment_id: segment.id, from: FROM, reply_to: "hello@safetoclone.com", name: `Newsletter ${date}`,
    subject: issue.subject, html: renderHtml(issue), text: renderText(issue),
  }).catch((e) => ({ ok: false, status: e.message }));
  const id = made.ok ? (await made.json()).id : null;
  if (!id) {
    // Nothing went out, so the next run (30 minutes later) may try again.
    await env.INSTAGRAM.delete(sentKey(date));
    await recordError(env, { post: `newsletter-${date}`, at: now.toISOString(), error: `create broadcast: ${made.status}` });
    await tell("create", "Newsletter: not sent yet", `Resend said ${made.status} when the robot tried to make today's broadcast. Nothing went out. It tries again every 30 minutes until 3 hours after the send time.`);
    return console.log("Newsletter: couldn't create the broadcast:", made.status);
  }
  // Resend allows about 2 requests a second. "429 too many requests" means it did nothing, so waiting and
  // asking again is safe. Any other refusal is never retried, so nobody can get two copies.
  let sent;
  for (let i = 0; i < 3; i++) {
    await new Promise((res) => setTimeout(res, 1500));
    sent = await resend(env, `/broadcasts/${id}/send`, {}).catch((e) => ({ ok: false, status: e.message, text: async () => "" }));
    if (sent.status !== 429) break;
  }
  const said = sent.ok ? "" : `${sent.status} ${(await sent.text().catch(() => "")).slice(0, 300)}`.trim();
  const record = { state: sent.ok ? "sent" : "unsure", at: new Date().toISOString(), broadcast: id, version: fp.slice(0, 8), segment: segment.name || segment.how, ...(said ? { resendSaid: said } : {}) };
  await env.INSTAGRAM.put(sentKey(date), JSON.stringify(record));
  console.log("Newsletter:", JSON.stringify(record));
  if (sent.ok) await tell("sent", `Newsletter sent: ${issue.subject}`, `Today's issue went out through Resend (broadcast ${id}). Check your inbox, and spam.`);
  else await tell("unsure", "Newsletter: check Resend", `The robot made today's broadcast (${id}) but Resend said "${said}" when asked to send it. It won't try again, so nobody gets two copies. Open Resend > Broadcasts and see whether it went out; if it's still a draft, click Send.`);
}

async function newsletterStatus(env, url) {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("date") || "") ? url.searchParams.get("date") : dateIn();
  const out = { rule: `Sends the approved issue for a date once, from its time (Ottawa, default ${NEWSLETTER_TIME}) until 3 hours after, if nothing changed since Emile's yes and its grades still hold. A "ready" issue gets one test copy to Emile first.`, date };
  if (!env.RESEND_API_KEY) out.problem = "RESEND_API_KEY isn't set";
  else if (!env.HQ_GITHUB_TOKEN) out.problem = "HQ_GITHUB_TOKEN isn't set";
  try {
    const issue = await hqJson(env, issuePath(date));
    if (!issue) out.issue = null;
    else {
      const fp = await issueFingerprint(issue);
      const check = await checkIssue(issue);
      out.issue = { status: issue.status || null, subject: issue.subject || null, time: issue.time || NEWSLETTER_TIME, version: fp.slice(0, 8), canSend: check.ok, problem: check.ok ? null : check.reason,
        testCopySent: env.INSTAGRAM ? await env.INSTAGRAM.get(`newsletter:test:${fp}`) : null };
    }
  } catch (e) { out.issue = { problem: `Couldn't read HQ: ${e.message}` }; }
  out.sent = env.INSTAGRAM ? await env.INSTAGRAM.get(sentKey(date), "json") : null;
  if (env.RESEND_API_KEY) {
    try { const s = await pickSegment(env); out.sendsTo = s.name || s.how; } catch (e) { out.sendsTo = null; out.segmentProblem = e.message; }
  }
  return new Response(JSON.stringify(out, null, 2), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// The checker on the home page asks OSV (osv.dev, Google's free database of known security holes) about the parts
// a project uses. Browsers can't always call OSV directly, so this passes the question on, unchanged.
// Only OSV's batch lookup, only POST, only a small JSON list of parts. It never forwards anything else.
const OSV_BATCH = "https://api.osv.dev/v1/querybatch";
export async function osvProxy(request, fetcher = fetch) {
  if (request.method !== "POST") return json({ error: "POST only" }, 405);
  const text = await request.text();
  if (text.length > 400000) return json({ error: "Too many parts" }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: "Not JSON" }, 400); }
  const queries = body?.queries;
  const ok = Array.isArray(queries) && queries.length > 0 && queries.length <= 1000 && queries.every((q) =>
    q && typeof q.version === "string" && typeof q.package?.name === "string" && typeof q.package?.ecosystem === "string");
  if (!ok) return json({ error: "Expected { queries: [{ package: { name, ecosystem }, version }] }, at most 1000" }, 400);
  const clean = queries.map((q) => ({ package: { name: q.package.name, ecosystem: q.package.ecosystem }, version: q.version }));
  const res = await fetcher(OSV_BATCH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ queries: clean }) });
  return new Response(await res.text(), { status: res.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

// Old addresses that should send visitors to the main one.
// Pull request previews use other workers.dev names, so they are left alone.
const OLD_HOSTS = ["www.safetoclone.com", "safetoclone.emileantoun10.workers.dev"];

const site = {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;
    // Visitor counts (stats.js). Runs after the page is sent, so it never slows a visit down.
    const track = (event, source = "") => {
      const job = count(env, request, event, source).catch(() => {});
      if (ctx?.waitUntil) ctx.waitUntil(job);
    };
    if (OLD_HOSTS.includes(url.hostname) && (request.method === "GET" || request.method === "HEAD")) {
      return Response.redirect(`https://safetoclone.com${pathname}${url.search}`, 301);
    }
    if (pathname === "/api/subscribe") {
      const res = await subscribe(request, env);
      if (res.ok) track("signup");
      // A form sent without JavaScript gets a page back, not JSON.
      if (isForm(request)) {
        const j = await res.clone().json().catch(() => ({}));
        return new Response(subscribedPage(res.ok, j.error || "Couldn't save your email. Try again later."), {
          status: res.ok ? 200 : res.status, headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return res;
    }
    if (pathname === "/api/hit") return hit(request, env);
    if (pathname === "/api/osv") return osvProxy(request);
    if (pathname === "/api/stats") return statsReport(env);
    if (pathname === "/mcp") return mcp(request, env, (event) => track(event));
    if (pathname === "/api/instagram/status") {
      const [account, posting] = await Promise.all([instagramStatus(env), postingStatus(env)]);
      return new Response(JSON.stringify({ ...account, posting, hqKeyExpires: await hqKeyStatus(env) }, null, 2), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
    if (pathname === "/api/newsletter/status" && request.method === "GET") return newsletterStatus(env, url);
    if (pathname === "/api/instagram/results" && request.method === "GET") return igResults(env, url, ctx);
    if (pathname.startsWith("/ig-media/") && (request.method === "GET" || request.method === "HEAD")) return igMedia(env, pathname);
    const read = request.method === "GET" || request.method === "HEAD";
    if (pathname === "/" && request.method === "GET") track("home", sourceOf(request));
    if (pathname.startsWith("/repo/") && request.method === "GET") track("repo_page", sourceOf(request));
    if (pathname === "/repos" && request.method === "GET") track("repos_page", sourceOf(request));
    if (pathname === "/" && read) return homePage(request, env, url);
    if (read && (pathname === "/sitemap.xml" || pathname === "/repos" || pathname === "/repos/" || pathname.startsWith("/repo/"))) return seoPage(env, url);
    return env.ASSETS.fetch(request);
  },
  // Runs on the schedule in wrangler.jsonc, every 30 minutes. Each approved post goes out at the first run
  // after its time; the next runs (up to 3 hours later) are second tries, and see the post is up and skip it.
  async scheduled(event, env, ctx) {
    if (env.SAFETOCLONE_ENV === "sandbox") return;
    Object.assign(hqHealth, { ok: 0, fail: 0, error: "" });
    await postDue(env);
    await sendNewsletter(env).catch((e) => console.log("Newsletter:", e.message));
    await watchHq(env).catch((e) => console.log("HQ watch:", e.message));
  },
};

export default {
  fetch(request, env, ctx) {
    return isSandbox(request, env) ? sandboxFetch(request, env, ctx, site.fetch) : site.fetch(request, env, ctx);
  },
  scheduled: site.scheduled,
};
