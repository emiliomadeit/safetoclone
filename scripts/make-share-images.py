# Makes the link-preview pictures (1200x630) that show up when someone pastes a SafeToClone link
# into WhatsApp, Slack, iMessage, LinkedIn, X, etc. worker.js picks which one to use.
# Run: python3 scripts/make-share-images.py   (needs Pillow and the Inter font)
# Only rerun it if you want to change how the previews look. Commit the new images in share/.
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
# Same colours as site.css and share-card.js.
BG, CARD, INK, MUTED, TRACK, BRAND, LINK = "#f5f5f7", "#ffffff", "#1d1d1f", "#6e6e73", "#e8e8ed", "#1f8a5b", "#0066cc"
COLORS = {"trusted": "#1a7f37", "fine": "#1a7f37", "careful": "#a15c00", "unproven": "#a15c00", "dangerous": "#c9271c", "brand": BRAND}
TINTS = {"trusted": "#e9f6ee", "fine": "#e9f6ee", "careful": "#fdf2e0", "unproven": "#fdf2e0", "dangerous": "#fdeceb", "brand": "#e9f6ee"}
LABELS = {"trusted": "Trusted", "fine": "Probably fine", "careful": "Be careful", "unproven": "Unproven", "dangerous": "Dangerous"}
FONT_DIR = "/usr/share/fonts/opentype/inter/"
OUT = os.path.join(os.path.dirname(__file__), "..", "share")

def font(weight, size):
    return ImageFont.truetype(FONT_DIR + f"Inter-{weight}.otf", size)

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

def dial(text, sub, color, fill):
    # The score dial from the website: a grey ring, filled in colour, with the grade in the middle.
    # Drawn 4x bigger and shrunk, so the ring edges come out smooth.
    S, k = 340, 4
    big = Image.new("RGBA", (S * k, S * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    pad, w = 20 * k, 26 * k
    box = (pad, pad, S * k - pad, S * k - pad)
    d.arc(box, 0, 360, fill=TRACK, width=w)
    end = -90 + 360 * fill
    d.arc(box, -90, end, fill=color, width=w)
    # Round ends on the coloured part, like the website.
    import math
    r = (S * k - 2 * pad - w) / 2
    for a in (-90, end):
        cx = S * k / 2 + r * math.cos(math.radians(a))
        cy = S * k / 2 + r * math.sin(math.radians(a))
        d.ellipse((cx - w / 2, cy - w / 2, cx + w / 2, cy + w / 2), fill=color)
    layer = big.resize((S, S), Image.LANCZOS)
    d = ImageDraw.Draw(layer)
    f = font("Bold", 150 if len(text) == 1 else 92)
    tw = d.textlength(text, font=f)
    d.text(((S - tw) / 2, 80 if len(text) == 1 else 110), text, font=f, fill=color)
    sf = font("Medium", 19)
    sw = d.textlength(sub, font=sf)
    d.text(((S - sw) / 2, 236), sub, font=sf, fill=MUTED)
    return layer

def logo(d, x, y, s):
    d.rounded_rectangle((x, y, x + s, y + s), s // 4, fill=BRAND)
    pts = [(x + s * 0.28, y + s * 0.52), (x + s * 0.42, y + s * 0.66), (x + s * 0.72, y + s * 0.36)]
    d.line(pts, fill="#ffffff", width=max(3, s // 10), joint="curve")

def card(name, dial_text, dial_sub, level, fill, kicker, headline, body):
    color = COLORS[level]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((32, 32, W - 32, H - 32), 36, fill=CARD)
    s = dial(dial_text, dial_sub, color, fill)
    img.paste(s, (80, (H - s.height) // 2), s)
    x, width = 480, W - 480 - 80
    # Brand line
    logo(d, x, 80, 44)
    d.text((x + 58, 84), "SafeToClone", font=font("SemiBold", 32), fill=INK)
    y = 170
    # Label in a coloured pill
    kf = font("SemiBold", 24)
    kw = d.textlength(kicker, font=kf)
    d.rounded_rectangle((x, y, x + kw + 56, y + 44), 22, fill=TINTS[level])
    d.ellipse((x + 18, y + 16, x + 30, y + 28), fill=color)
    d.text((x + 40, y + 8), kicker, font=kf, fill=color)
    y += 70
    hf = font("Bold", 52)
    for line in wrap(d, headline, hf, width)[:3]:
        d.text((x, y), line, font=hf, fill=INK)
        y += 62
    y += 16
    bf = font("Regular", 28)
    for line in wrap(d, body, bf, width)[:3]:
        d.text((x, y), line, font=bf, fill=MUTED)
        y += 40
    d.text((x, H - 112), "safetoclone.com", font=font("SemiBold", 30), fill=LINK)
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
