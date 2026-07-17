# Video edit plan schema

```json
{
  "input": "/absolute/source.mp4",
  "output": "/absolute/export.mp4",
  "overwrite": false,
  "clips": [
    { "start": "00:00:02.500", "end": "00:00:08.000" },
    { "start": 12.25, "end": 18.0 }
  ],
  "video": {
    "aspect": "9:16",
    "fit": "cover",
    "width": 1080,
    "height": 1920,
    "fps": 30,
    "speed": 1.0,
    "transition": {
      "type": "fade",
      "duration": 0.25
    }
  },
  "audio": {
    "mute": false,
    "volume": 1.0
  },
  "subtitles": {
    "path": "/absolute/captions.srt"
  },
  "encoding": {
    "videoCodec": "libx264",
    "audioCodec": "aac",
    "crf": 18,
    "preset": "medium"
  }
}
```

## Fields

- `input`, `output`: required paths. Relative paths resolve from the plan file.
- `overwrite`: default `false`.
- `clips`: optional ordered ranges, capped at 256. Omit to keep the whole source.
- Time values: non-negative seconds or `HH:MM:SS.mmm` / `MM:SS.mmm`.
- `video.aspect`: `original`, `16:9`, `9:16`, `1:1`, or `4:5`.
- `video.fit`: `cover` or `contain`; used only when output dimensions exist.
- `video.width` + `video.height`: optional even integers. Both are required
  together, and each is capped at 16384. They override the aspect defaults.
- `video.fps`: optional positive number.
- `video.speed`: `0.25` through `4`. Audio tempo is chained safely.
- `video.transition.type`: `cut` (default) or `fade`. A fade requires at least
  two clips and crossfades both video and preserved audio.
- `video.transition.duration`: fade duration in seconds, `0.01` through `5`
  (default `0.25`). Every participating clip must be longer than the duration.
- `audio.mute`: omit audio from the output.
- `audio.volume`: `0` through `10`.
- `subtitles.path`: optional SRT/ASS/VTT-compatible subtitle file to burn in.
  Burning requires FFmpeg's optional `subtitles` filter/libass support; use the
  wrapper's `check` command to inspect availability.
- `encoding.crf`: `0` through `51`; lower is higher quality.
- `encoding.preset`: an FFmpeg encoder preset such as `medium`.
- Encoding codec/preset values are identifiers capped at 64 characters. They
  may contain letters, numbers, dots, underscores, and hyphens, but may not
  begin with a hyphen.

All plan paths are capped at 4096 characters and reject control characters.
Inputs, subtitle files, and plan files must be ordinary files rather than
directories, devices, pipes, or symbolic links. Existing output symlinks,
special files, multiply-linked files, and output paths whose existing directory
chain contains a symbolic link are never written, even when `overwrite` is
enabled.

The editor rejects invalid ranges, ranges beyond the probed duration, missing
inputs or video streams, missing subtitle files, odd output dimensions, and
accidental overwrites. A successful render must leave a non-empty ordinary
single-link output containing a video stream. Plan files are capped at 1 MiB.

Visual-QA frame extraction is a separate CLI operation rather than part of the
render plan:

```bash
video-editor.mjs frames \
  --input /absolute/export.mp4 \
  --output /absolute/qa-frames \
  --at "0.5,00:03,00:07.5" \
  --dry-run
```

`--at` accepts 1–24 comma-separated timecodes. Existing frame files are
protected unless `--overwrite` is explicitly supplied. The frame output
directory and existing frame files must not be symbolic links.
