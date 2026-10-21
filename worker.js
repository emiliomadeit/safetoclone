// Cloudflare Worker: serves the website files, handles the newsletter signup,
// and runs /mcp, a read-only connector that lets Meta Muse (or any AI agent) fetch our Instagram posts.
// Needs one setting in Cloudflare > Workers & Pages > safetoclone > Settings > Variables and Secrets:
//   RESEND_API_KEY     (Secret, from resend.com > API keys, "Full access")
// Optional:
//   RESEND_SEGMENT_ID  (from resend.com > Audience > Segments) to also tag signups with a segment
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
    return env.ASSETS.fetch(request);
  },
};
