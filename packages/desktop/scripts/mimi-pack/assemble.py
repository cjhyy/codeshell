#!/usr/bin/env python3
"""Deterministic steps of the Mimi character pack pipeline.

  assemble.py refs --run DIR       identity references and layout guides for generate.sh
  assemble.py atlas --run DIR      generated strips -> performer atlas (webp) beside the pack
  assemble.py check --run DIR      scale/feet check sheet against the base atlas

Generation itself is generate.sh (Codex image tool). Extraction and chroma
despill reuse Codex's hatch-pet scripts so cells match the base atlas exactly.
See docs/superpowers/specs/2026-10-30-mimi-character-pack-guideline.md.
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
ASSETS = DESKTOP / "src/renderer/assets/mimi-papillon"
BASE_ATLAS = ASSETS / "spritesheet-v2.webp"
PACK = ASSETS / "performer-pack.json"
HATCH_PET = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "skills/hatch-pet/scripts"
CW, CH, BASE_FEET = 192, 208, 203
KEY = (0, 255, 0, 255)
# Base atlas cells shown to the image model: idle, waving, working, review, run, rest.
STYLE_CELLS = [(0, 0), (3, 2), (7, 2), (8, 3), (1, 3), (5, 4)]


def cell(atlas: Image.Image, row: int, col: int) -> Image.Image:
    return atlas.crop((col * CW, row * CH, (col + 1) * CW, (row + 1) * CH))


def on_key(image: Image.Image, scale: int) -> Image.Image:
    flat = Image.new("RGBA", image.size, KEY)
    flat.alpha_composite(image)
    return flat.resize((image.width * scale, image.height * scale), Image.LANCZOS).convert("RGB")


def refs(run: Path, pack: dict) -> None:
    atlas = Image.open(BASE_ATLAS).convert("RGBA")
    (run / "refs").mkdir(parents=True, exist_ok=True)
    (run / "guides").mkdir(exist_ok=True)
    (run / "decoded").mkdir(exist_ok=True)
    on_key(cell(atlas, 0, 0), 4).save(run / "refs/base.png")
    sheet = Image.new("RGBA", (CW * len(STYLE_CELLS), CH), KEY)
    for i, (r, c) in enumerate(STYLE_CELLS):
        sheet.alpha_composite(cell(atlas, r, c), (i * CW, 0))
    on_key(sheet, 2).save(run / "refs/style-sheet.png")
    for name, move in pack["moves"].items():
        guide = Image.new("RGB", (CW * move["frames"], CH), KEY[:3])
        draw = ImageDraw.Draw(guide)
        for k in range(move["frames"]):
            draw.rectangle((k * CW + 18, 16, (k + 1) * CW - 18, CH - 16), outline=(0, 200, 0), width=2)
            draw.line((k * CW + 18, CH - 16, (k + 1) * CW - 18, CH - 16), fill=(0, 150, 0), width=3)
        guide.save(run / f"guides/{name}.png")


def atlas(run: Path, pack: dict) -> None:
    sys.path.insert(0, str(HATCH_PET))
    import extract_strip_frames as extract  # noqa: E402  (hatch-pet)

    names = list(pack["moves"])
    extract.ROW_FRAME_COUNTS.update({n: pack["moves"][n]["frames"] for n in names})
    sys.argv = ["extract", "--decoded-dir", str(run / "decoded"), "--output-dir", str(run / "frames"),
                "--states", ",".join(names), "--chroma-key", "#00FF00", "--method", "stable-slots"]
    extract.main()
    out = Image.new("RGBA", (CW * pack["columns"], CH * pack["rows"]), (0, 0, 0, 0))
    for name, move in pack["moves"].items():
        for c in range(move["frames"]):
            frame = Image.open(run / f"frames/{name}/{c:02d}.png").convert("RGBA")
            out.alpha_composite(frame, (c * CW, move["row"] * CH))
    raw = run / "performer-raw.png"
    out.save(raw)
    subprocess.run([sys.executable, str(HATCH_PET / "despill_chroma_edges.py"), str(raw),
                    "--output", str(run / "performer.png"), "--webp-output", str(ASSETS / pack["atlas"]),
                    "--chroma-key", "#00FF00"], check=True)
    # Measured feet lines; copy them into the pack when they changed.
    for name, move in pack["moves"].items():
        boxes = [out.crop((c * CW, move["row"] * CH, (c + 1) * CW, (move["row"] + 1) * CH)).getbbox()
                 for c in range(move["frames"])]
        print(f"{name}: feetY(max bottom)={max(b[3] for b in boxes if b)} pack feetY={move['feetY']}")


def check(run: Path, pack: dict) -> None:
    base = Image.open(BASE_ATLAS).convert("RGBA")
    performer = Image.open(ASSETS / pack["atlas"]).convert("RGBA")
    items = [(cell(base, 0, 0), 1.0, BASE_FEET)]
    for move in pack["moves"].values():
        frame = move.get("contact", 0)
        items.append((cell(performer, move["row"], frame), move["scale"], move["feetY"]))
    width, floor = 270, 270
    sheet = Image.new("RGBA", (width * len(items), 300), (235, 238, 242, 255))
    ImageDraw.Draw(sheet).line((0, floor, sheet.width, floor), fill=(90, 90, 90, 255), width=2)
    for i, (image, scale, feet) in enumerate(items):
        scaled = image.resize((round(CW * scale), round(CH * scale)), Image.LANCZOS)
        sheet.alpha_composite(scaled, (i * width + (width - scaled.width) // 2, floor - round(feet * scale)))
    sheet.save(run / "scale-check.png")
    print(run / "scale-check.png")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=("refs", "atlas", "check"))
    parser.add_argument("--run", required=True, type=Path)
    args = parser.parse_args()
    pack = json.loads(PACK.read_text())
    args.run.mkdir(parents=True, exist_ok=True)
    {"refs": refs, "atlas": atlas, "check": check}[args.step](args.run.resolve(), pack)


if __name__ == "__main__":
    main()
