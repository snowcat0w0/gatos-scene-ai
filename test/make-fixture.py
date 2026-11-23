"""Generate the test dungeon (known grid, walls, doors, lights). Usage: python make-fixture.py"""
import random
from PIL import Image, ImageDraw, ImageFilter

CELL, OX, OY = 64, 23, 41          # grid period and the position of the first grid line
COLS, ROWS = 22, 16
W, H = OX + COLS * CELL + 30, OY + ROWS * CELL + 19
random.seed(7)

# Floor areas in cells: (x0, y0, x1, y1)
FLOOR = [
    (1, 1, 8, 6),      # room A
    (11, 1, 20, 5),    # room B
    (8, 3, 11, 4),     # corridor A-B
    (3, 9, 9, 14),     # room C
    (5, 6, 6, 9),      # corridor A-C
    (13, 8, 20, 14),   # room D
    (16, 5, 17, 8),    # corridor B-D
]
PILLARS = [(5, 11, 6, 12)]
DOORS = [((8, 3), (8, 4)), ((11, 3), (11, 4)), ((5, 9), (6, 9)), ((16, 8), (17, 8))]
TORCHES = [(1.25, 3.5), (15.5, 1.25), (8.75, 11.5)]
BRAZIER = (16.5, 11.0)

px = lambda c, o: o + c * CELL

img = Image.new("RGB", (W, H))
pix = img.load()
for y in range(H):
    for x in range(W):
        v = 38 + random.randint(-9, 9)
        pix[x, y] = (v, v - 2, v - 4)
img = img.filter(ImageFilter.GaussianBlur(0.8))
d = ImageDraw.Draw(img)

floor = Image.new("RGB", (W, H))
fp = floor.load()
for y in range(H):
    for x in range(W):
        v = random.randint(-10, 10)
        fp[x, y] = (186 + v, 176 + v, 152 + v)
floor = floor.filter(ImageFilter.GaussianBlur(0.7))
mask = Image.new("L", (W, H), 0)
md = ImageDraw.Draw(mask)
for x0, y0, x1, y1 in FLOOR:
    md.rectangle([px(x0, OX), px(y0, OY), px(x1, OX) - 1, px(y1, OY) - 1], fill=255)
for x0, y0, x1, y1 in PILLARS:
    md.rectangle([px(x0, OX), px(y0, OY), px(x1, OX) - 1, px(y1, OY) - 1], fill=0)
# Grid lines on the floor only, like most published maps.
fd = ImageDraw.Draw(floor)
for c in range(COLS + 1):
    fd.line([px(c, OX), 0, px(c, OX), H], fill=(141, 132, 112), width=1)
for r in range(ROWS + 1):
    fd.line([0, px(r, OY), W, px(r, OY)], fill=(141, 132, 112), width=1)
img.paste(floor, (0, 0), mask)

# Dark outline where floor meets rock.
edge = mask.filter(ImageFilter.FIND_EDGES)
img.paste((20, 18, 16), (0, 0), edge.point(lambda v: 255 if v > 40 else 0).filter(ImageFilter.MaxFilter(5)))

d = ImageDraw.Draw(img)
for (ax, ay), (bx, by) in DOORS:
    x0, y0, x1, y1 = px(ax, OX), px(ay, OY), px(bx, OX), px(by, OY)
    if ax == bx:   # vertical door
        d.rectangle([x0 - 6, y0 + 4, x0 + 6, y1 - 4], fill=(122, 72, 34), outline=(40, 22, 10))
    else:
        d.rectangle([x0 + 4, y0 - 6, x1 - 4, y0 + 6], fill=(122, 72, 34), outline=(40, 22, 10))

glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
for cx, cy in TORCHES + [BRAZIER]:
    x, y = px(cx, OX), px(cy, OY)
    r = 70 if (cx, cy) != BRAZIER else 110
    gd.ellipse([x - r, y - r, x + r, y + r], fill=(255, 170, 60, 70))
glow = glow.filter(ImageFilter.GaussianBlur(28))
img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
d = ImageDraw.Draw(img)
for cx, cy in TORCHES:
    x, y = px(cx, OX), px(cy, OY)
    d.ellipse([x - 7, y - 7, x + 7, y + 7], fill=(255, 196, 64), outline=(120, 50, 10), width=2)
    d.ellipse([x - 3, y - 3, x + 3, y + 3], fill=(255, 250, 210))
x, y = px(BRAZIER[0], OX), px(BRAZIER[1], OY)
d.ellipse([x - 20, y - 20, x + 20, y + 20], fill=(70, 62, 58), outline=(20, 18, 16), width=3)
d.ellipse([x - 12, y - 12, x + 12, y + 12], fill=(255, 120, 30))
d.ellipse([x - 6, y - 6, x + 6, y + 6], fill=(255, 220, 110))

img.save("fixtures/dungeon.jpg", quality=88)
print(W, H)
