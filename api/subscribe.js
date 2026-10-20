// Vercel serverless function: adds an email to the newsletter list in Resend.
// Needs two settings in Vercel > Project > Settings > Environment Variables:
//   RESEND_API_KEY      (from resend.com > API Keys)
//   RESEND_AUDIENCE_ID  (from resend.com > Audiences)
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "That email address doesn't look right." });
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_AUDIENCE_ID) return res.status(503).json({ error: "Newsletter isn't connected yet." });
  const r = await fetch(`https://api.resend.com/audiences/${process.env.RESEND_AUDIENCE_ID}/contacts`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ email, unsubscribed: false }),
  });
  if (!r.ok) return res.status(502).json({ error: "Couldn't save your email. Try again later." });
  return res.status(200).json({ ok: true });
}
