# Makes the link-preview pictures (1200x630) that show up when someone pastes a SafeToClone link
# into WhatsApp, Slack, iMessage, LinkedIn, X, etc. worker.js picks which one to use.
# Run: python3 scripts/make-share-images.py   (needs Pillow and the Inter font; the headline and label fonts come from fonts/)
# Only rerun it if you want to change how the previews look. Commit the new images in share/.
from PIL import Image, ImageDraw, ImageFont
import math, os

W, H = 1200, 630
# Same colours as site.css and share-card.js.
BG, CARD, INK, MUTED, TRACK, BRAND, LINK = "#f1f4f2", "#ffffff", "#15201c", "#56645e", "#e1e8e4", "#1f8a5b", "#1d6b4c"
COLORS = {"trusted": "#1d7a4f", "fine": "#1d7a4f", "careful": "#9a5800", "unproven": "#9a5800", "dangerous": "#b8261c", "brand": BRAND}
TINTS = {"trusted": "#e2f2e8", "fine": "#e2f2e8", "careful": "#fcefd9", "unproven": "#fcefd9", "dangerous": "#fce5e2", "brand": "#e2f2e8"}
LABELS = {"trusted": "Trusted", "fine": "Probably fine", "careful": "Be careful", "unproven": "Unproven", "dangerous": "Dangerous"}
FONT_DIR = "/usr/share/fonts/opentype/inter/"
SITE_FONTS = os.path.join(os.path.dirname(__file__), "..", "fonts")
OUT = os.path.join(os.path.dirname(__file__), "..", "share")

def font(weight, size):
    return ImageFont.truetype(FONT_DIR + f"Inter-{weight}.otf", size)

def display(size):
    # The website's headline font: Archivo ExtraBold, 112% wide
    return ImageFont.truetype(os.path.join(SITE_FONTS, "archivo-expanded-800.woff2"), size)

def mono(size):
    # The website's small-label font: JetBrains Mono
    return ImageFont.truetype(os.path.join(SITE_FONTS, "jetbrains-mono-500.woff2"), size)

def wrap(draw, text, f, width):
    lines, line = [], ""
    for word in text.split():
        test = (line + " " + word).strip()
        if draw.textlength(test, font=f) <= width:
            line = test
        else:
            lines.append(line)
            line = word
    lines.append(line)
    return lines

def dial(text, sub, color, tint, fill):
    # The score dial from the website: a grey ring filled in colour up to the score, a tinted middle,
    # and the grade stamped on at a slight angle. Drawn 4x bigger and shrunk, so the edges come out smooth.
    S, k = 340, 4
    big = Image.new("RGBA", (S * k, S * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    pad, w = 20 * k, 26 * k
    box = (pad, pad, S * k - pad, S * k - pad)
    inner = pad + w + 12 * k
    d.ellipse((inner, inner, S * k - inner, S * k - inner), fill=tint)
    d.arc(box, 0, 360, fill=TRACK, width=w)
    end = -90 + 360 * fill
    d.arc(box, -90, end, fill=color, width=w)
    # Round ends on the coloured part, like the website.
    r = (S * k - 2 * pad - w) / 2
    for a in (-90, end):
        cx = S * k / 2 + r * math.cos(math.radians(a))
        cy = S * k / 2 + r * math.sin(math.radians(a))
        d.ellipse((cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2), fill=color)
    # The stamp: grade and caption on their own layer, turned 8 degrees like a rubber stamp.
    stamp = Image.new("RGBA", (S * k, S * k), (0, 0, 0, 0))
    sd = ImageDraw.Draw(stamp)
    f = display((128 if len(text) == 1 else 76) * k)
    sd.text((S * k / 2, S * k / 2 - 8 * k), text, font=f, fill=color, anchor="mm")
    sf = mono(20 * k)
    sd.text((S * k / 2, S * k / 2 + (70 if len(text) == 1 else 52) * k), sub, font=sf, fill=color, anchor="mm")
    stamp = stamp.rotate(8, resample=Image.BICUBIC, center=(S * k / 2, S * k / 2))
    big.alpha_composite(stamp)
    return big.resize((S, S), Image.LANCZOS)

def logo(d, x, y, s):
    d.rounded_rectangle((x, y, x + s, y + s), s // 4, fill=BRAND)
    pts = [(x + s * 0.28, y + s * 0.52), (x + s * 0.42, y + s * 0.66), (x + s * 0.72, y + s * 0.36)]
    d.line(pts, fill="#ffffff", width=max(3, s // 10), joint="curve")

def card(name, dial_text, dial_sub, level, fill, kicker, headline, body):
    color = COLORS[level]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((32, 32, W - 32, H - 32), 36, fill=CARD)
    s = dial(dial_text, dial_sub, color, TINTS[level], fill)
    img.paste(s, (80, (H - s.height) // 2), s)
    x, width = 480, W - 480 - 80
    # Brand line
    logo(d, x, 80, 44)
    d.text((x + 58, 102), "SafeToClone", font=display(30), fill=INK, anchor="lm")
    y = 170
    # Label in a coloured pill
    kf = font("SemiBold", 24)
    kw = d.textlength(kicker, font=kf)
    d.rounded_rectangle((x, y, x + kw + 56, y + 44), 22, fill=TINTS[level])
    d.ellipse((x + 18, y + 16, x + 30, y + 28), fill=color)
    d.text((x + 40, y + 8), kicker, font=kf, fill=color)
    y += 70
    hf = display(46)
    for line in wrap(d, headline, hf, width)[:3]:
        d.text((x, y), line, font=hf, fill=INK)
        y += 58
    y += 16
    bf = font("Regular", 28)
    for line in wrap(d, body, bf, width)[:3]:
        d.text((x, y), line, font=bf, fill=MUTED)
        y += 40
    d.text((x, H - 112), "safetoclone.com", font=mono(28), fill=LINK)
    img.save(os.path.join(OUT, name + ".png"), optimize=True)

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    card("default", "A–F", "SAFETY GRADE", "brand", 0.75, "Free safety check",
         "Is this GitHub repo safe to download?",
         "Paste a link, get a grade from A to F and a plain-English list of warning signs.")
    made = 1
    # One picture per grade and label. "Dangerous" can come with any grade, the others with one or two.
    combos = [("A", "trusted"), ("B", "fine"), ("C", "careful"), ("D", "unproven"), ("F", "unproven")]
    combos += [(g, "dangerous") for g in "ABCDF"]
    for grade, level in combos:
        headline = {"dangerous": "Shows signs of malware.", "unproven": "Too new or little-known to trust yet.",
                    "careful": "Be careful before installing.", "fine": "Probably fine.", "trusted": "Looks trustworthy."}[level]
        fill = {"A": 0.92, "B": 0.77, "C": 0.62, "D": 0.47, "F": 0.25}[grade]
        card(f"{grade}-{level}", grade, "SAFETY GRADE", level, fill, f"Grade {grade} · {LABELS[level]}",
             headline, "Open the link to see the full report and every warning sign we found.")
        made += 1
    print("Made", made, "images in share/")
