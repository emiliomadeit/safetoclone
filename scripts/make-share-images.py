# Makes the link-preview pictures (1200x630) that show up when someone pastes a SafeToClone link
# into WhatsApp, Slack, iMessage, LinkedIn, X, etc. worker.js picks which one to use.
# Run: python3 scripts/make-share-images.py   (needs Pillow and the Inter font)
# Only rerun it if you want to change how the previews look. Commit the new images in share/.
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
PAPER, CARD, INK, MUTED, LINE, ACCENT = "#eef1ef", "#ffffff", "#15201c", "#56645e", "#d3dad6", "#1d6b4c"
COLORS = {"trusted": "#1d7a4f", "fine": "#1d7a4f", "careful": "#a86a00", "unproven": "#a86a00", "dangerous": "#b3261e"}
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

def stamp(text, sub, color):
    # A round rubber stamp, slightly tilted, like the one on the website.
    S = 340
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.ellipse((10, 10, S - 10, S - 10), outline=color, width=8)
    d.ellipse((28, 28, S - 28, S - 28), outline=color, width=4)
    f = font("Black", 150 if len(text) == 1 else 96)
    tw = d.textlength(text, font=f)
    d.text(((S - tw) / 2, 70 if len(text) == 1 else 100), text, font=f, fill=color)
    sf = font("Bold", 26)
    sw = d.textlength(sub, font=sf)
    d.text(((S - sw) / 2, 240), sub, font=sf, fill=color)
    return layer.rotate(8, resample=Image.BICUBIC)

def card(name, stamp_text, stamp_sub, color, kicker, headline, body):
    img = Image.new("RGB", (W, H), PAPER)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((32, 32, W - 32, H - 32), 28, fill=CARD, outline=LINE, width=2)
    s = stamp(stamp_text, stamp_sub, color)
    img.paste(s, (80, (H - s.height) // 2), s)
    x, width = 470, W - 470 - 80
    # Brand line
    d.ellipse((x, 84, x + 44, 128), outline=ACCENT, width=4)
    d.text((x + 11, 88), "✓", font=font("Bold", 30), fill=ACCENT)
    d.text((x + 58, 88), "SafeToClone", font=font("ExtraBold", 34), fill=INK)
    y = 175
    d.text((x, y), kicker.upper(), font=font("Bold", 26), fill=color)
    y += 48
    hf = font("ExtraBold", 54)
    for line in wrap(d, headline, hf, width)[:3]:
        d.text((x, y), line, font=hf, fill=INK)
        y += 64
    y += 18
    bf = font("Regular", 28)
    for line in wrap(d, body, bf, width)[:3]:
        d.text((x, y), line, font=bf, fill=MUTED)
        y += 40
    d.text((x, H - 110), "safetoclone.com", font=font("Bold", 32), fill=ACCENT)
    img.save(os.path.join(OUT, name + ".png"), optimize=True)

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    card("default", "A–F", "SAFETY GRADE", ACCENT, "Free safety check",
         "Is this GitHub repo safe to download?",
         "Paste a link, get a grade from A to F and a plain-English list of warning signs.")
    made = 1
    # One picture per grade and label. "Dangerous" can come with any grade, the others with one or two.
    combos = [("A", "trusted"), ("B", "fine"), ("C", "careful"), ("D", "unproven"), ("F", "unproven")]
    combos += [(g, "dangerous") for g in "ABCDF"]
    for grade, level in combos:
        headline = {"dangerous": "Shows signs of malware.", "unproven": "Too new or little-known to trust yet.",
                    "careful": "Be careful before installing.", "fine": "Probably fine.", "trusted": "Looks trustworthy."}[level]
        card(f"{grade}-{level}", grade, "SAFETY GRADE", COLORS[level], f"Grade {grade} · {LABELS[level]}",
             headline, "Open the link to see the full report and every warning sign we found.")
        made += 1
    print("Made", made, "images in share/")
