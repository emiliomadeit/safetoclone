// Cloudflare Worker: serves the website files and handles the newsletter signup.
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
    return env.ASSETS.fetch(request);
  },
};
