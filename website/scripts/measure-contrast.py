#!/usr/bin/env python3
"""
Measure rendered text contrast from a screenshot, by looking at pixels.

Why not read the CSS tokens? Because the hero paints text over a `mix-blend-mode:
screen` aurora. Blend modes move the effective background away from any token
value, so a token-based check would be measuring a colour that is never actually
on screen. The only trustworthy answer comes from the painted pixels.

Method, per region: build a luminance histogram. The modal bucket is the local
background (most of a text box is background). The 97th percentile is the core
of the antialiased glyph. Contrast between those two is a conservative,
reproducible stand-in for "can you read this".

No PIL and no ImageMagick on this box, so the PNG is decoded by hand with zlib.
"""

import struct
import sys
import zlib
from collections import Counter


def read_png(path):
    """Decode a non-interlaced 8-bit RGB/RGBA PNG to a list of rows of (r,g,b)."""
    data = open(path, "rb").read()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, width, height, channels = 8, b"", 0, 0, 3
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        ctype = data[pos + 4 : pos + 8]
        chunk = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            width, height, depth, color = struct.unpack(">IIBB", chunk[:10])
            assert depth == 8, f"expected 8-bit, got {depth}"
            channels = {2: 3, 6: 4}[color]
        elif ctype == b"IDAT":
            idat += chunk
        elif ctype == b"IEND":
            break
        pos += 12 + length

    raw = zlib.decompress(idat)
    stride = width * channels
    out, prev = [], bytearray(stride)
    p = 0
    for _ in range(height):
        f = raw[p]
        line = bytearray(raw[p + 1 : p + 1 + stride])
        p += 1 + stride
        # Undo the per-scanline PNG filter.
        for i in range(stride):
            a = line[i - channels] if i >= channels else 0
            b = prev[i]
            c = prev[i - channels] if i >= channels else 0
            x = line[i]
            if f == 1:
                x += a
            elif f == 2:
                x += b
            elif f == 3:
                x += (a + b) // 2
            elif f == 4:
                pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
                x += a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
            line[i] = x & 0xFF
        out.append([tuple(line[i : i + 3]) for i in range(0, stride, channels)])
        prev = line
    return width, height, out


def rel_lum(rgb):
    """WCAG relative luminance."""
    def ch(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(c) for c in rgb)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a, b):
    la, lb = rel_lum(a), rel_lum(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def measure(rows, box, label, large):
    x0, y0, x1, y1 = box
    px = [rows[y][x] for y in range(y0, y1) for x in range(x0, x1)]
    if not px:
        return
    lums = sorted(px, key=rel_lum)
    # Background: the most common colour AMONG THE DARKER HALF of the region,
    # quantised so antialiasing does not split one background into a hundred
    # near-identical buckets.
    #
    # The "darker half" restriction is load-bearing and was not in the first
    # version of this script. Taking the mode of the whole region assumes text
    # covers less than half of it — true for a paragraph, false for a 68px
    # headline, where the mode IS the glyph fill and the measured ratio comes
    # back as a meaningless 1.01:1. Since this page is uniformly light-on-dark,
    # the darker half is always background.
    dark = lums[: max(1, len(lums) // 2)]
    bg = Counter((r // 6, g // 6, b // 6) for r, g, b in dark).most_common(1)[0][0]
    bg = (bg[0] * 6 + 3, bg[1] * 6 + 3, bg[2] * 6 + 3)
    fg = lums[int(len(lums) * 0.97)]
    ratio = contrast(fg, bg)
    need = 3.0 if large else 4.5
    print(
        f"  {label:<14} text≈rgb{fg}  bg≈rgb{bg}  "
        f"{ratio:5.2f}:1  need {need}  {'PASS' if ratio >= need else 'FAIL'}"
    )
    return ratio >= need


if __name__ == "__main__":
    path = sys.argv[1]
    w, h, rows = read_png(path)
    print(f"{path} — {w}x{h}")
    # label, box, is-large-text (>=24px, or >=18.66px bold)
    regions = [
        ("eyebrow", (168, 187, 421, 207), False),
        ("h1", (168, 221, 657, 362), True),
        ("lede1", (168, 388, 657, 449), False),
        ("lede2", (168, 467, 657, 558), False),
        ("blurb", (721, 337, 1272, 381), False),
        ("tab-inactive", (830, 175, 979, 215), False),
    ]
    ok = [measure(rows, b, l, lg) for l, b, lg in regions]
    print("\nALL PASS" if all(ok) else "\nFAILURES PRESENT")
