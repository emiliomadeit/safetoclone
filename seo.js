// Pages for Google: one page per graded repo (/repo/owner/name), a list of all of them (/repos),
// and the sitemap Google reads to find them all (/sitemap.xml).
// The worker builds them from data/directory.json, so every nightly update refreshes them by itself.
// Everything here is plain functions (data in, HTML out) so the tests can check them.

import { esc, levelOf, warningsOf, githubUrl, reportCard, toolCard } from "./report.js";

export const SITE = "https://safetoclone.com";
export { levelOf };
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

export const repoPath = (name) => `/repo/${name}`;

// Finds a repo in the directory, ignoring upper/lower case.
export const findRepo = (dir, name) => (dir?.repos || []).find((r) => r.name.toLowerCase() === String(name).toLowerCase());

// Same logo and tab icon as the home page.
const LOGO = `<svg class="logo" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="8"/><path d="M9 16.5l4.5 4.5L23 11.5" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231f8a5b'/%3E%3Cpath d='M9 16.5l4.5 4.5L23 11.5' fill='none' stroke='%23fff' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";

function layout({ title, description, canonical, image = "default", imageAlt = "SafeToClone safety grade from A to F", noindex = false, wide = false, body, data = [] }) {
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
<meta name="theme-color" content="#f1f4f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0e1513" media="(prefers-color-scheme: dark)">
<link rel="icon" href="${ICON}">
<link rel="preload" href="/fonts/archivo-expanded-800.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/site.css">
${data.map(ld).join("\n")}
</head>
<body>
<a class="skip" href="#main">Skip to the content</a>
<header class="topbar"><div class="wrap">
  <a class="brand" href="/">${LOGO}SafeToClone</a>
  <nav aria-label="Main">
    <a href="/">Check a repo</a>
    <a href="/repos">All grades</a>
    <a class="wide-only" href="/#method">How we score</a>
    <a class="wide-only" href="/#faq">Questions</a>
    <a href="/#newsletter">Newsletter</a>
  </nav>
</div></header>
<main id="main" class="wrap page${wide ? " wide" : ""}">
${body}
</main>
<footer><div class="wrap">
  <nav aria-label="More"><a href="/">Check a repo</a><a href="/repos">All safety grades</a><a href="/#method">How we score</a><a href="mailto:hello@safetoclone.com">hello@safetoclone.com</a></nav>
  <p>SafeToClone reads public GitHub data and gives an opinion. It is not antivirus software and can be wrong. Not affiliated with GitHub.</p>
</div></footer>
</body>
</html>`;
}

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

  // The 8 repos after this one in the list (wrapping round), so every page links to a different set.
  const all = dir?.repos || [];
  const at = all.findIndex((x) => x.name === r.name);
  const others = all.length > 1 ? Array.from({ length: Math.min(8, all.length - 1) }, (_, i) => all[(at + 1 + i) % all.length]) : [];
  const othersHTML = others.length ? `<section>
  <h2>Other AI tools we graded</h2>
  <ul class="tools">${others.map((x) => toolCard(x)).join("")}</ul>
  <p><a href="/repos">See all ${all.length} grades</a></p>
</section>` : "";

  const body = `
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">›</span><a href="/repos">All grades</a><span aria-hidden="true">›</span><span>${esc(r.name)}</span></nav>
<section>
  <h1>Is ${esc(r.name)} safe to download?</h1>
  <p class="answer"><strong>${esc(r.name)} gets ${/^[AEF]/.test(r.grade) ? "an" : "a"} ${esc(r.grade)} (${esc(r.score)}/100) from SafeToClone: ${esc(r.label)}.</strong> ${esc(warnText)}</p>
</section>
${reportCard(r, {
    actions: `<a class="btn secondary" href="/?repo=${esc(r.name)}">Run the check again now</a>`,
    footnote: `${checked ? `Checked ${esc(day(checked))}. ` : ""}We re-check this repo every night. A grade is a set of warning signs, not a guarantee.`,
  })}
${othersHTML}
<aside class="cta" aria-labelledby="cta-title">
  <h2 id="cta-title">Get the weekly safety email</h2>
  <p class="muted">One email a week: the AI tools worth installing, and the ones to avoid. Written for people who don't code.</p>
  <div class="btns"><a class="btn" href="/#newsletter">Subscribe for free</a><a class="btn secondary" href="/">Check another repo</a></div>
</aside>`;

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
        codeRepository: githubUrl(r),
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
<nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a><span aria-hidden="true">›</span><span>All grades</span></nav>
<section>
  <h1>Which AI tools on GitHub are safe to download?</h1>
  <p class="answer">These are the AI tools people keep telling you to install. We grade each one from A to F every night, using only public information. Pick one to see its full report.</p>
  ${dir?.updatedAt ? `<p class="fine">Last update ${esc(day(dir.updatedAt))}.</p>` : ""}
</section>
<ul class="tools">${repos.map((x) => toolCard(x, { headingLevel: 2 })).join("")}</ul>
<aside class="cta">
  <h2>Don't see the tool you want?</h2>
  <p>Paste any GitHub link into the <a href="/">free checker</a> and get a grade in a few seconds. Or email <a href="mailto:hello@safetoclone.com">hello@safetoclone.com</a> and we'll add it to this list.</p>
</aside>`;
  const data = [{
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: "Safety grades for popular AI tools on GitHub",
    itemListElement: repos.map((x, i) => ({ "@type": "ListItem", position: i + 1, url: SITE + repoPath(x.name), name: x.name })),
  }];
  return layout({ title, description, canonical: SITE + "/repos", wide: true, body, data });
}

// For a repo we haven't graded: a friendly page that sends people to the live checker. Google is told not to list it.
export function missingPage(name) {
  const body = `
<section>
  <h1>We haven't graded ${esc(name)} yet</h1>
  <p class="answer">It's not in our nightly list, but you can check it right now for free.</p>
</section>
<section>
  <div class="btns"><a class="btn" href="/?repo=${esc(name)}">Check ${esc(name)} now</a><a class="btn secondary" href="/repos">See all grades</a></div>
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
