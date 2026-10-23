// Posts to the @safetoclone Instagram account through Meta's official API ("Instagram API with Instagram Login").
// worker.js runs autopost() once a day (see "triggers" in wrangler.jsonc).
//
// Settings in Cloudflare > Workers & Pages > safetoclone:
//   INSTAGRAM_TOKEN  (Secret) the 60-day access token from the Meta app dashboard. Only needed once:
//                    after the first run the worker keeps its own renewed copy in the INSTAGRAM KV store.
//   INSTAGRAM        (KV namespace binding, set in wrangler.jsonc) where the renewed token is kept.
//                    Without it posting still works, but the token dies after 60 days.
const API = "https://graph.instagram.com/v23.0";
const RENEW_AFTER_DAYS = 7; // renew the token once a week, long before its 60 days run out

async function ig(path, { method = "GET", token, params = {} } = {}) {
  const url = new URL(path.startsWith("http") ? path : API + path);
  const body = new URLSearchParams({ ...params, access_token: token });
  const r = method === "GET"
    ? await fetch(url + (url.search ? "&" : "?") + body)
    : await fetch(url, { method, body });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.error) throw new Error(`Instagram ${path}: ${data.error?.message || r.status}`);
  return data;
}

// The token to use: the renewed one in KV if there is one, otherwise the Secret.
async function getToken(env) {
  const saved = env.INSTAGRAM ? await env.INSTAGRAM.get("token", "json") : null;
  if (saved?.token) return saved;
  return env.INSTAGRAM_TOKEN ? { token: env.INSTAGRAM_TOKEN, savedAt: null } : null;
}

async function renewIfOld(env, current) {
  if (!env.INSTAGRAM) return current; // nowhere to keep a new token
  const age = current.savedAt ? (Date.now() - Date.parse(current.savedAt)) / 864e5 : Infinity;
  if (age < RENEW_AFTER_DAYS) return current;
  let r;
  try {
    r = await ig("https://graph.instagram.com/refresh_access_token", {
      token: current.token,
      params: { grant_type: "ig_refresh_token" },
    });
  } catch (e) {
    // Meta refuses to renew a token less than 24 hours old. Keep using it and try again tomorrow.
    console.log("Token not renewed:", e.message);
    return current;
  }
  const fresh = { token: r.access_token, savedAt: new Date().toISOString() };
  await env.INSTAGRAM.put("token", JSON.stringify(fresh));
  return fresh;
}

// Make one media container and wait until Meta has downloaded its image(s). Returns its id.
async function makeContainer(token, userId, params) {
  const create = (p) => ig(`/${userId}/media`, { method: "POST", token, params: p });
  let container;
  try {
    container = await create(params);
  } catch (e) {
    if (!params.alt_text) throw e;
    // Older API versions reject alt_text. Try once more without it.
    const { alt_text, ...rest } = params;
    container = await create(rest);
  }
  // Meta downloads the image first. Wait until it's ready (usually a few seconds).
  for (let i = 0; i < 10; i++) {
    const { status_code } = await ig(`/${container.id}`, { token, params: { fields: "status_code" } });
    if (status_code === "FINISHED") return container.id;
    if (status_code === "ERROR" || status_code === "EXPIRED") throw new Error(`Meta couldn't use the image: ${status_code}`);
    await new Promise((r) => setTimeout(r, 3000));
  }
  return container.id;
}

// Publish one post: a single image, or a carousel (2 to 10 images people swipe through).
// Returns the new post's id.
async function publish(token, userId, post) {
  const urls = post.image_urls?.length ? post.image_urls : [post.image_url];
  const alts = post.alt_texts || [post.alt_text];
  let id;
  if (urls.length === 1) {
    id = await makeContainer(token, userId, { image_url: urls[0], caption: post.caption, alt_text: alts[0] || "" });
  } else {
    if (urls.length > 10) throw new Error(`A carousel can have at most 10 images, this one has ${urls.length}.`);
    // A carousel is made in two steps: one container per slide, then one container that holds them all.
    const children = [];
    for (let i = 0; i < urls.length; i++) {
      children.push(await makeContainer(token, userId, { image_url: urls[i], is_carousel_item: "true", alt_text: alts[i] || "" }));
    }
    id = await makeContainer(token, userId, { media_type: "CAROUSEL", children: children.join(","), caption: post.caption });
  }
  const done = await ig(`/${userId}/media_publish`, { method: "POST", token, params: { creation_id: id } });
  return done.id;
}

// Was this caption already posted recently? Stops double posts if the job runs twice in a day.
async function alreadyPosted(token, userId, caption) {
  const { data = [] } = await ig(`/${userId}/media`, { token, params: { fields: "caption", limit: "10" } });
  const start = caption.slice(0, 120);
  return data.some((m) => (m.caption || "").startsWith(start));
}

// Post whatever is due today. `post` comes from get_next_post in worker.js.
export async function autopost(env, post) {
  const current = await getToken(env);
  if (!current) return { ok: false, reason: "INSTAGRAM_TOKEN isn't set in Cloudflare yet." };
  const { token } = await renewIfOld(env, current);
  if (!(post?.due_now ?? post?.due_today)) return { ok: true, reason: "Nothing is due now." };
  const { user_id: userId } = await ig("/me", { token, params: { fields: "user_id" } });
  if (await alreadyPosted(token, userId, post.caption)) return { ok: true, reason: `${post.id} was already posted.` };
  const id = await publish(token, userId, post);
  if (env.INSTAGRAM) await env.INSTAGRAM.put("last", JSON.stringify({ post: post.id, instagramId: id, at: new Date().toISOString() }));
  return { ok: true, posted: post.id, instagramId: id };
}

// For /api/instagram/status: shows whether posting is set up. Never shows the token.
export async function status(env) {
  const current = await getToken(env);
  const out = {
    tokenSet: Boolean(current),
    tokenStore: env.INSTAGRAM ? "KV (renews itself)" : "Secret only (will expire after 60 days)",
    tokenSavedAt: current?.savedAt || null,
  };
  if (!current) return out;
  try {
    const me = await ig("/me", { token: current.token, params: { fields: "username" } });
    out.connectedAs = "@" + me.username;
  } catch (e) {
    out.error = e.message;
  }
  if (env.INSTAGRAM) out.lastPost = await env.INSTAGRAM.get("last", "json");
  return out;
}
