#!/usr/bin/env python3
"""Generate the plugin's PNG icons at the exact sizes the manifest declares.

Mismatched icon sizes produce a Gecko manifest warning and can contribute to an
install-time compatibility failure, so the sizes here must match
`addon/manifest.json` exactly.

Usage: python3 scripts/make-icons.py
"""
import os
import struct
import zlib

OUT_DIR = os.path.join(
    os.path.dirname(os.path.abspath(__file__)), "..", "addon", "content", "icons"
)

# The plugin's accent colour, matching the answer panel (#2f6feb).
BG = (47, 111, 235)
FG = (255, 255, 255)


def make_png(size: int) -> bytes:
    """A simple mark: three white text bars on the accent background."""
    radius = max(1, size // 8)
    bar_h = max(1, size // 12)
    gap = max(1, size // 8)
    top = size // 4
    left = max(1, size // 5)

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # Rounded corners: transparent outside the radius.
            cx = min(x, size - 1 - x)
            cy = min(y, size - 1 - y)
            if cx < radius and cy < radius:
                dx, dy = radius - cx, radius - cy
                if dx * dx + dy * dy > radius * radius:
                    row += bytes((0, 0, 0, 0))
                    continue

            in_bar = False
            for i in range(3):
                y0 = top + i * (bar_h + gap)
                if y0 <= y < y0 + bar_h:
                    # The middle bar is shortened, so the mark reads as text.
                    right = size - left - (size // 3 if i == 1 else 0)
                    in_bar = left <= x < right
                    break

            row += bytes((FG if in_bar else BG) + (255,))
        rows.append(bytes(row))

    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    # Names and sizes must match addon/manifest.json.
    targets = {
        "favicon.png": 96,
        "favicon@0.5x.png": 48,
    }
    for name, size in targets.items():
        path = os.path.join(OUT_DIR, name)
        with open(path, "wb") as fh:
            fh.write(make_png(size))
        print(f"wrote {path} ({size}x{size})")


if __name__ == "__main__":
    main()
