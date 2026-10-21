// Checks the daily Instagram poster without touching the real Instagram. Run with: node test/instagram.test.mjs
import { autopost, status } from "../instagram.js";
import assert from "node:assert";

// A fake Instagram API that remembers what it was asked.
function fakeInstagram({ existingCaptions = [] } = {}) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const params = Object.fromEntries(opts.body ? new URLSearchParams(opts.body) : u.searchParams);
    calls.push({ path: u.pathname, method: opts.method || "GET", params });
    const reply = (x) => new Response(JSON.stringify(x));
    if (u.pathname.endsWith("/refresh_access_token")) return reply({ access_token: "new-token", expires_in: 5184000 });
    if (u.pathname.endsWith("/me")) return reply({ user_id: "123", username: "safetoclone" });
    if (u.pathname.endsWith("/123/media") && opts.method === "POST") return reply({ id: "c1" });
    if (u.pathname.endsWith("/123/media")) return reply({ data: existingCaptions.map((caption) => ({ caption })) });
    if (u.pathname.endsWith("/c1")) return reply({ status_code: "FINISHED" });
    if (u.pathname.endsWith("/123/media_publish")) return reply({ id: "p1" });
    return new Response(JSON.stringify({ error: { message: "unexpected " + u.pathname } }), { status: 400 });
  };
  return calls;
}
function fakeKV(start = {}) {
  const store = { ...start };
  return { store, async get(k, type) { const v = store[k]; return v && type === "json" ? JSON.parse(v) : v ?? null; }, async put(k, v) { store[k] = v; } };
}
const post = { id: "p", due_today: true, image_url: "https://safetoclone.com/instagram/x.jpg", caption: "Hello world caption", alt_text: "alt" };

// No token yet: does nothing and says why.
assert.equal((await autopost({}, post)).ok, false);

// First run: renews the token into KV, then posts.
let calls = fakeInstagram();
let kv = fakeKV();
let r = await autopost({ INSTAGRAM_TOKEN: "old-token", INSTAGRAM: kv }, post);
assert.deepEqual([r.posted, r.instagramId], ["p", "p1"]);
assert.equal(JSON.parse(kv.store.token).token, "new-token");
assert.ok(calls.some((c) => c.path.endsWith("/123/media_publish") && c.params.creation_id === "c1" && c.params.access_token === "new-token"));
assert.ok(calls.some((c) => c.params.caption === post.caption && c.params.image_url === post.image_url));

// Fresh token in KV: no renewal.
calls = fakeInstagram();
kv = fakeKV({ token: JSON.stringify({ token: "kv-token", savedAt: new Date().toISOString() }) });
await autopost({ INSTAGRAM_TOKEN: "old-token", INSTAGRAM: kv }, post);
assert.ok(!calls.some((c) => c.path.endsWith("/refresh_access_token")));
assert.ok(calls.every((c) => c.params.access_token === "kv-token"));

// Already posted today: no second post.
calls = fakeInstagram({ existingCaptions: [post.caption] });
r = await autopost({ INSTAGRAM_TOKEN: "t" }, post);
assert.match(r.reason, /already posted/);
assert.ok(!calls.some((c) => c.path.endsWith("/media_publish")));

// Nothing due today: no post.
calls = fakeInstagram();
r = await autopost({ INSTAGRAM_TOKEN: "t" }, { ...post, due_today: false });
assert.ok(!calls.some((c) => c.method === "POST"));

// Status never leaks the token.
fakeInstagram();
const s = await status({ INSTAGRAM_TOKEN: "secret-token" });
assert.equal(s.connectedAs, "@safetoclone");
assert.ok(!JSON.stringify(s).includes("secret-token"));

console.log("Instagram tests passed");
