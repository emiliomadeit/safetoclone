// Draws a safety report and a directory card as HTML.
// Shared by the home page checker (index.html, runs in the visitor's browser) and the Google pages
// (seo.js, runs in the Worker), so a result looks and reads the same everywhere.
// Plain functions: data in, HTML text out. Every piece of text that comes from GitHub goes through esc().
import { GRADES, LEVELS, GROUPS, WHY, areaGrades } from "./score.js";

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Older directory files have no level, so work one out from the grade and flags.
export const levelOf = (x) => x.level || ({ A: "trusted", B: "fine", C: "careful" }[x.grade] ?? (x.flags?.length ? "dangerous" : "unproven"));

// Warning signs with their explanations. A live check has them in `flags`; the nightly directory keeps them
// in `warnings` (older directory files only have the names).
export const warningsOf = (r) => r.warnings || (r.flags || []).map((f) => (typeof f === "string" ? { label: f, note: "", severity: "low" } : f));

export const githubUrl = (r) => r.url || `https://github.com/${r.name}`;
const NEW_TAB = `<span class="sr-only"> (opens in a new tab)</span>`;
const an = (g) => (/^[AEF]/.test(g) ? "an" : "a");
const SEVERITY = { high: "Serious", medium: "Warning", low: "Good to know" };
const MARK = { good: "Good", warn: "So-so", bad: "Poor" };

// The round score dial: the ring fills up to the score, the grade is stamped in the middle.
export function ring(r, size = "lg") {
  const score = Math.max(0, Math.min(100, Math.round(Number(r.score) || 0)));
  return `<div class="ring ring-${size} lvl-${levelOf(r)}" role="img" aria-label="Grade ${esc(r.grade)}, ${score} out of 100${r.label ? `, ${esc(r.label)}` : ""}">`
    + `<svg viewBox="0 0 100 100" aria-hidden="true"><circle class="track" cx="50" cy="50" r="44"/><circle class="arc" cx="50" cy="50" r="44" pathLength="100" stroke-dasharray="${score} 100"/></svg>`
    + `<div class="stamp"><b>${esc(r.grade)}</b><small>${score}/100</small></div></div>`;
}

// "85 or more is an A", "70 to 84 is a B", "Under 40 is an F".
function gradeRule(grade) {
  const i = GRADES.findIndex(([g]) => g === grade);
  if (i < 0) return "";
  const [g, min] = GRADES[i];
  if (i === 0) return `${min} or more is ${an(g)} ${g}.`;
  if (min === 0) return `Under ${GRADES[i - 1][1]} is ${an(g)} ${g}.`;
  return `${min} to ${GRADES[i - 1][1] - 1} is ${an(g)} ${g}.`;
}

// "Talks to your AI": the files in this repo that give instructions to AI coding tools.
// Having them is normal. The point is that you know your AI will read them.
function aiHTML(r) {
  const found = r.aiFilesFound || [];
  if (!(r.checks || []).length) return "";
  const hijack = warningsOf(r).some((w) => /AI/.test(w.label));
  return `<section class="ai-files">
  <h3>Talks to your AI <span class="count">${found.length}</span></h3>
  <p class="muted">${found.length
    ? `This repo has ${found.length} file${found.length > 1 ? "s" : ""} that AI coding tools like Claude Code, Cursor and Copilot read as instructions when you open the folder: <span class="files">${found.map((f) => `<code>${esc(f)}</code>`).join(", ")}</span>. ${hijack ? "At least one of them tries to take over your AI. See Warning signs." : "We read them and found nothing that tries to take over your AI. It's still worth opening them yourself before you let an AI work in this folder."}`
    : "We found no files that give instructions to AI coding tools."}</p>
</section>`;
}

// r = a result from score.js, or an entry from data/directory.json.
// Options: example (a made-up repo: no links), actions (extra buttons, HTML), headingId, footnote (HTML).
export function reportCard(r, { example = false, actions = "", headingId = "", footnote = "" } = {}) {
  const level = levelOf(r);
  const L = LEVELS[level] || LEVELS.careful;
  const rank = { high: 0, medium: 1, low: 2 };
  const warnings = [...warningsOf(r)].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
  const gh = githubUrl(r);

  const title = example
    ? esc(r.name)
    : `<a href="${esc(gh)}" target="_blank" rel="noopener">${esc(r.name)}<span class="ext" aria-hidden="true">↗</span>${NEW_TAB}</a>`;
  const buttons = example ? "" : `<a class="btn" href="${esc(gh)}" target="_blank" rel="noopener">View on GitHub<span class="ext" aria-hidden="true">↗</span>${NEW_TAB}</a>${actions}`;

  const warningsHTML = warnings.length
    ? `<ul class="list">${warnings.map((w) => `<li class="sev-${esc(w.severity)}"><span class="icon" aria-hidden="true"></span><div><p class="list-title">${esc(w.label)} <span class="sev">${SEVERITY[w.severity] || ""}</span></p>${w.note ? `<p class="list-note">${esc(w.note)}</p>` : ""}</div></li>`).join("")}</ul>`
    : `<ul class="list"><li class="sev-none"><span class="icon" aria-hidden="true"></span><div><p class="list-title">None found</p><p class="list-note">We didn't find any of the common malware tricks.</p></div></li></ul>`;

  // "Why this grade": one row per question, each opens to show the checks and why they matter.
  const groups = {};
  for (const c of r.checks || []) (groups[c.group] ||= []).push(c);
  const areas = areaGrades(r.checks || []);
  let whyHTML = "";
  if (Object.keys(groups).length) {
    const got = (r.checks || []).reduce((s, c) => s + c.points, 0), most = (r.checks || []).reduce((s, c) => s + c.max, 0);
    const raw = most ? Math.round((100 * got) / most) : 0;
    const summary = r.capReason
      ? `Its checks add up to ${raw} out of 100, but the score is capped at ${esc(r.score)} because ${esc(r.capReason)}. ${gradeRule(r.grade)}`
      : `It scored ${esc(r.score)} out of 100. ${gradeRule(r.grade)}`;
    const labelNote = level === "dangerous"
      ? " It's labelled Dangerous because we found tricks that malware uses, and that label wins over the score."
      : level === "unproven" ? " It's labelled Unproven, not Dangerous, because we found no malware tricks." : "";
    whyHTML = `<section class="why">
  <h3>Why this grade?</h3>
  <p class="muted">${summary}${labelNote} Each area gets its own letter, and the overall grade can be at most one letter better than the weakest safety area ("Is it open about itself?" only costs points). Open a row to see what we checked.</p>
  <div class="groups">${Object.entries(groups).map(([g, list]) => {
      const got = list.reduce((s, c) => s + c.points, 0), max = list.reduce((s, c) => s + c.max, 0);
      const pct = max ? Math.round((got / max) * 100) : 0;
      const letter = areas[g]?.grade || "";
      const tone = { A: "good", B: "good", C: "warn", D: "warn" }[letter] || "bad";
      return `<details>
    <summary><span class="area-grade ${tone}"><span class="sr-only">Area grade </span>${esc(letter)}</span><span class="q">${esc(GROUPS[g] || g)}</span><span class="bar ${tone}" aria-hidden="true"><i style="width:${pct}%"></i></span><span class="pts"><span class="sr-only">, ${got} out of ${max} points</span><span aria-hidden="true">${got}/${max}</span></span></summary>
    <ul class="checks">${list.map((c) => `<li class="${esc(c.level)}"><span class="icon" aria-hidden="true"></span><div><p><span class="sr-only">${MARK[c.level] || ""}: </span><strong>${esc(c.label)}.</strong> ${esc(c.note)}</p>${WHY[c.label] || WHY[c.group] ? `<p class="list-note">${esc(WHY[c.label] || WHY[c.group])}</p>` : ""}</div></li>`).join("")}</ul>
  </details>`;
    }).join("")}</div>
  ${groups["Security habits"] ? "" : `<p class="fine">${esc(GROUPS["Security habits"])} Not checked: the independent OpenSSF Scorecard check has no data for this repo yet, so the grade uses the other areas.</p>`}
</section>`;
  }

  return `<article class="report lvl-${level}"${headingId ? ` aria-labelledby="${headingId}"` : ""}>
<header class="report-head">
  ${ring(r)}
  <div class="report-title">
    ${example ? `<p class="tag">Example · made-up repo</p>` : ""}
    <h2 class="repo-name"${headingId ? ` id="${headingId}" tabindex="-1"` : ""}>${title}</h2>
    <p><span class="pill lvl-${level}">${esc(r.label || L.label)}</span></p>
    <p class="verdict">${esc(r.verdict || L.verdict)}</p>
    ${r.description ? `<p class="muted desc">${esc(r.description)}</p>` : ""}
  </div>
</header>
${buttons ? `<div class="actions">${buttons}</div>` : ""}
<section class="advice lvl-${level}">
  <h3>What should I do?</h3>
  <p>${esc(L.advice)}</p>
</section>
<section>
  <h3>Warning signs <span class="count">${warnings.length}</span></h3>
  ${warningsHTML}
</section>
${aiHTML(r)}
${whyHTML}
<p class="fine">${footnote || `A grade is a set of warning signs, not a guarantee.`} <a href="/#method">How we score</a></p>
</article>`;
}

// One tool in a list: dial, name, label, short description, a link to its full report and one to GitHub.
// link = false for made-up example data (there is no report page to link to).
export function toolCard(x, { link = true, headingLevel = 3 } = {}) {
  const [owner, name] = String(x.name).split("/");
  const h = `h${headingLevel}`;
  const label = `<span class="owner">${esc(owner)}/</span><wbr>${esc(name)}`;
  const warnings = warningsOf(x);
  return `<li class="tool">
  ${ring(x, "sm")}
  <div class="tool-body">
    <${h} class="tool-name">${link ? `<a class="stretch" href="/repo/${esc(x.name)}">${label}</a>` : label}</${h}>
    <p class="tool-meta"><span class="pill lvl-${levelOf(x)}">${esc(x.label || LEVELS[levelOf(x)]?.label)}</span> ${warnings.length ? `<span class="muted">${warnings.length} warning sign${warnings.length > 1 ? "s" : ""}</span>` : `<span class="muted">No warning signs</span>`}</p>
    ${x.description ? `<p class="tool-desc">${esc(x.description)}</p>` : ""}
    <p class="tool-links">${link ? `<span class="more" aria-hidden="true">Full report</span>` : ""}<a class="gh" href="${esc(githubUrl(x))}" target="_blank" rel="noopener">GitHub<span class="ext" aria-hidden="true">↗</span><span class="sr-only"> page for ${esc(x.name)} (opens in a new tab)</span></a></p>
  </div>
</li>`;
}
