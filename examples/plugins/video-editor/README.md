# CodeShell Video Editor plugin

This is a local-first video editing plugin for CodeShell. It combines:

- a `video-editor` skill for planning, reviewing, and executing edits;
- a `/video-editor:edit <input> "<request>"` command that expands into a
  review-first edit draft in the Desktop composer;
- a dependency-free Node.js wrapper around `ffprobe` and `ffmpeg`;
- a sandboxed CodeShell right-dock panel that submits a structured edit request
  to the current agent session;
- a read-only daily audit automation template that users can review and create
  explicitly for a project.

The plan supports hard cuts or bounded video/audio crossfades between selected
clips, in addition to reframing, speed, volume, subtitles, and encoding.

The standard `.codex-plugin/plugin.json` stays Codex-valid. CodeShell-only panel
permissions live in `.codeshell-plugin/plugin.json`, so the package can be
inspected by either host without adding foreign fields to the Codex manifest.
That overlay also carries the scheduled-task template. Installing or updating
the plugin never creates a task.

## Install

From the CodeShell Desktop extensions page, choose **Install local plugin** and
select this directory. From the CLI:

```bash
code-shell plugin install ./examples/plugins/video-editor --name video-editor
```

The host machine must have `ffmpeg` and `ffprobe` available on `PATH`. The skill
checks them before editing and never installs system packages without asking.
The wrapper invokes both programs directly without a shell. It rejects
non-regular or symbolic-link inputs/subtitles, output symlinks and special
files, symbolic-link output-directory ancestors, unsafe encoding identifiers,
and accidental output aliases before rendering. Subtitle burning additionally
requires an FFmpeg build that exposes the `subtitles` filter (normally provided
through libass); the `check` command reports this optional capability.

## Quick smoke test

```bash
node skills/video-editor/scripts/video-editor.mjs check
node skills/video-editor/scripts/video-editor.mjs probe --input ./sample.mp4
node skills/video-editor/scripts/video-editor.mjs render --plan ./edit-plan.json --dry-run
node skills/video-editor/scripts/video-editor.mjs frames \
  --input ./output.mp4 --output ./qa-frames --at "0.5,3,7.5" --dry-run
```

In CodeShell Desktop, type `/video-editor:edit` to discover the command. Pressing
Enter expands it into the composer for review; it does not automatically send
or render anything.

The plugin detail page shows the full `daily-edit-audit` prompt, schedule,
workspace, and permission level. Choosing **Use template** creates a normal
CodeShell automation only after confirmation. Its content revision and plugin
source are recorded for audit, while the copied task remains independent if the
plugin is later updated or removed.

See `skills/video-editor/references/plan-schema.md` for the edit-plan format.
