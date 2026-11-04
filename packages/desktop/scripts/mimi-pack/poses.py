#!/usr/bin/env python3
"""Key poses: generated full-body illustrations -> cut-out webp + measurements.

  PACK_CHARACTER=shiro poses.py cut --run DIR      decoded/<pose>.png -> assets/<character>/poses/
  PACK_CHARACTER=shiro poses.py sheet --run DIR    contact sheet with each pose's anchor marked

`cut` keys out the flat #00FF00 background, crops to the figure, scales it to
POSE_HEIGHT and despills the edges with hatch-pet's script. It prints each
pose's size and its lowest opaque row (the feet, seat or belly line) so the
anchors in poses.json can be checked. See the character pack guideline.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

from PIL import Image, ImageDraw

DESKTOP = Path(__file__).resolve().parents[2]
CHARACTER = os.environ.get("PACK_CHARACTER", "shiro")
ASSETS = DESKTOP / "src/renderer/assets" / CHARACTER
HATCH_PET = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "skills/hatch-pet/scripts"
POSE_HEIGHT = 640
PAD = 6


def key(image: Image.Image) -> Image.Image:
    """Alpha from how much greener than red/blue a pixel is."""
    rgba = image.convert("RGBA")
    pixels = rgba.load()
    for y in range(rgba.height):
        for x in range(rgba.width):
            r, g, b, _ = pixels[x, y]
            green = g - max(r, b)
            alpha = 255 if green < 40 else 0 if green > 110 else round(255 * (110 - green) / 70)
            pixels[x, y] = (r, g, b, alpha)
    return rgba


def cut(run: Path) -> None:
    out_dir = ASSETS / "poses"
    out_dir.mkdir(parents=True, exist_ok=True)
    work = run / "cut"
    work.mkdir(exist_ok=True)
    for source in sorted((run / "decoded").glob("*.png")):
        keyed = key(Image.open(source))
        box = keyed.getchannel("A").point(lambda a: 255 if a > 24 else 0).getbbox()
        if not box:
            raise SystemExit(f"{source.name}: nothing left after keying")
        left, top, right, bottom = box
        keyed = keyed.crop((max(0, left - PAD), max(0, top - PAD), right + PAD, bottom + PAD))
        scale = POSE_HEIGHT / keyed.height
        keyed = keyed.resize((round(keyed.width * scale), POSE_HEIGHT), Image.LANCZOS)
        raw = work / source.name
        keyed.save(raw)
        subprocess.run(
            [sys.executable, str(HATCH_PET / "despill_chroma_edges.py"), str(raw),
             "--output", str(work / f"{source.stem}.clean.png"),
             "--webp-output", str(out_dir / f"{source.stem}.webp"), "--chroma-key", "#00FF00"],
            check=True, capture_output=True,
        )
        alpha = keyed.getchannel("A")
        lowest = alpha.point(lambda a: 255 if a > 128 else 0).getbbox()[3]
        row = [x for x in range(keyed.width) if alpha.getpixel((x, lowest - 2)) > 128]
        centre = round(sum(row) / len(row)) if row else keyed.width // 2
        print(json.dumps({"pose": source.stem, "width": keyed.width, "height": keyed.height,
                          "lowest": lowest, "lowestCentreX": centre}))


def sheet(run: Path) -> None:
    library = json.loads((ASSETS / "poses.json").read_text())
    cells = []
    for name, pose in library["poses"].items():
        image = Image.open(ASSETS / "poses" / pose["file"]).convert("RGBA")
        canvas = Image.new("RGBA", image.size, (232, 236, 242, 255))
        canvas.alpha_composite(image)
        draw = ImageDraw.Draw(canvas)
        ax, ay = pose["anchor"]["x"], pose["anchor"]["y"]
        draw.line((0, ay, canvas.width, ay), fill=(230, 60, 90, 255), width=3)
        draw.ellipse((ax - 8, ay - 8, ax + 8, ay + 8), outline=(230, 60, 90, 255), width=3)
        draw.text((10, 10), name, fill=(20, 20, 20, 255))
        cells.append(canvas.resize((round(canvas.width * 0.5), round(canvas.height * 0.5))))
    width = sum(c.width for c in cells) + 10 * (len(cells) + 1)
    out = Image.new("RGBA", (width, max(c.height for c in cells) + 20), (255, 255, 255, 255))
    x = 10
    for c in cells:
        out.alpha_composite(c, (x, 10))
        x += c.width + 10
    out.save(run / "pose-sheet.png")
    print(run / "pose-sheet.png")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=("cut", "sheet"))
    parser.add_argument("--run", required=True, type=Path)
    args = parser.parse_args()
    {"cut": cut, "sheet": sheet}[args.step](args.run.resolve())


if __name__ == "__main__":
    main()
