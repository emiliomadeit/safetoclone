// Draws the "Download image" share card: a 1200x630 PNG of one result, in the website's style.
// Runs only in the visitor's browser (it uses a <canvas>). Nothing is uploaded anywhere.

// Same colours as site.css.
const C = {
  bg: "#f1f4f2", card: "#ffffff", ink: "#15201c", muted: "#56645e", track: "#e1e8e4", brand: "#1f8a5b", link: "#1d6b4c",
  trusted: "#1d7a4f", fine: "#1d7a4f", careful: "#9a5800", unproven: "#9a5800", dangerous: "#b8261c",
  trustedBg: "#e2f2e8", fineBg: "#e2f2e8", carefulBg: "#fcefd9", unprovenBg: "#fcefd9", dangerousBg: "#fce5e2",
};
// The same fonts as the website: the device's own font for text (Apple's on Mac and iPhone),
// Archivo for the grade and headline, JetBrains Mono for small labels (both loaded by site.css from /fonts).
const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", Inter, Roboto, "Helvetica Neue", Arial, sans-serif';
const DISPLAY = `"Archivo Expanded", ${FONT}`;
const MONO = '"JetBrains Mono", ui-monospace, Menlo, Consolas, monospace';
export const W = 1200, H = 630;

// Splits text into lines that fit `width`. Cuts with "…" after `max` lines.
function wrap(ctx, text, width, max) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    const test = line ? line + " " + word : word;
    if (ctx.measureText(test).width <= width || !line) line = test;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  if (lines.length > max) {
    lines.length = max;
    let last = lines[max - 1];
    while (last && ctx.measureText(last + "…").width > width) last = last.slice(0, -1);
    lines[max - 1] = last.trimEnd() + "…";
  }
  return lines;
}

// Picks the biggest font size (down to `min`) at which the text fits on one line.
function fit(ctx, text, weight, size, min, width, family = FONT) {
  for (; size > min; size -= 1) {
    ctx.font = `${weight} ${size}px ${family}`;
    if (ctx.measureText(text).width <= width) return;
  }
  ctx.font = `${weight} ${min}px ${family}`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// The logo: a green rounded square with a white tick.
function logo(ctx, x, y, s) {
  roundRect(ctx, x, y, s, s, s / 4);
  ctx.fillStyle = C.brand; ctx.fill();
  ctx.strokeStyle = "#fff"; ctx.lineWidth = s / 10; ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(x + s * 0.28, y + s * 0.52); ctx.lineTo(x + s * 0.42, y + s * 0.66); ctx.lineTo(x + s * 0.72, y + s * 0.36);
  ctx.stroke();
}

// r = a result from score.js, link = the shareable link. Returns a PNG Blob.
export async function shareCard(r, link) {
  // Wait for the website's fonts, so the picture uses them. If they can't load, system fonts are used instead.
  try { await Promise.all([`800 40px ${DISPLAY}`, `500 20px ${MONO}`].map((f) => document.fonts.load(f))); } catch {}
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const color = C[r.level] || C.muted;
  const tint = C[r.level + "Bg"] || C.bg;

  ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
  roundRect(ctx, 32, 32, W - 64, H - 64, 36);
  ctx.fillStyle = C.card; ctx.fill();

  // The score dial: a grey ring filled in colour up to the score, a tinted middle,
  // and the grade stamped on at a slight angle, like on the website.
  const cx = 250, cy = 315, rad = 150;
  ctx.fillStyle = tint; ctx.beginPath(); ctx.arc(cx, cy, rad - 25, 0, Math.PI * 2); ctx.fill();
  ctx.lineWidth = 26; ctx.lineCap = "round";
  ctx.strokeStyle = C.track; ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2); ctx.stroke();
  const pct = Math.max(0, Math.min(100, r.score)) / 100;
  if (pct > 0) {
    ctx.strokeStyle = color; ctx.beginPath();
    ctx.arc(cx, cy, rad, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * pct); ctx.stroke();
  }
  ctx.save();
  ctx.translate(cx, cy); ctx.rotate(-8 * Math.PI / 180);
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = color;
  ctx.font = `800 140px ${DISPLAY}`; ctx.fillText(r.grade, 0, 40);
  ctx.font = `500 28px ${MONO}`; ctx.fillText(`${r.score}/100`, 0, 88);
  ctx.restore();

  const x = 480, width = W - x - 80;
  ctx.textAlign = "left";

  // Brand line
  logo(ctx, x, 78, 44);
  ctx.fillStyle = C.ink; ctx.font = `800 28px ${DISPLAY}`; ctx.fillText("SafeToClone", x + 58, 110);

  // Repo name, label and verdict
  let y = 190;
  ctx.fillStyle = C.ink; fit(ctx, r.name, 500, 32, 16, width, MONO); ctx.fillText(r.name, x, y);
  y += 26;
  ctx.font = `600 24px ${FONT}`;
  const pillW = ctx.measureText(r.label).width + 56;
  roundRect(ctx, x, y, pillW, 44, 22); ctx.fillStyle = tint; ctx.fill();
  ctx.fillStyle = color; ctx.beginPath(); ctx.arc(x + 24, y + 22, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillText(r.label, x + 40, y + 31);
  y += 96;
  ctx.fillStyle = C.ink; ctx.font = `800 34px ${DISPLAY}`;
  for (const line of wrap(ctx, r.verdict, width, 2)) { ctx.fillText(line, x, y); y += 44; }

  // Up to three warning signs
  y += 12;
  ctx.font = `500 25px ${FONT}`;
  if (!r.flags.length) {
    ctx.fillStyle = C.trusted; ctx.fillText("✓  No warning signs found", x, y);
  } else {
    // Most serious first
    const rank = { high: 0, medium: 1, low: 2 };
    const sorted = [...r.flags].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    const shown = sorted.slice(0, r.flags.length > 3 ? 2 : 3);
    for (const f of shown) {
      ctx.fillStyle = f.severity === "high" ? C.dangerous : f.severity === "medium" ? C.careful : C.muted;
      ctx.fillText("●  " + wrap(ctx, f.label, width - 40, 1)[0], x, y); y += 36;
    }
    if (r.flags.length > shown.length) { ctx.fillStyle = C.muted; ctx.fillText(`+ ${r.flags.length - shown.length} more warning signs`, x, y); }
  }

  // Footer: when it was checked and where to see the full report
  const date = new Date(r.checkedAt || Date.now()).toLocaleDateString("en-CA", { dateStyle: "medium" });
  ctx.fillStyle = C.muted; ctx.font = `400 21px ${FONT}`;
  ctx.fillText(`Checked ${date}. A set of warning signs, not a guarantee.`, x, H - 100);
  ctx.fillStyle = C.link; fit(ctx, link.replace(/^https?:\/\//, ""), 500, 22, 13, width, MONO);
  ctx.fillText(link.replace(/^https?:\/\//, ""), x, H - 66);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image."))), "image/png"));
}
