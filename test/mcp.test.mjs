// Checks the /mcp connector that Meta Muse uses. Run with: node test/mcp.test.mjs
import worker from "../worker.js";
import assert from "node:assert";
import { readFile } from "node:fs/promises";

// Pretend to be Cloudflare's file server: read files from this folder.
const env = {
  ASSETS: {
    async fetch(req) {
      const path = new URL(req.url).pathname;
      try { return new Response(await readFile(new URL(".." + path, import.meta.url))); }
      catch { return new Response("Not found", { status: 404 }); }
    },
  },
};
const call = (body, method = "POST") =>
  worker.fetch(new Request("https://safetoclone.com/mcp", { method, body: body && JSON.stringify(body), headers: { "Content-Type": "application/json" } }), env);

const init = await (await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
assert.equal(init.result.serverInfo.name, "safetoclone");
assert.ok(init.result.capabilities.tools);

assert.equal((await call({ jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
assert.equal((await call(null, "GET")).status, 405);

const list = await (await call({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
assert.deepEqual(list.result.tools.map((t) => t.name), ["get_next_post", "list_upcoming_posts", "get_safety_scores"]);

const scores = await (await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "get_safety_scores", arguments: {} } })).json();
assert.ok(JSON.parse(scores.result.content[0].text).repos.length > 0);

const next = await (await call({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "get_next_post", arguments: {} } })).json();
const post = JSON.parse(next.result.content[0].text);
assert.ok(post.caption || post.message, "get_next_post returns a post or says the queue is empty");
if (post.image_url) {
  assert.match(post.image_url, /^https:\/\/safetoclone\.com\/instagram\/.+\.jpg$/);
  assert.equal(post.image_urls[0], post.image_url);
}

const bad = await (await call({ jsonrpc: "2.0", id: 5, method: "nope" })).json();
assert.equal(bad.error.code, -32601);

// Every queued post must have its image files and a caption Instagram accepts
// (max 2200 characters, max 5 hashtags). A carousel has 2 to 10 images, each with alt text.
const queue = JSON.parse(await readFile(new URL("../data/instagram-posts.json", import.meta.url), "utf8"));
for (const p of queue.posts) {
  const images = p.images || [p.image];
  assert.ok(images.length >= 1 && images.length <= 10, `${p.id} needs 1 to 10 images`);
  if (p.images) assert.equal(p.alts?.length, p.images.length, `${p.id} needs one alt text per image`);
  for (const i of images) await readFile(new URL("../" + i, import.meta.url));
  assert.ok((p.caption.match(/#\w+/g) || []).length <= 5, `${p.id} has more than 5 hashtags`);
  assert.ok(p.caption.length <= 2200, `${p.id} caption is too long`);
  assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
}
console.log("MCP tests passed");
