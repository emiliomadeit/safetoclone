// Draws the "Download image" share card: a 1200x630 PNG of one result, in the website's style.
// Runs only in the visitor's browser (it uses a <canvas>). Nothing is uploaded anywhere.

const C = {
  paper: "#eef1ef", card: "#ffffff", ink: "#15201c", muted: "#56645e", line: "#d3dad6", accent: "#1d6b4c",
  trusted: "#1d7a4f", fine: "#1d7a4f", careful: "#a86a00", unproven: "#a86a00", dangerous: "#b3261e",
};
const DISPLAY = '"Archivo", "Arial Narrow", system-ui, sans-serif';
const BODY = '"Public Sans", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';
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
function fit(ctx, text, weight, family, size, min, width) {
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

// r = a result from score.js, link = the shareable link. Returns a PNG Blob.
export async function shareCard(r, link) {
  // Make sure the website fonts are ready, or the canvas falls back to plain system fonts.
  await Promise.all([
    `800 40px ${DISPLAY}`, `400 24px ${BODY}`, `600 24px ${BODY}`, `500 24px ${MONO}`,
  ].map((f) => document.fonts?.load(f).catch(() => {})));

  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const color = C[r.level] || C.accent;

  ctx.fillStyle = C.paper; ctx.fillRect(0, 0, W, H);
  roundRect(ctx, 32, 32, W - 64, H - 64, 28);
  ctx.fillStyle = C.card; ctx.fill();
  ctx.strokeStyle = C.line; ctx.lineWidth = 2; ctx.stroke();

  // The stamp: tilted double circle with the grade, like on the website.
  ctx.save();
  ctx.translate(250, 300);
  ctx.rotate(-8 * Math.PI / 180);
  ctx.strokeStyle = color; ctx.fillStyle = color;
  ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(0, 0, 160, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(0, 0, 142, 0, Math.PI * 2); ctx.stroke();
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  ctx.font = `800 170px ${DISPLAY}`; ctx.fillText(r.grade, 0, 50);
  ctx.font = `500 30px ${MONO}`; ctx.fillText(`${r.score}/100`, 0, 105);
  ctx.restore();

  const x = 470, width = W - x - 80;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";

  // Brand line
  ctx.strokeStyle = C.accent; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(x + 22, 100, 20, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = C.accent; ctx.font = `800 24px ${DISPLAY}`; ctx.textAlign = "center"; ctx.fillText("✓", x + 22, 109);
  ctx.textAlign = "left"; ctx.fillStyle = C.ink; ctx.font = `800 32px ${DISPLAY}`; ctx.fillText("SafeToClone", x + 56, 112);

  // Repo name, label and verdict
  let y = 180;
  ctx.fillStyle = C.ink; fit(ctx, r.name, 500, MONO, 32, 18, width); ctx.fillText(r.name, x, y);
  y += 46;
  ctx.fillStyle = color; ctx.font = `600 24px ${BODY}`; ctx.fillText(r.label.toUpperCase(), x, y);
  y += 52;
  ctx.fillStyle = C.ink; ctx.font = `800 36px ${DISPLAY}`;
  for (const line of wrap(ctx, r.verdict, width, 3)) { ctx.fillText(line, x, y); y += 44; }

  // Up to three warning signs
  y += 14;
  ctx.font = `600 24px ${BODY}`;
  if (!r.flags.length) {
    ctx.fillStyle = C.trusted; ctx.fillText("✓ No warning signs found", x, y);
  } else {
    // Most serious first
    const rank = { high: 0, medium: 1, low: 2 };
    const sorted = [...r.flags].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
    const shown = sorted.slice(0, r.flags.length > 3 ? 2 : 3);
    for (const f of shown) {
      ctx.fillStyle = f.severity === "high" ? C.dangerous : f.severity === "medium" ? C.careful : C.muted;
      ctx.fillText("● " + wrap(ctx, f.label, width - 30, 1)[0], x, y); y += 34;
    }
    if (r.flags.length > shown.length) { ctx.fillStyle = C.muted; ctx.fillText(`+ ${r.flags.length - shown.length} more warning signs`, x, y); }
  }

  // Footer: when it was checked and where to see the full report
  const date = new Date(r.checkedAt || Date.now()).toLocaleDateString("en-CA", { dateStyle: "medium" });
  ctx.fillStyle = C.muted; ctx.font = `400 20px ${BODY}`;
  ctx.fillText(`Checked ${date}. A set of warning signs, not a guarantee.`, x, H - 104);
  ctx.fillStyle = C.accent; fit(ctx, link.replace(/^https?:\/\//, ""), 500, MONO, 22, 14, width);
  ctx.fillText(link.replace(/^https?:\/\//, ""), x, H - 70);

  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Couldn't make the image."))), "image/png"));
}
