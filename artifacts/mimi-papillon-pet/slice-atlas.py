#!/usr/bin/env python3
"""Slice the Codex v2 sprite atlas into per-state animations for CodeShell.

Reads spritesheet-v2.webp + pet_request.json (row → state → frame count) and
writes, into the renderer asset dir:
  - one animated WebP per looping state (idle/running/review/waiting/waving/
    jumping/failed) — drop-in like the existing gifs, keeps transparency
  - per-frame PNGs for running-right / running-left (the drag loops, cycled
    frame-by-frame in code so we can pick direction)

Idempotent: rewrites the same output files each run.
"""
import json
import os
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
ATLAS = os.path.join(
    REPO, "packages/desktop/src/renderer/assets/mimi-papillon/spritesheet-v2.webp"
)
REQUEST = os.path.join(HERE, "pet_request.json")
OUT = os.path.join(REPO, "packages/desktop/src/renderer/assets/mimi-papillon")

# Per-state playback speed (ms/frame). Calmer states play slower.
FRAME_MS = {
    "idle": 180,
    "running": 110,
    "review": 160,
    "waiting": 180,
    "waving": 130,
    "jumping": 110,
    "failed": 130,
}
# States exported as looping animated WebP (name → same name used in code).
ANIM_STATES = set(FRAME_MS)
# States exported as per-frame PNG sequences (directional drag).
FRAME_SEQ_STATES = {"running-right": "run-right", "running-left": "run-left"}


def load_rows():
    req = json.load(open(REQUEST))
    atlas = req["atlas"]
    return req["rows"], atlas["cell_width"], atlas["cell_height"]


def cell(img, cw, ch, row, col):
    box = (col * cw, row * ch, (col + 1) * cw, (row + 1) * ch)
    return img.crop(box)


def main():
    atlas = Image.open(ATLAS).convert("RGBA")
    rows, cw, ch = load_rows()
    written = []
    for r in rows:
        state, row, n = r["state"], r["row"], r["frames"]
        frames = [cell(atlas, cw, ch, row, c) for c in range(n)]
        if state in ANIM_STATES:
            out = os.path.join(OUT, f"anim-{state}.webp")
            frames[0].save(
                out,
                save_all=True,
                append_images=frames[1:],
                duration=FRAME_MS[state],
                loop=0,
                disposal=2,
                lossless=True,
            )
            written.append(os.path.relpath(out, REPO))
        elif state in FRAME_SEQ_STATES:
            base = FRAME_SEQ_STATES[state]
            for i, fr in enumerate(frames, 1):
                out = os.path.join(OUT, f"{base}-{i}.png")
                fr.save(out)
                written.append(os.path.relpath(out, REPO))
    print("wrote:")
    for w in written:
        print("  " + w)


if __name__ == "__main__":
    main()
