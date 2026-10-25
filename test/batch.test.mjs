// Checks the Instagram approval lock (batch.js). Run with: node test/batch.test.mjs
import { fingerprint, checkBatch, postProblem, readDailyCheck, latestCheck, dueNow, mondayOf, addDays, timeIn } from "../batch.js";
import assert from "node:assert";

// 1. The fingerprint must equal the one HQ's Python tools make (instagram/_tools/common.py), or no approved
// week could ever post. This batch and its fingerprint were made with the Python code on 2026-10-24.
// It has posts out of order, a missing channel and time, quotes, backslashes, tabs, accents, emoji and a control character.
const PY_BATCH = JSON.parse(String.raw`{"posts": [{"n": 2, "id": "b", "date": "2026-11-10", "images": ["instagram/images/2026-11-09/b/1.jpg"], "image_hashes": ["ab"], "alts": ["Café “quotes” \\\\ and /slash/"], "caption": "Line one\nLine two\ttab \"quoted\" é ü 中文 🙂 \u0007"}, {"n": 1, "id": "a", "channel": "instagram", "date": "2026-11-09", "time": "13:00", "images": ["x/1.jpg", "x/2.jpg"], "image_hashes": ["h1", "h2"], "alts": ["one", "two"], "caption": "Plain"}]}`);
const PY_FINGERPRINT = "b7653d94954c02788f0b6b43ee8f0c02c94d44a2d8b5101b674a0c9cf07293b7";
assert.equal(await fingerprint(PY_BATCH), PY_FINGERPRINT);

// Holds, drops, status and pauses are not part of it (they can only stop posts)...
const stopped = structuredClone(PY_BATCH);
stopped.status = "approved";
stopped.posts[0].hold = true;
stopped.pause = { paused: true };
assert.equal(await fingerprint(stopped), PY_FINGERPRINT);
// ...but every word and picture people see is.
for (const change of [(b) => { b.posts[1].caption += "!"; }, (b) => { b.posts[0].image_hashes[0] = "cd"; }, (b) => { b.posts[1].time = "18:00"; }, (b) => { b.posts[0].alts[0] = "x"; }]) {
  const b = structuredClone(PY_BATCH);
  change(b);
  assert.notEqual(await fingerprint(b), PY_FINGERPRINT);
}

// 2. The week check.
const approved = async (extra = {}) => {
  const b = { week: "2026-11-09", status: "approved", posts: structuredClone(PY_BATCH.posts), ...extra };
  const fp = await fingerprint(b);
  b.review = { verdict: "pass", hash: fp };
  b.approval = { by: "Emile", at: "2026-11-07T14:00:00Z", how: "card", evidence: "cmsg_123", hash: fp, dropped: [], ...(extra.approval || {}) };
  return b;
};
assert.equal((await checkBatch(await approved())).ok, true);
assert.equal((await checkBatch(null)).ok, false);
assert.match((await checkBatch({ ...(await approved()), status: "ready" })).reason, /not approved/);
let b = await approved({ approval: { evidence: "" } });
assert.match((await checkBatch(b)).reason, /Emile's tap/);
b = await approved({ approval: { by: "Claude" } });
assert.equal((await checkBatch(b)).ok, false);
b = await approved();
b.review.verdict = "fail";
assert.match((await checkBatch(b)).reason, /review/);
b = await approved();
b.posts[0].caption = "Edited after approval";
let c = await checkBatch(b);
assert.deepEqual([c.ok, c.changed], [false, true]);
b = await approved();
b.pause = { paused: true, reason: "Emile said stop" };
c = await checkBatch(b);
assert.deepEqual([c.ok, c.paused, c.reason], [false, true, "paused: Emile said stop"]);

// 3. One post.
b = await approved({ approval: { dropped: [2] } });
const [p2, p1] = b.posts;
assert.equal(postProblem(b, p1), "");
assert.equal(postProblem(b, p2), "dropped by Emile");
assert.match(postProblem(b, { ...p1, hold: true, hold_reason: "grade changed" }), /on hold: grade changed/);
assert.equal(postProblem(b, { ...p1, channel: "x" }), "not an Instagram post");
assert.match(postProblem(b, { ...p1, image_hashes: ["h1"] }), /fingerprint/);
assert.match(postProblem(b, { ...p1, images: Array(11).fill("x.jpg"), image_hashes: Array(11).fill("h") }), /1 to 10/);

// 4. The daily check: "pass" and less than 36 hours old.
const now = Date.parse("2026-11-10T15:00:00Z");
assert.deepEqual(readDailyCheck("pass\nchecked_at: 2026-11-10T13:31:00Z\nAll fine"), { pass: true, at: Date.parse("2026-11-10T13:31:00Z") });
assert.equal(readDailyCheck("fail: directory is old\nchecked_at: 2026-11-10T13:31:00Z").pass, false);
assert.equal(readDailyCheck("pass").at, null);
assert.equal(latestCheck(["pass\nchecked_at: 2026-11-10T13:31:00Z"], now).ok, true);
assert.equal(latestCheck(["pass\nchecked_at: 2026-11-09T04:00:00Z"], now).ok, true); // 35 hours: still fine
assert.equal(latestCheck(["pass\nchecked_at: 2026-11-09T02:00:00Z"], now).ok, false); // 37 hours: too old
assert.equal(latestCheck(["fail: x\nchecked_at: 2026-11-10T13:31:00Z", "pass\nchecked_at: 2026-11-09T13:31:00Z"], now).ok, true); // last pass still counts
assert.equal(latestCheck(["pass\nchecked_at: 2026-11-12T13:31:00Z"], now).ok, false); // from the future: ignored
assert.equal(latestCheck([], now).ok, false);

// 5. Posting slots: from the post's time until 3 hours after (Ottawa time; Nov 10 is after the clocks change).
const at = (iso) => new Date(iso);
const post = { date: "2026-11-10", time: "10:00" };
assert.equal(timeIn(at("2026-11-10T15:05:00Z")), "10:05");
assert.equal(dueNow(post, at("2026-11-10T14:59:00Z")), false); // 09:59
assert.equal(dueNow(post, at("2026-11-10T15:00:00Z")), true); // 10:00
assert.equal(dueNow(post, at("2026-11-10T18:00:00Z")), true); // 13:00
assert.equal(dueNow(post, at("2026-11-10T18:31:00Z")), false); // 13:31: missed, never posts late
assert.equal(dueNow({ date: "2026-11-10" }, at("2026-11-10T15:30:00Z")), true); // no time means 10:00
assert.equal(dueNow(post, at("2026-11-11T15:05:00Z")), false); // another day

// 6. Week dates.
assert.equal(mondayOf("2026-11-15"), "2026-11-09");
assert.equal(mondayOf("2026-11-09"), "2026-11-09");
assert.equal(addDays("2026-10-31", 2), "2026-11-02");

console.log("batch tests passed");
