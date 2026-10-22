// Reads the Instagram post queue and pictures from the private HQ repo (emiliomadeit/safetoclone-hq),
// where Claude and Muse write posts. The website only runs the robot; the posts live in HQ.
//
// Setting in Cloudflare > Workers & Pages > safetoclone:
//   HQ_GITHUB_TOKEN  (Secret) a GitHub key that can only READ the HQ repo. Without it, the robot
//                    has no posts to read.
const HQ_REPO = "emiliomadeit/safetoclone-hq";
export const HQ_QUEUE = "instagram/posts.json";

// Get one file from HQ. Tries twice, because GitHub sometimes has a short hiccup.
export async function hqFile(env, path) {
  const url = `https://api.github.com/repos/${HQ_REPO}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
  const headers = {
    Authorization: `Bearer ${env.HQ_GITHUB_TOKEN}`,
    Accept: "application/vnd.github.raw",
    "User-Agent": "safetoclone-worker",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  let last;
  for (let i = 0; i < 2; i++) {
    const r = await fetch(url, { headers });
    if (r.ok) return r;
    last = new Error(`HQ ${path}: GitHub said ${r.status}`);
    if (r.status === 404 || r.status === 401 || r.status === 403) break; // no point retrying
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw last;
}

export async function hqQueue(env) {
  return (await hqFile(env, HQ_QUEUE)).json();
}
