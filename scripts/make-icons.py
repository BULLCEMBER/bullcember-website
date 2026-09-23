#!/usr/bin/env python3
"""
Build every icon and logo asset the site serves, from the one confirmed logo.

    python scripts/make-icons.py

Input  : graphics/logo-source.png   (512x512, the confirmed neon bull, gitignored)
Outputs: logo.png  favicon.ico  favicon-16x16.png  favicon-32x32.png
         apple-touch-icon.png  icon-192.png  icon-512.png

Two decisions are baked in here, both measured rather than guessed.

1. THE SITE LOGO IS A STRAIGHT-ALPHA CUTOUT, NOT THE SOURCE PNG.
   The source is opaque RGB on a #0E0E0D field, so dropping it onto the page
   would show a black square with a visible seam against --bg (#080A07). The
   cutout takes alpha from the brightest channel -- for neon art the channel
   maximum tracks emitted light far better than luminance, which would crush
   the saturated green -- and then UNPREMULTIPLIES the colour. Skipping the
   unpremultiply is the usual mistake: it looks right on a black page and goes
   muddy everywhere else, because the glow falloff stays multiplied by an alpha
   the compositor is about to apply a second time.

2. SMALL ICONS USE A HEAD CROP. THE SITE ITSELF NEVER DOES.
   Rendered and inspected at real size: the full body holds together down to
   about 48px, where the horns are still legible. At 32px it is marginal and at
   16px it collapses into an anonymous blob -- the horns, which are the entire
   identity, are the first thing the downscale eats. So favicons crop to the
   head, which still reads at 16px. This is a legibility adaptation for browser
   chrome only; everywhere on the page the logo is used exactly as supplied.

   The crop is HEAD_BOX below, derived from a row-by-row scan of the silhouette:
   horns span x135-375 across y18-100, the muzzle narrows to x182-323 by y140,
   and the arms start flaring past y160. Cutting at y200 keeps the whole horn
   spread and stops before the arms widen the shape.

Favicons keep the dark tile rather than going transparent. A bare neon outline
on a light browser tab strip is nearly invisible; a self-contained dark tile
reads on light and dark chrome alike.
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "graphics", "logo-source.png")

# the near-black the art was rendered on; anything at or below this is background
FLOOR = 15.0
TILE = (14, 14, 13)
HEAD_BOX = (110, 0, 400, 200)


def cutout(src):
    """Opaque neon-on-black -> straight-alpha RGBA."""
    w, h = src.size
    sc = 255.0 / (255.0 - FLOOR)
    out = []
    for r, g, b in src.getdata():
        r = max(0.0, (r - FLOOR) * sc)
        g = max(0.0, (g - FLOOR) * sc)
        b = max(0.0, (b - FLOOR) * sc)
        a = max(r, g, b)
        if a <= 0:
            out.append((0, 0, 0, 0))
            continue
        k = 255.0 / a
        out.append((min(255, int(r * k + 0.5)),
                    min(255, int(g * k + 0.5)),
                    min(255, int(b * k + 0.5)),
                    min(255, int(a + 0.5))))
    im = Image.new("RGBA", (w, h))
    im.putdata(out)
    return im


def square(img, box=None):
    """Crop then pad to a centred square on the tile colour."""
    c = img.crop(box) if box else img
    w, h = c.size
    side = max(w, h)
    t = Image.new("RGB", (side, side), TILE)
    t.paste(c, ((side - w) // 2, (side - h) // 2))
    return t


def main():
    src = Image.open(SRC).convert("RGB")
    if src.size != (512, 512):
        raise SystemExit(f"expected a 512x512 source, got {src.size}")

    written = []

    def save(img, name, **kw):
        p = os.path.join(ROOT, name)
        img.save(p, **kw)
        written.append((name, img.size, os.path.getsize(p)))

    save(cutout(src), "logo.png")

    head = square(src, HEAD_BOX)
    save(head.resize((16, 16), Image.LANCZOS), "favicon-16x16.png")
    save(head.resize((32, 32), Image.LANCZOS), "favicon-32x32.png")
    # one .ico carrying all three chrome sizes, so the OS never has to rescale
    save(head.resize((48, 48), Image.LANCZOS), "favicon.ico",
         sizes=[(16, 16), (32, 32), (48, 48)])

    body = square(src)
    save(body.resize((180, 180), Image.LANCZOS), "apple-touch-icon.png")
    save(body.resize((192, 192), Image.LANCZOS), "icon-192.png")
    save(body.resize((512, 512), Image.LANCZOS), "icon-512.png")

    for name, size, nbytes in written:
        print(f"ok   {name:24s} {size[0]}x{size[1]:<5} {nbytes:>8,} bytes")


if __name__ == "__main__":
    main()
