# Makes the square-ish (1080x1350) Instagram images for data/instagram-posts.json.
# Run: python3 scripts/make-instagram-images.py   (needs Pillow and the Inter font)
# To add a single-image post: add its text to CARDS below, add the post to data/instagram-posts.json, run this, commit both.
# To add a carousel (2 to 10 slides people swipe through): add it to CAROUSELS instead. Its slides land in
# instagram/<post id>/1.jpg, 2.jpg, ... and the post in data/instagram-posts.json lists them under "images".
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

def card(name, kicker, headline, body, badge=None, badge_color=ACCENT, counter=None):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((60, 60, W - 60, H - 60), 40, fill=CARD)
    x, y, width = 120, 140, W - 240
    d.text((x, y), kicker.upper(), font=font("Bold", 34), fill=ACCENT)
    if counter:  # "2/7" in the top right corner of a carousel slide
        cf = font("Bold", 34)
        d.text((W - 120 - d.textlength(counter, font=cf), y), counter, font=cf, fill=MUTED)
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
    more = counter and counter.split("/")[0] != counter.split("/")[1]
    d.text((x, H - 130), "Swipe for more  \u2192" if more else "Check before you clone.", font=font("Regular", 34), fill=MUTED)
    path = os.path.join(OUT, name + ".jpg")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    img.save(path, quality=92)

CARDS = [
    ("2026-10-23-intro", "New: SafeToClone", "Check a GitHub project before you download it.",
     "Paste any link. Get a grade from A to F in seconds. No coding needed.", "A"),
    ("2026-10-25-hijack", "AI safety", "Your AI reads files you never open.",
     "Files like CLAUDE.md and .cursorrules can hide instructions that hijack your assistant. We flag them."),
    ("2026-10-27-scripts", "We checked 20 AI tools", "All 20 got an A. 6 run a script straight from the internet.",
     "Normal for trusted projects. Also exactly how scams work. Here's the rule to follow.", "A", ACCENT),
]

# Each carousel: post id, then its slides as (kicker, headline, body, badge, badge colour).
CAROUSELS = [
    ("2026-10-29-warning-signs", [
        ("Save this", "5 warning signs a GitHub project is malware.", "Check these before you download any free tool."),
        ("Warning sign 1", "It asks you to turn off your antivirus.", "Real software never needs this. It is the number one trick malware uses to get past your protection."),
        ("Warning sign 2", "The download is a password-protected zip.", "The password stops your antivirus from looking inside. That is the whole point."),
        ("Warning sign 3", "It promises free premium, cracks or cheats.", "Paid software for free is the oldest bait there is."),
        ("Warning sign 4", "Thousands of stars in a few days.", "Stars can be bought. Real projects usually grow slowly."),
        ("Warning sign 5", "The owner's account is brand new.", "Scammers make fresh accounts because their old ones get banned."),
        ("Not sure?", "Paste the link. We check all 5 for you.", "Free grade from A to F in seconds. Save this for the next tool someone sends you."),
    ]),
    ("2026-10-31-unproven-vs-dangerous", [
        ("Low grade?", "Unproven vs Dangerous. What is the difference?", "A low grade on SafeToClone comes with one of two labels. They mean very different things."),
        ("Unproven", "Nothing looks wrong. It is just too new to trust yet.", "Too new or too little-known for anyone to have checked it properly."),
        ("Unproven: what to do", "Wait a few weeks, or ask someone who codes.", "For example: a tool a new developer posted last week. It could be great. Nobody knows yet."),
        ("Dangerous", "We found tricks that malware uses.", "For example: it asks you to turn off your antivirus, or ships a password-protected zip."),
        ("Dangerous: what to do", "Don't download it.", "Already did? Uninstall it, run a full antivirus scan and change your passwords, starting with email and banking."),
        ("Check any project", "Know which one you are dealing with.", "Paste any GitHub link. Free, no coding needed."),
    ]),
    ("2026-11-02-stars", [
        ("Popular is not the same as safe", "Stars can be bought.", "A project with thousands of stars can still get a low grade from us. Here is why."),
        ("What stars are", "Stars are like bookmarks.", "Lots of real stars usually means lots of real people have looked at the project."),
        ("The catch", "Fake stars are cheap.", "Scammers buy them to make malware look popular and trusted."),
        ("What we look at", "How fast the stars came, and from whom.", "Thousands of stars in a few days from a brand-new account is a red flag. We grade it down however popular it looks."),
        ("Send this", "To the friend who picks tools by star count.", "Check the whole project, not just the number, free at safetoclone.com."),
    ]),
    ("2026-11-04-installed-dangerous", [
        ("Save this", "Installed something marked Dangerous? Do these 3 things.", "Don't panic. Do them in this order."),
        ("Step 1", "Uninstall it.", "Remove the program and delete the folder you downloaded."),
        ("Step 2", "Run a full antivirus scan.", "A full scan, not a quick one. It takes longer and looks everywhere."),
        ("Step 3", "Change your passwords.", "Start with your email and your banking, then the rest you use on that computer."),
        ("Work computer?", "Tell your IT team right away.", "Before anything else. They would much rather hear it from you first."),
        ("Next time", "Check before you clone.", "Paste any GitHub link before you install it. Free grade from A to F."),
    ]),
]

if __name__ == "__main__":
    os.makedirs(OUT, exist_ok=True)
    for c in CARDS:
        card(*c)
    for post_id, slides in CAROUSELS:
        for i, (kicker, headline, body) in enumerate(slides, 1):
            card(f"{post_id}/{i}", kicker, headline, body, counter=f"{i}/{len(slides)}")
    print("Made", len(CARDS), "images and", len(CAROUSELS), "carousels in instagram/")
