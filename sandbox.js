// Preview-only boundary. Never pass production services or secrets into preview handlers.
const PRODUCTION_HOSTS = new Set([
  "safetoclone.com", "www.safetoclone.com", "safetoclone.emileantoun10.workers.dev",
]);
export const isSandbox = (request, env) => env.SAFETOCLONE_ENV === "sandbox" ||
  !PRODUCTION_HOSTS.has(new URL(request.url).hostname);

const escape = (value) => String(value).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

export async function sandboxFetch(request, env, ctx, fetchSite) {
  const url = new URL(request.url);
  // Allowlist, not a list of known secrets to remove: future bindings stay isolated too.
  const isolated = { ASSETS: env.ASSETS };
  let response;
  if (url.pathname === "/__sandbox/status") {
    response = json({ environment: "sandbox", version: env.SANDBOX_VERSION?.id || null,
      tag: env.SANDBOX_VERSION?.tag || null, production: "https://safetoclone.com",
      email: "disabled", instagram: "disabled", analytics: "disabled", privateHQ: "disconnected" });
  } else if (url.pathname === "/__sandbox" || url.pathname === "/__sandbox/") {
    response = new Response(hub(env.SANDBOX_VERSION), { headers: { "Content-Type": "text/html; charset=utf-8" } });
  } else if (url.pathname === "/robots.txt") {
    response = new Response("User-agent: *\nDisallow: /\n", { headers: { "Content-Type": "text/plain" } });
  } else if (url.pathname === "/api/subscribe") {
    response = json({ error: "Sandbox: signups are turned off. Nothing was sent or saved.", sandbox: true }, 409);
  } else if (url.pathname.startsWith("/api/instagram/") || url.pathname.startsWith("/api/newsletter/") ||
      url.pathname === "/api/stats" || url.pathname.startsWith("/ig-media/")) {
    response = json({ error: "This production service is disconnected in the sandbox.", sandbox: true }, 403);
  } else {
    response = await fetchSite(request, isolated, ctx);
  }
  const safe = new Response(response.body, response);
  safe.headers.set("X-SafeToClone-Environment", "sandbox");
  safe.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  safe.headers.set("Cache-Control", "no-store");
  return safe;
}

function hub(version) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>SafeToClone sandbox</title><link rel="stylesheet" href="/tokens.css">
<style>
*{box-sizing:border-box}body{margin:0;background:#f5f4f0;color:#17211c;font:16px/1.5 system-ui,sans-serif}
header,main{max-width:1600px;margin:auto;padding:24px}header{border-bottom:1px solid #c5cdc5}
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;font-weight:700;color:#365c44}
h1{font-size:clamp(28px,4vw,48px);letter-spacing:-.04em;line-height:1.1;margin:12px 0}
p{max-width:76ch}.links{display:flex;flex-wrap:wrap;gap:12px}a,button{color:#16492d;font:inherit;font-weight:600}
.links a,button{padding:10px 15px;border:1px solid #7c8d80;border-radius:6px;background:white;text-decoration:none;cursor:pointer}
a:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid #195dbe;outline-offset:3px}
.controls{display:flex;align-items:center;flex-wrap:wrap;gap:12px;margin-bottom:20px}select{font:inherit;padding:10px}
.panes{display:grid;grid-template-columns:1fr 1fr;gap:20px}.pane{min-width:0}.pane h2{font-size:18px;margin:0 0 10px}
iframe{width:100%;height:760px;background:white;border:1px solid #7c8d80;border-radius:8px}
.mobile iframe{max-width:390px}.note{font-size:14px;color:#435348}code{overflow-wrap:anywhere}
@media(max-width:800px){.panes{grid-template-columns:1fr}header,main{padding:18px}iframe{height:650px}}
</style></head><body><header><div class="eyebrow">SafeToClone / website sandbox</div>
<h1>See it before it goes live.</h1>
<p>Compare this preview with the production baseline. Preview emails, Instagram and visitor counts are disconnected. The checker still reads public repository data.</p>
<nav class="links" aria-label="Open websites"><a href="/" target="_blank" rel="noopener">Open this preview ↗</a>
<a href="https://safetoclone.com" target="_blank" rel="noopener">Open production ↗</a>
<a href="https://github.com/emiliomadeit/safetoclone/pulls" target="_blank" rel="noopener">Review changes ↗</a></nav>
<p class="note">Preview version: <code>${escape(version?.id || "local development")}</code>. The baseline is a snapshot and can lag behind production. The comparison below is read-only.</p></header>
<main><div class="controls"><label for="page">Compare page</label><select id="page"><option value="/">Home</option><option value="/repos">Repository directory</option></select>
<button id="size" type="button" aria-pressed="false">Use phone width</button><button id="reload" type="button">Reload both</button></div>
<div class="panes" id="panes"><section class="pane"><h2>Production baseline · isolated copy</h2>
<iframe id="baseline" title="Production baseline (read-only)" sandbox="allow-scripts allow-same-origin" inert tabindex="-1" referrerpolicy="no-referrer" src="https://sandbox-baseline-safetoclone.emileantoun10.workers.dev"></iframe></section>
<section class="pane"><h2>This preview · changes under review</h2><iframe id="preview" title="Sandbox website (read-only comparison)" sandbox="allow-scripts allow-same-origin" inert tabindex="-1" src="/"></iframe></section></div>
<p class="note">Use “Open this preview” to test forms and navigation. The comparison panes are non-interactive. This preview contains public website code, not private HQ content; its URL is public.</p></main>
<script>
const page=document.getElementById('page'), baseline=document.getElementById('baseline'), preview=document.getElementById('preview');
function reload(){baseline.src='https://sandbox-baseline-safetoclone.emileantoun10.workers.dev'+page.value;preview.src=page.value}
page.addEventListener('change',reload);document.getElementById('reload').addEventListener('click',reload);
document.getElementById('size').addEventListener('click',function(){const mobile=document.getElementById('panes').classList.toggle('mobile');this.setAttribute('aria-pressed',String(mobile));this.textContent=mobile?'Use desktop width':'Use phone width'});
</script></body></html>`;
}
