// Checks the daily Instagram poster without touching the real Instagram. Run with: node test/instagram.test.mjs
import { autopost, status, listing, metrics } from "../instagram.js";
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
    if (u.pathname.endsWith("/123/media") && opts.method === "POST") return reply({ id: "c" + calls.filter((c) => c.path.endsWith("/123/media") && c.method === "POST").length });
    if (u.pathname.endsWith("/123/media")) return reply({ data: existingCaptions.map((caption) => ({ caption })) });
    if (/\/c\d+$/.test(u.pathname)) return reply({ status_code: "FINISHED" });
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

// Carousel: one container per slide, then one that holds them all, then publish that one.
calls = fakeInstagram();
const slides = ["a", "b", "c"].map((x) => `https://safetoclone.com/instagram/${x}.jpg`);
r = await autopost({ INSTAGRAM_TOKEN: "t" }, { ...post, image_url: slides[0], image_urls: slides, alt_texts: ["A", "B", "C"] });
const made = calls.filter((c) => c.path.endsWith("/123/media") && c.method === "POST").map((c) => c.params);
assert.deepEqual(made.slice(0, 3).map((p) => [p.image_url, p.is_carousel_item, p.alt_text, p.caption]),
  slides.map((s, i) => [s, "true", "ABC"[i], undefined]));
assert.deepEqual([made[3].media_type, made[3].children, made[3].caption], ["CAROUSEL", "c1,c2,c3", post.caption]);
assert.ok(calls.some((c) => c.path.endsWith("/media_publish") && c.params.creation_id === "c4"));
assert.equal(r.posted, "p");

// Too many slides: refuses before posting anything.
calls = fakeInstagram();
await assert.rejects(autopost({ INSTAGRAM_TOKEN: "t" }, { ...post, image_urls: Array(11).fill(slides[0]) }), /at most 10/);
assert.ok(!calls.some((c) => c.method === "POST"));

// Status never leaks the token.
fakeInstagram();
const s = await status({ INSTAGRAM_TOKEN: "secret-token" });
assert.equal(s.connectedAs, "@safetoclone");
assert.ok(!JSON.stringify(s).includes("secret-token"));

// Renewal remembers when the key runs out, so the daily check can warn a week before.
fakeInstagram();
kv = fakeKV();
await autopost({ INSTAGRAM_TOKEN: "old-token", INSTAGRAM: kv }, post);
const saved = JSON.parse(kv.store.token);
assert.ok(Date.parse(saved.expiresAt) > Date.now() + 59 * 864e5);
assert.ok(saved.from && !saved.from.includes("old-token"));

// A new Secret pasted in Cloudflare (for example a key with more permissions) replaces the renewed copy.
calls = fakeInstagram();
kv = fakeKV({ token: JSON.stringify({ ...saved, token: "kv-copy", savedAt: new Date().toISOString() }) });
await autopost({ INSTAGRAM_TOKEN: "brand-new-secret", INSTAGRAM: kv }, post);
assert.ok(calls.some((c) => c.path.endsWith("/refresh_access_token") && c.params.access_token === "brand-new-secret"));
assert.ok(!calls.some((c) => c.params.access_token === "kv-copy"));
assert.notEqual(JSON.parse(kv.store.token).from, saved.from); // the renewed copy now comes from the new Secret
// The same Secret as before keeps using the renewed copy.
calls = fakeInstagram();
kv = fakeKV({ token: JSON.stringify({ ...saved, token: "renewed", savedAt: new Date().toISOString() }) });
await autopost({ INSTAGRAM_TOKEN: "old-token", INSTAGRAM: kv }, post);
assert.ok(calls.filter((c) => c.path.endsWith("/media")).every((c) => c.params.access_token === "renewed"));
// Copies saved before this check existed are kept, and stamped once.
fakeInstagram();
kv = fakeKV({ token: JSON.stringify({ token: "older-copy", savedAt: new Date().toISOString() }) });
assert.equal((await status({ INSTAGRAM_TOKEN: "old-token", INSTAGRAM: kv })).tokenSource, "renewed copy");
assert.equal(JSON.parse(kv.store.token).from, saved.from);

// Results: the post list and the numbers. A number Instagram refuses is left out with the reason, never 0.
globalThis.fetch = async (url) => {
  const u = new URL(url);
  const reply = (x, status = 200) => new Response(JSON.stringify(x), { status });
  if (u.pathname.endsWith("/me")) return reply({ user_id: "123", username: "safetoclone", followers_count: 42, media_count: 3 });
  if (u.pathname.endsWith("/123/media")) return reply({ data: [
    { id: "111", caption: "x".repeat(200), timestamp: "2026-11-10T15:00:05+0000", media_type: "CAROUSEL_ALBUM", media_product_type: "FEED" },
    { id: "222", caption: "Reel", timestamp: "2026-11-10T20:00:05+0000", media_type: "VIDEO", media_product_type: "REELS" },
  ] });
  if (u.pathname.endsWith("/insights")) {
    const asked = u.searchParams.get("metric").split(",");
    if (asked.includes("follows")) return reply({ error: { message: "(#100) follows is not supported" } }, 400);
    return reply({ data: asked.map((name, i) => ({ name, values: [{ value: 10 + i }] })) });
  }
  return reply({ error: { message: "unexpected" } }, 400);
};
const env = { INSTAGRAM_TOKEN: "t" };
const l = await listing(env);
assert.deepEqual(l.account, { username: "@safetoclone", followers: 42, posts: 3 });
assert.equal(l.media[0].caption_start.length, 120);
assert.equal(l.media[1].product, "REELS");
const m = (await metrics(env, ["111", "222", "999"])).metrics;
assert.equal(m["111"].reach, 10);
assert.equal(m["111"].follows, undefined);
assert.match(m["111"].errors.follows, /not supported/);
assert.ok("views" in m["111"] && "profile_visits" in m["111"]);
assert.ok("ig_reels_avg_watch_time" in m["222"] && !("ig_reels_avg_watch_time" in m["111"]));
assert.ok(m["999"].errors.all, "only our own posts");
// No permission for results: one clear reason, no retries.
let insightCalls = 0;
const before = globalThis.fetch;
globalThis.fetch = async (url, o) => {
  if (new URL(url).pathname.endsWith("/insights")) { insightCalls++; return new Response(JSON.stringify({ error: { message: "(#10) Application does not have permission for this action" } }), { status: 400 }); }
  return before(url, o);
};
const denied = (await metrics(env, ["111"])).metrics["111"];
assert.match(denied.errors.all, /permission/);
assert.equal(insightCalls, 1);

console.log("Instagram tests passed");
