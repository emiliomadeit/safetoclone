// Cloudflare Pages version of the newsletter signup (api/subscribe.js is the Vercel version).
// Needs two settings in Cloudflare > Workers & Pages > safetoclone > Settings > Variables and Secrets:
//   RESEND_API_KEY      (from resend.com > API Keys)
//   RESEND_AUDIENCE_ID  (from resend.com > Audiences)
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost({ request, env }) {
  const { email: raw } = await request.json().catch(() => ({}));
  const email = String(raw || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ error: "That email address doesn't look right." }, 400);
  if (!env.RESEND_API_KEY || !env.RESEND_AUDIENCE_ID) return json({ error: "Newsletter isn't connected yet." }, 503);
  const r = await fetch(`https://api.resend.com/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, unsubscribed: false }),
  });
  if (!r.ok) return json({ error: "Couldn't save your email. Try again later." }, 502);
  return json({ ok: true });
}
