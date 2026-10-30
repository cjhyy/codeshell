# Mimi character pack guideline

How Mimi's computer-use performance is drawn, and how to change or replace the character without touching execution, the stage model or the choreographer. Reference effect: the anime-mascot computer-use clip from 2026-10-26 (see the design doc §11). Window and control edges are floors, and each action is a physical move.

## 1. Layers and what a pack owns

```
CUA execution ─▶ activity events ─▶ choreographer ─▶ stage model ─▶ renderer (character pack)
                 (content-free)      (gesture state)   (where, perch,   (which frames, how big,
                                                        working size)    which way, contact)
```

- The **stage model** (`src/main/computer-use/stage-model.ts`) decides where the character stands and on what. It outputs `position`, `perch` and `size`. The perch is one of `on-field`, `on-baseline`, `title-bar`, `beside-target` or `screen-corner`. A character change never edits it.
- The **character pack** decides how that stance is drawn: which move, which frames, how big relative to the base art, which way it faces, and on which frame it makes contact. It is pure data plus one atlas.
- The **renderer** (`src/renderer/pet/live2d/SpriteActor.tsx`) reads the pack through `character-pack.ts`. A move the pack lacks falls back to the base atlas, so a partial pack is always valid.

## 2. Geometry contract

All art uses 192×208 cells. These numbers are shared through `COMPANION_CELL` in `src/shared/mimi-companion.ts`:

| Constant                  | Value                                            | Meaning                                                       |
| ------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| Cell                      | 192×208                                          | Every atlas, base or pack                                     |
| Base feet line            | y = 203                                          | Where the base atlas's feet rest; packs are aligned to it     |
| Sprite box                | 70% of the character height wide, aspect 192/208 | Set by CSS                                                    |
| `COMPANION_SPRITE_BOTTOM` | 25 px                                            | Room under the sprite for the action label                    |
| `companionFeetOffset(h)`  | 25 + margin under feet                           | The stage model grounds on this; keep it in sync with the CSS |
| `WORK_SCALE`              | 0.55                                             | Size while standing on a control                              |

A pack move whose feet sit elsewhere declares `feetY`. The renderer shifts and scales the frame about the base feet line, so the art never needs re-registering.

## 3. Moves

| Move       | When (perch + action)                            | Frames | Kind     | Contact | Facing | Art direction                                                                                                          |
| ---------- | ------------------------------------------------ | ------ | -------- | ------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `sit-type` | `on-field` + type, key or click into a field     | 6      | loop     | —       | front  | Seated on a ledge (the cell's bottom edge is the field's top edge), hind paws dangling, front paws tapping alternately |
| `kick`     | `on-baseline` + click on a button                | 5      | one-shot | 2       | right  | Crouch, wind-up, leg fully extended right on contact, follow-through, settle                                           |
| `poke`     | `on-baseline` + click on a link                  | 4      | one-shot | 2       | right  | Lean, raise paw, paw straight out right on contact, return                                                             |
| `lie-wait` | `title-bar` while idle (waiting between actions) | 6      | loop     | —       | front  | Belly on the ledge, chin on paws, slow tail wag and blink                                                              |

Rules for any new move:

- Bind it to a perch the stage model already produces; add the trigger in `packMove` and a test in `character-pack.test.ts`.
- One-shot moves should declare a `contact` frame. The renderer fires the impact burst on it, and the cue lasts `frames × frameMs + 200 ms`.
- Draw `right`-facing art when the move has a direction; the renderer mirrors it toward a target on the left. Only mirror art whose identity survives a flip. Mimi's red cheek patch switches cheeks, which is accepted for her. A character with asymmetric text or a logo needs a separate left row.
- Keep effects out of the art: no speed lines, dust or shadows. Effects are CSS (`.mimi-impact`, `.mimi-companion--dash-*`) so every character gets them.

## 4. Manifest (`performer-pack.json`)

```json
{
  "version": 1,
  "atlas": "performer-v1.webp",
  "columns": 8,
  "rows": 4,
  "cell": { "width": 192, "height": 208 },
  "moves": {
    "kick": {
      "row": 1,
      "frames": 5,
      "frameMs": 110,
      "loop": false,
      "contact": 2,
      "feetY": 186,
      "scale": 1.25,
      "facing": "right"
    }
  }
}
```

`parseCharacterPack` validates it strictly. It enforces cells of exactly 192×208, rows and frames within the atlas, `contact` before the last frame, `frameMs` 40–1000, `scale` 0.5–2, and a `facing` of `front` or `right`. A pack that fails is a build error, never a silent fallback.

Measure `scale` so that heads stay the same size as in the base idle frame. Compare a front-facing frame's ear span against the base idle frame (133 px for Mimi), or eyeball it with `assemble.py check`. Measure `feetY` as the lowest opaque row of a planted frame; `assemble.py atlas` prints it.

## 5. Regenerating or extending Mimi

Requires a signed-in `codex` CLI with the `hatch-pet` and `imagegen` skills; the base atlas came from the same pipeline.

```sh
cd packages/desktop
RUN=/tmp/mimi-pack-run
scripts/mimi-pack/generate.sh "$RUN"             # or name moves: generate.sh "$RUN" kick
# review $RUN/decoded/*.png: frame count, identity, flat green background
python3 scripts/mimi-pack/assemble.py atlas --run "$RUN"   # writes the atlas, prints feetY
python3 scripts/mimi-pack/assemble.py check --run "$RUN"   # scale-check.png on one floor
```

- `prompts/<move>.txt` holds the art direction for each move. To add a move, add its prompt, a manifest entry and a `packMove` trigger.
- Every strip is grounded on `refs/base.png` (base idle cell) and `refs/style-sheet.png` (six base cells). Never generate a strip from text alone.
- Regenerate a whole row, never single cells, so a row stays one generation.

## 6. Replacing the character

**Another sprite character.**

1. Create its base 8×11 atlas with `hatch-pet` (rows idle … review plus 16 look directions).
2. Replace `spritesheet-v2.webp`.
3. Edit `STYLE_CELLS` in `assemble.py` if its best reference cells differ, and rewrite the identity sentence in `prompts/*.txt`.
4. Run section 5 and update `feetY` and `scale`.
5. Keep the move names. The stage model and choreographer do not change.

**A different renderer (Live2D, 3D, video).** Implement a `CharacterRenderer` (`character-renderer.ts`) with its own `Actor` and `EffectSet`.

- The Actor receives the same `CharacterActorProps`. That includes `state.perch` for the surface and `state.size` for the working size, already scaled. It also receives `onContact` to fire the impact burst.
- Map the four moves to authored motions. Unsupported actions degrade through `EffectSet.fallback`.
- Keep the feet line contract: the renderer must put the feet `companionFeetOffset(size)` above the box bottom, or the stage model's grounding breaks.

## 7. QA checklist before shipping a pack

- [ ] `bun test ./src/renderer/pet/ ./src/main/computer-use/stage-model.test.ts` passes. The bundled pack is parsed by `character-pack.test.ts`.
- [ ] In `scale-check.png`, every move's feet are on the floor and heads match the idle frame.
- [ ] No green fringe on ears or tail. Re-run despill, or regenerate the row.
- [ ] Mirrored `right` moves still read as the same character.
- [ ] On a real machine, composite the real app screenshot with the overlay (the probe in the design doc §11). Check that the character sits on field corners, stands on button baselines, and its label clears the control.

## 8. Known gaps

- **Contact timing.** The contact frame plays after the character arrives, and real input usually lands earlier: execution never waits for presentation. True contact sync needs the proxy to announce an action before forwarding its input and allow a bounded lead time.
- **Window transitions.** Entrances and exits between windows (the clip's "carry the switch") are not implemented. A cross-display trip still hops.
- **Props by meaning.** Props such as scissors or a stamp would be extra moves bound to new actions. The execution events do not carry that meaning yet.
