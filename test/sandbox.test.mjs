import assert from "node:assert/strict";
import worker from "../worker.js";
import { isSandbox } from "../sandbox.js";

let assetCalls = 0, services = 0;
const danger = new Proxy({}, { get() { services++; throw new Error("Production service accessed"); } });
const env = { ASSETS: { fetch: async () => { assetCalls++; return new Response("<html>same site</html>",
  { headers: { "Content-Type": "text/html" } }); } }, INSTAGRAM: danger,
  RESEND_API_KEY: "must-not-use", HQ_GITHUB_TOKEN: "must-not-use", INSTAGRAM_TOKEN: "must-not-use",
  UNKNOWN_FUTURE_SERVICE: danger, SAFETOCLONE_ENV: "sandbox" };
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { services++; throw new Error("Unexpected external call"); };
const jobs = [];
const ctx = { waitUntil: (p) => jobs.push(p) };
try {
  for (const host of ["localhost", "codex-website-sandbox-safetoclone.emileantoun10.workers.dev", "preview.example.com"]) {
    assert.equal(isSandbox(new Request(`https://${host}`), {}), true);
    const res = await worker.fetch(new Request(`https://${host}/`), { ...env, SAFETOCLONE_ENV: undefined }, ctx);
    assert.equal(res.headers.get("X-SafeToClone-Environment"), "sandbox");
    assert.match(await res.text(), /same site/);
  }
  for (const host of ["safetoclone.com", "www.safetoclone.com", "safetoclone.emileantoun10.workers.dev"]) {
    assert.equal(isSandbox(new Request(`https://${host}`), {}), false);
    assert.equal(isSandbox(new Request(`https://${host}`), env), true);
  }
  for (const path of ["/api/subscribe", "/api/instagram/status", "/api/instagram/results", "/api/newsletter/status", "/api/stats", "/ig-media/private.jpg", "/nl-media/newsletter/images/2026-11-01/a.gif"]) {
    const res = await worker.fetch(new Request(`https://preview.example.com${path}`, { method: "POST", body: '{"email":"test@example.com"}' }), env, ctx);
    assert.ok(res.status >= 400);
    assert.equal((await res.json()).sandbox, true);
    assert.match(res.headers.get("X-Robots-Tag"), /noindex/);
  }
  // Newsletter approve and rating links in a preview: no KV, no HQ, nothing approved or counted.
  for (const [path, method] of [[`/newsletter/approve?d=2026-11-01&v=00000000&t=${"a".repeat(64)}`, "POST"], ["/newsletter/rate/love", "GET"]]) {
    const res = await worker.fetch(new Request(`https://preview.example.com${path}`, { method }), env, ctx);
    assert.ok([200, 404].includes(res.status));
  }
  const hit = await worker.fetch(new Request("https://preview.example.com/api/hit", {
    method: "POST", body: '{"event":"check"}',
  }), env, ctx);
  assert.equal(hit.status, 204);
  await worker.scheduled({}, env, ctx);
  await Promise.all(jobs);
  assert.equal(services, 0, "No production bindings, secret-backed services or network calls");
  const robots = await worker.fetch(new Request("https://preview.example.com/robots.txt"), env, ctx);
  assert.match(await robots.text(), /Disallow: \//);
  const hub = await worker.fetch(new Request("https://preview.example.com/__sandbox"), {
    ...env, SANDBOX_VERSION: { id: '<script>alert("x")</script>' },
  }, ctx);
  const html = await hub.text();
  assert.ok(!html.includes('<script>alert("x")</script>'));
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes('src="https://sandbox-baseline-safetoclone.emileantoun10.workers.dev"'));
  assert.ok(!html.includes('src="https://safetoclone.com'), "Comparison must not load production analytics");
  const status = await worker.fetch(new Request("https://preview.example.com/__sandbox/status"), env, ctx);
  assert.equal((await status.json()).privateHQ, "disconnected");
  assert.ok(assetCalls > 0);
} finally { globalThis.fetch = originalFetch; }
console.log("Sandbox isolation tests passed");
