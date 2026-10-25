// Cloudflare Worker: serves the website files, fills in link previews for shared results (/?repo=owner/name),
// handles the newsletter signup, counts visits (stats.js, read them at /api/stats),
// posts approved Instagram posts (batch.js decides, instagram.js posts; status at /api/instagram/status,
// numbers at /api/instagram/results), and runs /mcp, a read-only connector any AI agent can use.
// Needs one setting in Cloudflare > Workers & Pages > safetoclone > Settings > Variables and Secrets:
//   RESEND_API_KEY     (Secret, from resend.com > API keys, "Full access"). Also sends the robot's alert emails.
// Optional:
//   RESEND_SEGMENT_ID  (from resend.com > Audience > Segments) to also tag signups with a segment
//   ALERT_EMAIL        where the robot's alert emails go (default hello@safetoclone.com)
import { autopost, status as instagramStatus, listing as igListing, metrics as igMetrics } from "./instagram.js";
import { hqFile, hqText, batchPath, checkPath } from "./hq.js";
import { checkBatch, postProblem, latestCheck, dueNow, dateIn, timeIn, addDays, mondayOf, sha256, DEFAULT_TIME, LATE_MINUTES } from "./batch.js";
import { repoPage, reposPage, missingPage, sitemap, findRepo, repoPath } from "./seo.js";
import { count, sourceOf, hit, report as statsReport } from "./stats.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function subscribe(request, env) {
  if (request.method !== "POST") return json({ error: "Use POST" }, 405);
  const { email: raw } = await request.json().catch(() => ({}));
  const email = String(raw || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email address doesn't look right." }, 400);
  if (!env.RESEND_API_KEY) return json({ error: "Newsletter isn't connected yet." }, 503);
  const contact = { email, unsubscribed: false };
  if (env.RESEND_SEGMENT_ID) contact.segments = [{ id: env.RESEND_SEGMENT_ID }];
  const r = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(contact),
  });
  // 409 = this email is already on the list, which is fine.
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
  for (const s of due) {
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

// Old addresses that should send visitors to the main one.
// Pull request previews use other workers.dev names, so they are left alone.
const OLD_HOSTS = ["www.safetoclone.com", "safetoclone.emileantoun10.workers.dev"];

export default {
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
      return res;
    }
    if (pathname === "/api/hit") return hit(request, env);
    if (pathname === "/api/stats") return statsReport(env);
    if (pathname === "/mcp") return mcp(request, env, (event) => track(event));
    if (pathname === "/api/instagram/status") {
      const [account, posting] = await Promise.all([instagramStatus(env), postingStatus(env)]);
      return new Response(JSON.stringify({ ...account, posting }, null, 2), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
    }
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
    await postDue(env);
  },
};
