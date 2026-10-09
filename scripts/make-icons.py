#!/usr/bin/env python3
"""
Build every icon and logo asset the site serves, from the one confirmed logo.

    python scripts/make-icons.py          # needs Pillow, numpy, scipy

Input  : graphics/logo-source.png   (640x640, the confirmed bull on its
                                      mint -> periwinkle gradient, as supplied)
Outputs: logo.png  favicon.ico  favicon-16x16.png  favicon-32x32.png
         apple-touch-icon.png  icon-192.png  icon-512.png

Adopted 2026-10-10, replacing the neon outline bull (kept, unused, in
graphics/retired-neon/).

1. THE SITE LOGO IS A STRAIGHT-ALPHA CUTOUT, NOT THE SOURCE.
   The source is opaque RGB on a soft horizontal gradient. The gradient is
   modelled (quadratic in x, linear in y) from a 24px border ring -- residual
   there is under 3/255, so the model is effectively exact -- and a pixel is
   background when it sits within GRAD_TOL of that model AND is connected to
   the edge. Connectivity matters: the bull's cream outline is close enough to
   the mint end of the gradient that a pure colour key would eat into it.
   Edge pixels get a soft alpha from their distance to the model, then the
   gradient is subtracted back out of their colour (decontamination), so the
   rim does not carry a mint fringe onto the indigo page.

2. THE ICONS KEEP THE GRADIENT TILE.
   Browser chrome is light or dark depending on the user; the bull on its own
   gradient reads on both, and it is how the artwork was supplied. They are
   square crops of the source itself, so the tile is the artist's gradient,
   not a re-creation of it.
"""
import os
import numpy as np
from PIL import Image
from scipy import ndimage as ndi

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "graphics", "logo-source.png")

GRAD_TOL = 22.0
# square crops of the 640px source, both centred on the bull (bbox x64-577,
# y95-543): ICON_BOX leaves breathing room, FAVICON_BOX is as tight as the
# horns allow so the face is as large as possible at 16px
ICON_BOX = (40, 39, 600, 599)
FAVICON_BOX = (56, 55, 584, 583)


def cutout(src):
    im = np.asarray(src).astype(np.float64)
    h, w, _ = im.shape
    yy, xx = np.mgrid[0:h, 0:w]
    X, Y = xx / w, yy / h
    ring = np.zeros((h, w), bool)
    ring[:24] = ring[-24:] = True
    ring[:, :24] = ring[:, -24:] = True
    A = np.stack([np.ones_like(X), X, X ** 2, Y, X * Y], -1)
    coef = np.linalg.lstsq(A[ring], im[ring], rcond=None)[0]
    bg = A @ coef
    diff = np.sqrt(((im - bg) ** 2).sum(-1))

    lab, _ = ndi.label(diff < GRAD_TOL)
    edge = np.unique(np.concatenate([lab[0], lab[-1], lab[:, 0], lab[:, -1]]))
    fg = ~np.isin(lab, edge[edge > 0])
    fg = ndi.binary_opening(fg, iterations=1)
    lab2, n2 = ndi.label(fg)
    sizes = ndi.sum(fg, lab2, range(1, n2 + 1))
    fg = np.isin(lab2, 1 + np.flatnonzero(sizes >= 200))

    band = ndi.binary_dilation(fg, iterations=2) & ~ndi.binary_erosion(fg, iterations=2)
    t0, t1 = GRAD_TOL * 0.5, GRAD_TOL * 2.6
    alpha = fg.astype(np.float64)
    alpha[band] = np.clip((diff - t0) / (t1 - t0), 0, 1)[band]
    alpha = ndi.gaussian_filter(alpha, 0.6)
    alpha[ndi.binary_erosion(fg, iterations=3)] = 1.0

    a = np.clip(alpha, 1e-3, 1)[..., None]
    col = np.clip(bg + (im - bg) / a, 0, 255)
    col = np.where(alpha[..., None] > 0.98, im, col)
    rgba = np.dstack([col, alpha * 255]).round().astype(np.uint8)
    out = Image.fromarray(rgba, "RGBA")
    # square, centred on the artwork, then 512 -- the size the page declares
    l, t, r, b = out.getbbox()
    side = max(r - l, b - t) + 16
    cx, cy = (l + r) // 2, (t + b) // 2
    sq = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    sq.paste(out.crop((l, t, r, b)), ((side - (r - l)) // 2, (side - (b - t)) // 2))
    return sq.resize((512, 512), Image.LANCZOS)


def main():
    src = Image.open(SRC).convert("RGB")
    if src.size != (640, 640):
        raise SystemExit(f"expected a 640x640 source, got {src.size}")

    written = []

    def save(img, name, **kw):
        p = os.path.join(ROOT, name)
        img.save(p, **kw)
        written.append((name, img.size, os.path.getsize(p)))

    save(cutout(src), "logo.png", optimize=True)

    fav = src.crop(FAVICON_BOX)
    save(fav.resize((16, 16), Image.LANCZOS), "favicon-16x16.png")
    save(fav.resize((32, 32), Image.LANCZOS), "favicon-32x32.png")
    # one .ico carrying all three chrome sizes, so the OS never has to rescale
    save(fav.resize((48, 48), Image.LANCZOS), "favicon.ico",
         sizes=[(16, 16), (32, 32), (48, 48)])

    icon = src.crop(ICON_BOX)
    save(icon.resize((180, 180), Image.LANCZOS), "apple-touch-icon.png", optimize=True)
    save(icon.resize((192, 192), Image.LANCZOS), "icon-192.png", optimize=True)
    save(icon.resize((512, 512), Image.LANCZOS), "icon-512.png", optimize=True)

    for name, size, nbytes in written:
        print(f"ok   {name:24s} {size[0]}x{size[1]:<5} {nbytes:>8,} bytes")


if __name__ == "__main__":
    main()
