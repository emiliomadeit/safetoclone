// Simple visitor counts, so we can tell which places (Reddit, Hacker News, Google...) bring people.
// Stores only totals per day: no IP addresses, no cookies, nothing about who the visitor is.
// Kept in the INSTAGRAM KV store under keys "stats:YYYY-MM-DD". Read them at safetoclone.com/api/stats.
// Counts are rough: two visits in the same instant can overwrite each other. Good enough to compare sources.

export const EVENTS = ["home", "repo_page", "repos_page", "check", "copy_link", "image", "signup"];
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|headless/i;
const day = (d = new Date()) => d.toISOString().slice(0, 10);

// Where the visitor came from: a ?ref= tag we put on our own links (?ref=reddit), or the site that linked here.
export function sourceOf(request) {
  const url = new URL(request.url);
  const tag = (url.searchParams.get("ref") || url.searchParams.get("utm_source") || "").toLowerCase();
  if (/^[a-z0-9_.-]{1,30}$/.test(tag)) return tag;
  try {
    const host = new URL(request.headers.get("Referer") || "").hostname.replace(/^www\./, "");
    if (host && host !== "safetoclone.com" && /^[a-z0-9.-]{1,60}$/.test(host)) return host;
  } catch {}
  return "";
}

export async function count(env, request, event, source = "") {
  if (!env?.INSTAGRAM || !EVENTS.includes(event)) return;
  if (BOT.test(request.headers.get("User-Agent") || "")) return;
  const key = `stats:${day()}`;
  const s = (await env.INSTAGRAM.get(key, "json")) || { events: {}, sources: {} };
  s.events[event] = (s.events[event] || 0) + 1;
  if (source && Object.keys(s.sources).length < 200) s.sources[source] = (s.sources[source] || 0) + 1;
  await env.INSTAGRAM.put(key, JSON.stringify(s), { expirationTtl: 400 * 86400 });
}

// The browser tells us about things that happen on the page. POST /api/hit {"event":"check"}
export async function hit(request, env) {
  if (request.method !== "POST") return new Response("Use POST", { status: 405 });
  const { event } = await request.json().catch(() => ({}));
  if (!["check", "copy_link", "image"].includes(event)) return new Response("Unknown event", { status: 400 });
  await count(env, request, event).catch(() => {});
  return new Response(null, { status: 204 });
}

// GET /api/stats: the last 30 days, newest first, plus totals.
export async function report(env) {
  const days = [];
  const total = { events: {}, sources: {} };
  for (let i = 0; i < 30; i++) {
    const d = day(new Date(Date.now() - i * 86400000));
    const s = env?.INSTAGRAM ? await env.INSTAGRAM.get(`stats:${d}`, "json") : null;
    if (!s) continue;
    days.push({ day: d, ...s });
    for (const part of ["events", "sources"]) for (const [k, v] of Object.entries(s[part])) total[part][k] = (total[part][k] || 0) + v;
  }
  return new Response(JSON.stringify({ note: "Rough counts, no personal data. Bots are left out.", total, days }, null, 2),
    { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
