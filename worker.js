// Cloudflare Worker: serves the website files, fills in link previews for shared results (/?repo=owner/name),
// handles the newsletter signup,
// posts to Instagram once a day (instagram.js, status at /api/instagram/status),
// and runs /mcp, a read-only connector any AI agent (like Meta Muse) can use to read our posts and scores.
// Needs one setting in Cloudflare > Workers & Pages > safetoclone > Settings > Variables and Secrets:
//   RESEND_API_KEY     (Secret, from resend.com > API keys, "Full access")
// Optional:
//   RESEND_SEGMENT_ID  (from resend.com > Audience > Segments) to also tag signups with a segment
import { autopost, status as instagramStatus } from "./instagram.js";
import { repoPage, reposPage, missingPage, sitemap, findRepo, repoPath } from "./seo.js";

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
// Meta Muse adds it as a custom connector, then calls get_next_post to find what to post on Instagram.
// Everything it returns is already public on the site, so it needs no password.
const SITE = "https://safetoclone.com";
const TOOLS = [
  {
    name: "get_next_post",
    description: "Get the next SafeToClone Instagram post: the one dated today, or the next one coming up. Returns the date, the image URL, the caption to use word for word, and the image alt text.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_upcoming_posts",
    description: "List every SafeToClone Instagram post dated today or later, in order.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_safety_scores",
    description: "Get the latest SafeToClone safety grades (A to F) for popular AI tools on GitHub. Use it to answer questions in comments or DMs.",
    inputSchema: { type: "object", properties: {} },
  },
];
const MCP_INSTRUCTIONS =
  "SafeToClone grades GitHub projects for safety. Posts for the @safetoclone Instagram account are written by the SafeToClone team. " +
  "To post: call get_next_post, then publish its image_url with its caption exactly as given. Do not post anything dated in the future.";

// Today's date where Emile lives (Ottawa), as YYYY-MM-DD.
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Toronto" });

async function readJson(env, path) {
  const r = await env.ASSETS.fetch(new Request(SITE + path));
  return r.ok ? r.json() : null;
}

async function upcomingPosts(env) {
  const data = await readJson(env, "/data/instagram-posts.json");
  const now = today();
  return (data?.posts || [])
    .filter((p) => p.date >= now)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((p) => ({
      id: p.id,
      date: p.date,
      due_today: p.date === now,
      image_url: `${SITE}/${p.image}`,
      caption: p.caption,
      alt_text: p.alt,
    }));
}

async function callTool(name, env) {
  if (name === "get_next_post") {
    const [next] = await upcomingPosts(env);
    return next || { message: "No posts are queued. Nothing to post." };
  }
  if (name === "list_upcoming_posts") return { today: today(), posts: await upcomingPosts(env) };
  if (name === "get_safety_scores") {
    const d = await readJson(env, "/data/directory.json");
    return {
      updated: d?.updatedAt,
      repos: (d?.repos || []).map((r) => ({ name: r.name, grade: r.grade, score: r.score, label: r.label, warnings: r.flags.map((f) => f.label || f) })),
    };
  }
  return null;
}

async function rpc(msg, env) {
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
    const out = await callTool(params?.name, env);
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

async function mcp(request, env) {
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
    ? (await Promise.all(body.map((m) => rpc(m, env)))).filter(Boolean)
    : [await rpc(body, env)].filter(Boolean);
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
const SHARE_IMAGES = ["A-trusted", "B-fine", "C-careful", "D-unproven", "F-unproven", "A-dangerous", "B-dangerous", "C-dangerous", "D-dangerous", "F-dangerous"];

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
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    if (OLD_HOSTS.includes(url.hostname) && (request.method === "GET" || request.method === "HEAD")) {
      return Response.redirect(`https://safetoclone.com${pathname}${url.search}`, 301);
    }
    if (pathname === "/api/subscribe") return subscribe(request, env);
    if (pathname === "/mcp") return mcp(request, env);
    if (pathname === "/api/instagram/status") return json(await instagramStatus(env));
    const read = request.method === "GET" || request.method === "HEAD";
    if (pathname === "/" && read) return homePage(request, env, url);
    if (read && (pathname === "/sitemap.xml" || pathname === "/repos" || pathname === "/repos/" || pathname.startsWith("/repo/"))) return seoPage(env, url);
    return env.ASSETS.fetch(request);
  },
  // Runs on the schedule in wrangler.jsonc: posts today's Instagram post, if there is one.
  async scheduled(event, env, ctx) {
    const [next] = await upcomingPosts(env);
    const result = await autopost(env, next);
    console.log("Instagram:", JSON.stringify(result));
  },
};
