---
description: Inspect, plan, review, and execute a safe local video edit
argument-hint: <input-video> "<edit request>"
---

Use the `video-editor` skill for this request.

Source video: $1
Requested edit: $2
Original arguments: $ARGUMENTS

First verify that FFmpeg and FFprobe are available, probe the source, and create
a reproducible JSON edit plan. Run the bundled editor with `--dry-run`, explain
the kept ranges, output format, audio/subtitle changes, and output path, then
wait for confirmation before rendering. Never overwrite the source or an
existing output without explicit approval.
