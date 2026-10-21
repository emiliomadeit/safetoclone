// Pages for Google: one page per graded repo (/repo/owner/name), a list of all of them (/repos),
// and the sitemap Google reads to find them all (/sitemap.xml).
// The worker builds them from data/directory.json, so every nightly update refreshes them by itself.
// Everything here is plain functions (data in, HTML out) so the tests can check them.

export const SITE = "https://safetoclone.com";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// JSON inside a <script> tag: "<" is escaped so text can never close the tag early.
const ld = (obj) => `<script type="application/ld+json">${JSON.stringify(obj).replace(/</g, "\\u003c")}</script>`;
const day = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? "" : d.toLocaleDateString("en-CA", { dateStyle: "medium", timeZone: "UTC" });
};
const isoDay = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
};
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");

// Older directory files have no level, so work one out from the grade and flags (same rule as index.html).
export const levelOf = (x) => x.level || ({ A: "trusted", B: "fine", C: "careful" }[x.grade] ?? (x.flags?.length ? "dangerous" : "unproven"));
export const repoPath = (name) => `/repo/${name}`;

// Finds a repo in the directory, ignoring upper/lower case.
export const findRepo = (dir, name) => (dir?.repos || []).find((r) => r.name.toLowerCase() === String(name).toLowerCase());

// What each label means for the visitor, in plain words.
const ADVICE = {
  trusted: "It's a well-known project with lots of users, regular updates and no malware tricks we could find. That lowers the risk a lot, but no check is a guarantee. Download it from the official GitHub page, not from a copy or a video link.",
  fine: "We found no malware tricks, but it misses some of the signs of a well-run project. Read the warnings above, and download it only from the official GitHub page.",
  careful: "Something is missing or slightly off. It may be fine, but ask someone technical before you install it, and never on a work computer without your IT team's OK.",
  unproven: "Nothing looks wrong, but the project is too new or too little-known to trust yet. Only install it if you know who made it.",
  dangerous: "We found signs that are common in malware, like requests to turn off your antivirus or locked zip files. Don't download it. If you already did, run a virus scan and change your passwords.",
};

const CSS = `
:root{--paper:#eef1ef;--card:#fff;--ink:#15201c;--muted:#56645e;--line:#d3dad6;--accent:#1d6b4c;--accent-ink:#fff;--good:#1d7a4f;--warn:#a86a00;--bad:#b3261e;--warn-bg:#fbf0d9;--bad-bg:#fbe4e1;
--display:"Archivo","Arial Narrow",system-ui,sans-serif;--body:"Public Sans",system-ui,-apple-system,"Segoe UI",sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#111a17;--card:#18231f;--ink:#e6ede9;--muted:#9aaaa3;--line:#2b3a34;--accent:#4fc08d;--accent-ink:#0c1512;--good:#5ccf96;--warn:#f0b44c;--bad:#ff7b6e;--warn-bg:#332712;--bad-bg:#3a1a17;color-scheme:dark}}
:root[data-theme="dark"]{--paper:#111a17;--card:#18231f;--ink:#e6ede9;--muted:#9aaaa3;--line:#2b3a34;--accent:#4fc08d;--accent-ink:#0c1512;--good:#5ccf96;--warn:#f0b44c;--bad:#ff7b6e;--warn-bg:#332712;--bad-bg:#3a1a17;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:400 1rem/1.6 var(--body)}
.wrap{max-width:52rem;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
a{color:var(--accent)}h1,h2,h3{font-family:var(--display);font-stretch:112%;line-height:1.15;text-wrap:balance;margin:0}
h1{font-size:clamp(1.8rem,5vw,2.8rem);font-weight:800;word-break:break-word}h2{font-size:1.35rem;font-weight:800}h3{font-size:1rem;font-weight:600}p{margin:0}
.muted{color:var(--muted)}.label{font:500 .72rem/1 var(--mono);letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
header.top{border-bottom:1px solid var(--line)}header.top .wrap{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding-block:.9rem;flex-wrap:wrap}
.brand{display:flex;align-items:center;gap:.6rem;text-decoration:none;color:var(--ink);font:800 1.15rem/1 var(--display);font-stretch:112%}
.brand-mark{width:1.9rem;height:1.9rem;border:2.5px solid var(--accent);border-radius:50%;display:grid;place-items:center;color:var(--accent);font-size:.9rem;transform:rotate(-12deg)}
nav{display:flex;gap:1.1rem;flex-wrap:wrap}nav a{color:var(--muted);text-decoration:none;font-weight:500;font-size:.95rem}nav a:hover{color:var(--ink)}
main{padding-block:2rem 3rem;display:grid;gap:2rem}.crumbs{font-size:.85rem;color:var(--muted)}.crumbs a{color:var(--muted)}
.answer{font-size:1.15rem}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:clamp(1rem,3vw,1.6rem);display:grid;gap:1.2rem}
.head{display:grid;grid-template-columns:auto 1fr;gap:1.4rem;align-items:center}.head .meta{display:grid;gap:.35rem;min-width:0}
.stamp{width:7rem;height:7rem;border-radius:50%;border:5px double currentColor;display:grid;place-items:center;transform:rotate(-8deg);text-align:center;line-height:1}
.stamp b{display:block;font:800 3.2rem/1 var(--display);font-stretch:112%}.stamp span{font:500 .75rem var(--mono)}
.lvl-trusted,.lvl-fine{color:var(--good)}.lvl-careful,.lvl-unproven{color:var(--warn)}.lvl-dangerous{color:var(--bad)}
.verdict{font:800 1.25rem/1.2 var(--display);font-stretch:112%}.mono{font-family:var(--mono);word-break:break-all}
.flags{display:grid;gap:.6rem}.flag{padding:.8rem 1rem;border-radius:8px;display:grid;gap:.2rem;background:var(--paper)}
.flag.high{background:var(--bad-bg)}.flag.high strong{color:var(--bad)}.flag.medium{background:var(--warn-bg)}.flag.medium strong{color:var(--warn)}
.groups{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1rem}.group{border-top:3px solid var(--line);padding-top:.7rem;display:grid;gap:.45rem;align-content:start}
.group header{display:flex;justify-content:space-between;align-items:baseline}.pts{font:500 .85rem var(--mono)}
.row{display:grid;grid-template-columns:.6rem 1fr;gap:.6rem;font-size:.92rem}.dot{width:.6rem;height:.6rem;border-radius:50%;margin-top:.45rem}
.dot.good{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}
.btns{display:flex;gap:.6rem;flex-wrap:wrap}.btn{font:600 1rem var(--body);padding:.8rem 1.2rem;border-radius:10px;border:2px solid var(--accent);background:var(--accent);color:var(--accent-ink);text-decoration:none;display:inline-block}
.btn.ghost{background:transparent;color:var(--accent)}section{display:grid;gap:.8rem}
.list{display:grid;gap:.5rem;margin:0;padding:0;list-style:none}.list li{display:grid;grid-template-columns:2.2rem 1fr;gap:.8rem;align-items:baseline;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.7rem .9rem}
.list .g{font:800 1.4rem/1 var(--display);text-align:center}.list a{font:500 .95rem var(--mono);word-break:break-all}.list p{font-size:.88rem;color:var(--muted)}
.note{font-size:.85rem;color:var(--muted)}footer{border-top:1px solid var(--line);padding-block:2rem 3rem;font-size:.85rem;color:var(--muted)}footer .wrap{display:grid;gap:.5rem}
@media (max-width:30rem){.head{grid-template-columns:1fr}.stamp{width:6rem;height:6rem}.stamp b{font-size:2.6rem}}`;

function layout({ title, description, canonical, image = "default", imageAlt = "SafeToClone safety grade from A to F", noindex = false, body, data = [] }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? `<meta name="robots" content="noindex">` : `<link rel="canonical" href="${esc(canonical)}">`}
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="SafeToClone">
<meta property="og:image" content="${SITE}/share/${esc(image)}.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(imageAlt)}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@112,600;112,800&family=Public+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&display=swap">
${data.map(ld).join("\n")}
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
  <a class="brand" href="/"><span class="brand-mark" aria-hidden="true">✓</span>SafeToClone</a>
  <nav aria-label="Main">
    <a href="/">Check a repo</a>
    <a href="/repos">All grades</a>
    <a href="/#method">How we score</a>
    <a href="/#newsletter">Newsletter</a>
  </nav>
</div></header>
<main class="wrap">
${body}
</main>
<footer><div class="wrap">
  <p>SafeToClone reads public GitHub data and gives an opinion. It is not antivirus software and can be wrong.</p>
  <p>Questions or a repo you want us to look at? Email <a href="mailto:hello@safetoclone.com">hello@safetoclone.com</a>.</p>
  <p>Not affiliated with GitHub.</p>
</div></footer>
</body>
</html>`;
}

const warningsOf = (r) => r.warnings || (r.flags || []).map((label) => ({ label: typeof label === "string" ? label : label.label, note: "", severity: "low" }));

// Same picture names as SHARE_IMAGES in worker.js.
const IMAGES = ["A-trusted", "B-fine", "C-careful", "D-unproven", "F-unproven", "A-dangerous", "B-dangerous", "C-dangerous", "D-dangerous", "F-dangerous"];

export function repoPage(r, dir) {
  const level = levelOf(r);
  const warnings = warningsOf(r);
  const url = SITE + repoPath(r.name);
  const checked = r.checkedAt || dir?.updatedAt;
  const warnText = warnings.length
    ? `${warnings.length} warning sign${warnings.length > 1 ? "s" : ""}: ${warnings.map((w) => w.label).join(", ")}.`
    : "No malware warning signs found.";
  const title = `Is ${r.name} safe to download? Grade ${r.grade} · SafeToClone`;
  const description = clip(`${r.name} gets ${/^[AEF]/.test(r.grade) ? "an" : "a"} ${r.grade} (${r.score}/100, ${r.label}) in our safety check. ${warnText} A plain-English report for people who don't code.`, 160);
  const image = IMAGES.includes(`${r.grade}-${level}`) ? `${r.grade}-${level}` : "default";

  const groups = {};
  for (const c of r.checks || []) (groups[c.group] ||= []).push(c);
  const checksHTML = Object.keys(groups).length ? `<section>
    <h2>What we checked</h2>
    <div class="groups">${Object.entries(groups).map(([g, list]) => {
      const got = list.reduce((s, c) => s + c.points, 0), max = list.reduce((s, c) => s + c.max, 0);
      return `<div class="group"><header><h3>${esc(g)}</h3><span class="pts">${got}/${max}</span></header>
      ${list.map((c) => `<div class="row"><span class="dot ${esc(c.level)}"></span><span><strong>${esc(c.label)}.</strong> ${esc(c.note)}</span></div>`).join("")}</div>`;
    }).join("")}</div>
    ${r.capReason ? `<p class="note">The score was capped because ${esc(r.capReason)}.</p>` : ""}
    ${r.aiFilesFound?.length ? `<p class="note">AI instruction files we read: ${r.aiFilesFound.map(esc).join(", ")}.</p>` : ""}
  </section>` : "";

  // The 8 repos after this one in the list (wrapping round), so every page links to a different set.
  const all = dir?.repos || [];
  const at = all.findIndex((x) => x.name === r.name);
  const others = all.length > 1 ? Array.from({ length: Math.min(8, all.length - 1) }, (_, i) => all[(at + 1 + i) % all.length]) : [];
  const othersHTML = others.length ? `<section>
    <h2>Other AI tools we graded</h2>
    <ul class="list">${others.map((x) => `<li><span class="g lvl-${levelOf(x)}">${esc(x.grade)}</span><div><a href="${repoPath(x.name)}">${esc(x.name)}</a></div></li>`).join("")}</ul>
    <p><a href="/repos">See all ${(dir?.repos || []).length} grades</a></p>
  </section>` : "";

  const body = `
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <a href="/repos">All grades</a> › <span class="mono">${esc(r.name)}</span></nav>
<section>
  <h1>Is ${esc(r.name)} safe to download?</h1>
  <p class="answer"><strong>${esc(r.name)} gets ${/^[AEF]/.test(r.grade) ? "an" : "a"} ${esc(r.grade)} (${esc(r.score)}/100) from SafeToClone: ${esc(r.label)}.</strong> ${esc(warnText)}</p>
</section>
<article class="card">
  <div class="head">
    <div class="stamp lvl-${level}" role="img" aria-label="Grade ${esc(r.grade)}, ${esc(r.score)} out of 100, ${esc(r.label)}"><div><b>${esc(r.grade)}</b><span>${esc(r.score)}/100</span></div></div>
    <div class="meta">
      <span class="label lvl-${level}">${esc(r.label)}</span>
      <p class="verdict">${esc(r.verdict)}</p>
      ${r.description ? `<p class="muted">${esc(r.description)}</p>` : ""}
      <p class="note">Official page: <a class="mono" href="${esc(r.url || `https://github.com/${r.name}`)}" rel="noopener">github.com/${esc(r.name)}</a>${checked ? ` · Checked ${esc(day(checked))}` : ""}</p>
    </div>
  </div>
  <div class="flags">
    <span class="label">Warning signs</span>
    ${warnings.length
      ? warnings.map((w) => `<div class="flag ${esc(w.severity)}"><strong>${esc(w.label)}</strong>${w.note ? `<span>${esc(w.note)}</span>` : ""}</div>`).join("")
      : `<div class="flag"><strong>None found</strong><span>We didn't find any of the common malware tricks.</span></div>`}
  </div>
</article>
<section>
  <h2>What this means for you</h2>
  <p>${esc(ADVICE[level] || ADVICE.careful)}</p>
  <div class="btns">
    <a class="btn" href="/?repo=${esc(r.name)}">Run the check again now</a>
    <a class="btn ghost" href="/#newsletter">Get the weekly safety email</a>
  </div>
  <p class="note">We re-check this repo every night. A grade is a set of warning signs, not a guarantee. <a href="/#method">How we score</a>.</p>
</section>
${checksHTML}
${othersHTML}`;

  const data = [
    {
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "SafeToClone", item: SITE + "/" },
        { "@type": "ListItem", position: 2, name: "All grades", item: SITE + "/repos" },
        { "@type": "ListItem", position: 3, name: r.name, item: url },
      ],
    },
    {
      "@context": "https://schema.org",
      "@type": "Review",
      name: `Safety check of ${r.name}`,
      author: { "@type": "Organization", name: "SafeToClone", url: SITE },
      publisher: { "@type": "Organization", name: "SafeToClone", url: SITE },
      ...(isoDay(checked) ? { datePublished: isoDay(checked) } : {}),
      reviewBody: `${r.verdict} ${warnText}`,
      reviewRating: { "@type": "Rating", ratingValue: r.score, bestRating: 100, worstRating: 0 },
      itemReviewed: {
        "@type": "SoftwareSourceCode",
        name: r.name,
        codeRepository: r.url || `https://github.com/${r.name}`,
        ...(r.description ? { description: r.description } : {}),
      },
    },
  ];
  return layout({ title, description, canonical: url, image, imageAlt: `SafeToClone grade ${r.grade}: ${r.label}`, body, data });
}

export function reposPage(dir) {
  const repos = dir?.repos || [];
  const title = `Which AI tools on GitHub are safe to download? ${repos.length} safety grades · SafeToClone`;
  const description = clip(`Safety grades from A to F for ${repos.length} popular AI tools on GitHub, like ${repos.slice(0, 3).map((r) => r.name.split("/")[1]).join(", ")}. Re-checked every night, explained in plain English.`, 160);
  const body = `
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a> › <span>All grades</span></nav>
<section>
  <h1>Which AI tools on GitHub are safe to download?</h1>
  <p class="answer">These are the AI tools people keep telling you to install. We grade each one from A to F every night, using only public information. Pick one to see its full report.</p>
  ${dir?.updatedAt ? `<p class="note">Last update ${esc(day(dir.updatedAt))}.</p>` : ""}
</section>
<ul class="list">${repos.map((x) => `<li><span class="g lvl-${levelOf(x)}" aria-label="Grade ${esc(x.grade)}">${esc(x.grade)}</span><div><a href="${repoPath(x.name)}">${esc(x.name)}</a> <span class="note">${esc(x.score)}/100 · ${esc(x.label || "")}</span>${x.description ? `<p>${esc(clip(x.description, 140))}</p>` : ""}</div></li>`).join("")}</ul>
<section>
  <h2>Don't see the tool you want?</h2>
  <p>Paste any GitHub link into the <a href="/">free checker</a> and get a grade in a few seconds. Or email <a href="mailto:hello@safetoclone.com">hello@safetoclone.com</a> and we'll add it to this list.</p>
</section>`;
  const data = [{
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Safety grades for popular AI tools on GitHub",
    itemListElement: repos.map((x, i) => ({ "@type": "ListItem", position: i + 1, url: SITE + repoPath(x.name), name: x.name })),
  }];
  return layout({ title, description, canonical: SITE + "/repos", body, data });
}

// For a repo we haven't graded: a friendly page that sends people to the live checker. Google is told not to list it.
export function missingPage(name) {
  const body = `
<section>
  <h1>We haven't graded ${esc(name)} yet</h1>
  <p class="answer">It's not in our nightly list, but you can check it right now for free.</p>
  <div class="btns"><a class="btn" href="/?repo=${esc(name)}">Check ${esc(name)} now</a><a class="btn ghost" href="/repos">See all grades</a></div>
</section>`;
  return layout({ title: `${name} safety check · SafeToClone`, description: `Check whether ${name} is safe to download.`, canonical: SITE + repoPath(name), noindex: true, body });
}

export function sitemap(dir) {
  const repos = dir?.repos || [];
  const updated = isoDay(dir?.updatedAt);
  const url = (loc, lastmod) => `  <url><loc>${esc(loc)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[url(SITE + "/", updated), url(SITE + "/repos", updated), ...repos.map((r) => url(SITE + repoPath(r.name), isoDay(r.checkedAt) || updated))].join("\n")}
</urlset>
`;
}
