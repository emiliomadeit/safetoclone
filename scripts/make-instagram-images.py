# Makes the square-ish (1080x1350) Instagram images for data/instagram-posts.json.
# Run: python3 scripts/make-instagram-images.py   (needs Pillow and the Inter font)
# To add a post: add its text to CARDS below, add the post to data/instagram-posts.json, run this, commit both.
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1080, 1350
BG, CARD, INK, MUTED, ACCENT, BAD = "#0f1a16", "#18231f", "#e6ede9", "#9aaaa3", "#4fc08d", "#ff7b6e"
FONT_DIR = "/usr/share/fonts/opentype/inter/"
OUT = os.path.join(os.path.dirname(__file__), "..", "instagram")

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

def card(name, kicker, headline, body, badge=None, badge_color=ACCENT):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((60, 60, W - 60, H - 60), 40, fill=CARD)
    x, y, width = 120, 140, W - 240
    d.text((x, y), kicker.upper(), font=font("Bold", 34), fill=ACCENT)
    y += 90
    if badge:
        d.rounded_rectangle((x, y, x + 220, y + 220), 36, fill=badge_color)
        bf = font("Black", 150)
        tw = d.textlength(badge, font=bf)
        d.text((x + (220 - tw) / 2, y + 18), badge, font=bf, fill=BG)
        y += 280
    hf = font("ExtraBold", 76)
    for line in wrap(d, headline, hf, width):
        d.text((x, y), line, font=hf, fill=INK)
        y += 92
    y += 40
    bf = font("Regular", 42)
    for line in wrap(d, body, bf, width):
        d.text((x, y), line, font=bf, fill=MUTED)
        y += 60
    d.text((x, H - 190), "safetoclone.com", font=font("Bold", 46), fill=ACCENT)
    d.text((x, H - 130), "Check before you clone.", font=font("Regular", 34), fill=MUTED)
    img.save(os.path.join(OUT, name + ".jpg"), quality=92)

CARDS = [
    ("2026-10-23-intro", "New: SafeToClone", "Check a GitHub project before you download it.",
     "Paste any link. Get a grade from A to F in seconds. No coding needed.", "A"),
    ("2026-10-25-hijack", "AI safety", "Your AI reads files you never open.",
     "Files like CLAUDE.md and .cursorrules can hide instructions that hijack your assistant. We flag them.", "!", BAD),
    ("2026-10-27-scripts", "We checked 20 AI tools", "All 20 got an A. 6 run a script straight from the internet.",
     "Normal for trusted projects. Also exactly how scams work. Here's the rule to follow.", "6", ACCENT),
]

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for c in CARDS:
        card(*c)
    print("Made", len(CARDS), "images in instagram/")
