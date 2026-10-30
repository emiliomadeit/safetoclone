import assert from "node:assert/strict";
import { sync } from "../scripts/sync-sandbox.mjs";

const SHA = "a".repeat(40), OLD = "b".repeat(40), NEXT = "c".repeat(40), TREE = "d".repeat(40);
const check = { id: 1, head_sha: SHA, status: "completed", conclusion: "success",
  name: "Workers Builds: safetoclone", app: { slug: "cloudflare-workers-and-pages" },
  details_url: "https://dash.cloudflare.com/account/workers/services/view/safetoclone/production/builds/build" };
function fake({ checks = [check], previous = null, mainMoved = false, conflict = false, setup = true } = {}) {
  const writes = []; let reads = 0;
  return { writes, api: async (method, path, body) => {
    if (method !== "GET") writes.push({ method, path, body });
    if (path === "git/ref/heads/main") return { object: { sha: (++reads > 1 && mainMoved) ? NEXT : SHA } };
    if (path.startsWith("commits/")) return { check_runs: checks };
    if (path.startsWith("git/matching-refs/")) return previous ? [{ ref: "refs/heads/sandbox-baseline", object: { sha: OLD } }] : [];
    if (path === `git/commits/${SHA}`) return { tree: { sha: TREE } };
    if (path === `git/trees/${TREE}`) return { tree: setup ? [{ path: "sandbox.js", type: "blob" }] : [] };
    if (path === `git/commits/${OLD}`) return previous;
    if (path === "git/commits") return { sha: NEXT };
    if (path.startsWith("git/refs")) { if (conflict) throw new Error("not a fast forward"); return {}; }
    throw new Error(`Unexpected ${method} ${path}`);
  } };
}
for (const checks of [[], [{ ...check, conclusion: "failure" }], [{ ...check, status: "in_progress" }],
  [{ ...check, app: { slug: "untrusted-app" } }], [{ ...check, head_sha: OLD }],
  [{ ...check, details_url: check.details_url.replace("/production/builds/", "/production/previews/branch/builds/") }],
  [check, { ...check, id: 2, status: "in_progress", conclusion: null }]]) {
  const f = fake({ checks }); assert.equal((await sync(f.api)).state, "waiting_for_production_build"); assert.deepEqual(f.writes, []);
}
const fresh = fake(); assert.equal((await sync(fresh.api)).state, "preview_build_requested");
const notMerged = fake({ setup: false }); assert.equal((await sync(notMerged.api)).state, "waiting_for_setup_merge"); assert.deepEqual(notMerged.writes, []);
assert.equal(fresh.writes[0].body.tree, TREE); assert.deepEqual(fresh.writes[0].body.parents, [SHA]);
assert.equal(fresh.writes[1].body.ref, "refs/heads/sandbox-baseline");
const previous = { tree: { sha: OLD }, message: "Sandbox baseline: previous\n" };
const update = fake({ previous }); await sync(update.api);
assert.deepEqual(update.writes[0].body.parents, [OLD]);
assert.deepEqual(update.writes[1], { method: "PATCH", path: "git/refs/heads/sandbox-baseline", body: { sha: NEXT, force: false } });
const moved = fake({ previous, mainMoved: true }); assert.equal((await sync(moved.api)).state, "main_moved_retry_later");
assert.equal(moved.writes.length, 1); // orphan commit is harmless; no ref moves
const foreign = fake({ previous: { ...previous, message: "Human feature work" } });
await assert.rejects(sync(foreign.api), /unrecognized/); assert.deepEqual(foreign.writes, []);
const current = fake({ previous: { tree: { sha: TREE }, message: `Sandbox baseline: current\n\nProduction-source: ${SHA}\n` } });
assert.equal((await sync(current.api)).state, "current"); assert.deepEqual(current.writes, []);
await assert.rejects(sync(fake({ previous, conflict: true }).api), /not a fast forward/);
await assert.rejects(sync(async () => { throw new Error("403"); }), /403/);
assert.ok([...fresh.writes, ...update.writes].every((w) => !w.path.includes("heads/main")));
console.log("Sandbox baseline sync tests passed");
