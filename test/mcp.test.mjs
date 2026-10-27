// Checks the /mcp connector that Meta Muse uses. Run with: node test/mcp.test.mjs
import worker, { osvProxy } from "../worker.js";
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

// /api/osv only passes a clean list of parts on to OSV's batch lookup, nothing else.
{
  let forwarded;
  const fakeOsv = async (url, opts) => { forwarded = { url, body: JSON.parse(opts.body) }; return new Response('{"results":[{}]}'); };
  const post = (body) => new Request("https://safetoclone.com/api/osv", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });
  const res = await osvProxy(post({ queries: [{ package: { name: "lodash", ecosystem: "npm", purl: "x" }, version: "4.17.15", extra: 1 }] }), fakeOsv);
  assert.equal(res.status, 200);
  assert.equal(forwarded.url, "https://api.osv.dev/v1/querybatch");
  assert.deepStrictEqual(forwarded.body, { queries: [{ package: { name: "lodash", ecosystem: "npm" }, version: "4.17.15" }] });
  forwarded = null;
  assert.equal((await osvProxy(new Request("https://safetoclone.com/api/osv"), fakeOsv)).status, 405);
  assert.equal((await osvProxy(post("nope"), fakeOsv)).status, 400);
  assert.equal((await osvProxy(post({ queries: [] }), fakeOsv)).status, 400);
  assert.equal((await osvProxy(post({ queries: [{ package: { name: "a" }, version: "1" }] }), fakeOsv)).status, 400);
  assert.equal(forwarded, null, "bad requests are never sent on");
}

console.log("MCP tests passed");
