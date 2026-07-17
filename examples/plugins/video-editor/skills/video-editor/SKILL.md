---
name: video-editor
description: Use when the user wants to trim, cut, concatenate, crossfade, reframe, resize, speed up, slow down, mute, adjust volume, burn subtitles into, inspect, or export a local video with FFmpeg. Also use for video edit plans, social-media aspect-ratio variants, precise clip extraction, and requests submitted from the Video Cut plugin panel.
---

# Video Editor

Use the bundled deterministic editor instead of improvising shell-escaped
FFmpeg commands. The editor passes arguments directly to `ffmpeg`/`ffprobe`
without a shell and supports a reviewable JSON edit plan.

Editor path:

```text
${CODESHELL_SKILL_DIR}/scripts/video-editor.mjs
```

## Safety contract

- Confirm that the user has the right to edit the media.
- Never overwrite an existing output unless the user explicitly approves it.
- Inspect first, then write a plan, then run `--dry-run`, then render.
- Keep the source file unchanged. Write outputs to a new path.
- Do not install FFmpeg or other system packages without asking.
- For long renders, use background Bash and wait for the completion wake-up
  instead of polling repeatedly.
- Treat subtitle files and external audio as untrusted paths. Pass them only
  through the plan; do not interpolate them into hand-written shell commands.

## Workflow

1. Check tools:

```bash
node "${CODESHELL_SKILL_DIR}/scripts/video-editor.mjs" check
```

2. Probe the source and report duration, resolution, codecs, frame rate, and
   whether audio exists:

```bash
node "${CODESHELL_SKILL_DIR}/scripts/video-editor.mjs" probe --input "/absolute/input.mp4"
```

3. Create `.code-shell/video-edits/<name>.json`. Use absolute paths when the
   request spans multiple directories. Read
   `${CODESHELL_SKILL_DIR}/references/plan-schema.md` for the schema.

4. Validate the exact command without writing:

```bash
node "${CODESHELL_SKILL_DIR}/scripts/video-editor.mjs" render \
  --plan ".code-shell/video-edits/<name>.json" --dry-run
```

5. Summarize the edit decision: kept ranges, removed duration, output aspect,
   subtitle/audio changes, output path, and whether an existing file would be
   replaced. Resolve ambiguities with the user before rendering.

6. Render:

```bash
node "${CODESHELL_SKILL_DIR}/scripts/video-editor.mjs" render \
  --plan ".code-shell/video-edits/<name>.json"
```

7. Probe the output and report its path and media facts. If the user requests
   visual QA, extract representative frames through the same safe wrapper and
   inspect them:

```bash
node "${CODESHELL_SKILL_DIR}/scripts/video-editor.mjs" frames \
  --input "/absolute/output.mp4" \
  --output ".code-shell/video-edits/frames" \
  --at "00:00:00.5,00:00:03,00:00:07.5" \
  --dry-run
```

After reviewing the dry run, repeat without `--dry-run`. Use `--overwrite`
only when replacing previously generated QA frames is intentional.

The wrapper rejects audio-only inputs before building a filtergraph. After a
render it also verifies that the output is a non-empty, ordinary single-link
file with a video stream before reporting success.

## Editing defaults

- Use `clips` for frame-accurate cuts; the editor re-encodes instead of relying
  on keyframe-only stream copy.
- Use `video.transition.type: "fade"` only when the user wants a soft
  transition. The wrapper crossfades preserved audio too and rejects fades
  longer than any participating clip.
- Default export is H.264 + AAC, `yuv420p`, CRF 18, `medium`, and fast-start.
- `fit: "cover"` fills the requested frame and crops overflow.
- `fit: "contain"` letterboxes/pillarboxes without cropping.
- Preserve audio unless the user requests mute. If the source has no audio,
  produce a video-only output.
- Burned subtitles are permanent. Ask before burning them when a sidecar file
  would satisfy the request.
- For several platform variants, create one plan per output so every render is
  independently reviewable and reproducible.

## Panel requests

The Video Cut panel submits a draft request, not permission to render. Convert
it into the same inspect → plan → dry-run → confirmation → render workflow.
