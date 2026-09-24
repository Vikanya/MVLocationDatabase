#!/usr/bin/env python3
"""Convert the exported screenshots (PNG) to WebP for the site.

    python tools/convert_images.py

Input:  source/export/images/<gid>_r<row>_c<col>.png   (from tools/export-sheet.gs)
Output: media/full/<id>.webp    full resolution, WebP quality 85
        media/thumb/<id>.webp   480 px wide, WebP quality 80
        source/export/image-map.json   export name -> id (read by tools/convert_export.py)

<id> is the first 12 hex characters of the PNG's SHA-1: identical screenshots are stored once, and
re-running only converts files that aren't in media/ yet.
"""
from __future__ import annotations

import hashlib
import json
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "source" / "export" / "images"
MAP_FILE = ROOT / "source" / "export" / "image-map.json"
FULL = ROOT / "media" / "full"
THUMB = ROOT / "media" / "thumb"

FULL_QUALITY = 85
THUMB_WIDTH = 480
THUMB_QUALITY = 80


def convert(path: Path):
    data = path.read_bytes()
    media_id = hashlib.sha1(data).hexdigest()[:12]
    full, thumb = FULL / f"{media_id}.webp", THUMB / f"{media_id}.webp"
    with Image.open(path) as im:
        width, height = im.size
        if not (full.exists() and thumb.exists()):
            im = im.convert("RGB")
            im.save(full, "WEBP", quality=FULL_QUALITY, method=6)
            im.thumbnail((THUMB_WIDTH, THUMB_WIDTH * height // width))
            im.save(thumb, "WEBP", quality=THUMB_QUALITY, method=6)
    return path.stem, media_id, width, height, len(data), full.stat().st_size, thumb.stat().st_size


def main():
    FULL.mkdir(parents=True, exist_ok=True)
    THUMB.mkdir(parents=True, exist_ok=True)
    sources = sorted(SOURCE.glob("*.png"))
    print(f"Converting {len(sources)} screenshots…")
    with ProcessPoolExecutor() as pool:
        results = list(pool.map(convert, sources, chunksize=8))

    MAP_FILE.write_text(json.dumps({stem: mid for stem, mid, *_ in results}, indent=1), encoding="utf-8")
    media = {mid: (full, thumb) for _, mid, _w, _h, _png, full, thumb in results}

    png_total = sum(r[4] for r in results)
    full_total = sum(m[0] for m in media.values())
    thumb_total = sum(m[1] for m in media.values())
    print(f"{len(results)} screenshots → {len(media)} unique images. "
          f"PNG {png_total / 1e9:.2f} GB → full {full_total / 1e6:.0f} MB + thumbnails {thumb_total / 1e6:.0f} MB")


if __name__ == "__main__":
    main()
