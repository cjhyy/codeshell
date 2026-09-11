# Panel managed media API (v12)

`media` is an opt-in Panel permission and requires `context.workspace`. Desktop owns file access, processors and persistent jobs; Core only validates the generic permission. Video Studio remains an independently built Panel package with a static bundled Skill. No arbitrary executable backend is installed with a Panel.

## Scope and storage

Every request uses the Host binding's app ID and project path. Guest input cannot select another scope. Native file dialogs authorize external files; workspace imports additionally require `workspace.read`, accept relative paths and reject traversal, hidden paths and symlink escapes. Originals are streamed into immutable content-addressed storage. IPC carries IDs and JSON, not video bytes.

Data lives under the user's Desktop data directory, `panel-app-media/scopes/<scope hash>`. A managed asset ID is `asset-<SHA-256>`. Derivatives and render outputs are also managed assets; source paths remain Host-private. Jobs use separate attempt directories and stable processor caches. Asset responses include `id`, `name`, `mimeType`, `bytes`, `sha256` and `createdAt`.

Preview an asset using a same-origin URL: `new URL('/media/' + assetId, location.href)`. The `cspanel` protocol checks the prepared partition, app permission and current binding, then streams GET/HEAD with byte ranges. It does not enable arbitrary network or filesystem URLs. The Core `Panel` tool already supports bounded raster image results, allowing a Panel to return an actual keyframe to a vision-capable model.

## Calls

| Method                                   | Parameters                                                      | Result                                                                                      |
| ---------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `media.status`                           | none                                                            | FFmpeg, local Whisper and HyperFrames availability; no installation side effects            |
| `media.tts.voices`                       | none                                                            | Available models, model-specific voices and default model; legacy local voice fields remain |
| `media.tts`                              | `{text, modelId?, voiceId?, rate?, instructions?}`              | Durable job producing a real managed WAV voiceover                                          |
| `media.import`                           | none for native picker; `{paths: string[]}` for workspace files | Durable import job, or `{cancelled: true}`                                                  |
| `media.assets.list`                      | `{offset?, limit?}`                                             | `{assets, total}`; maximum 100 per page                                                     |
| `media.assets.get`                       | `{id}`                                                          | `{asset, preparation}`                                                                      |
| `media.prepare`                          | `{assetIds, transcribe?}`                                       | `{jobs}`; one preparation job per source                                                    |
| `media.transcribe`                       | `{assetId, language?}`                                          | Timed-transcription job                                                                     |
| `media.transcript`                       | `{assetId, offset?, limit?}`                                    | Source-time transcript segments and words; maximum 100 segments per page                    |
| `media.analysis`                         | `{assetId, kind: 'silence' \| 'scenes', offset?, limit?}`       | Paged complete detector intervals or scene-cut times                                        |
| `media.scene`                            | `{params}`                                                      | HyperFrames chapter/explainer render job                                                    |
| `media.render`                           | `{project, sources?}`                                           | MP4 export job; `sources` maps portable project asset IDs to managed IDs                    |
| `media.jobs.list`                        | `{offset?, limit?}`                                             | `{jobs, total}`; maximum 50, excludes large results                                         |
| `media.jobs.get`                         | `{id}`                                                          | Job including bounded result or error                                                       |
| `media.jobs.cancel` / `media.jobs.retry` | `{id}`                                                          | Updated job                                                                                 |
| `media.export`                           | `{assetId}`                                                     | Native save dialog followed by file copy; `{saved, name}` or cancellation                   |
| `media.reveal`                           | `{assetId}`                                                     | Reveal the managed file in the system file browser                                          |
| `media.document.get`                     | `{key, revision?}`                                              | `{revision, data}`; revision 0 and null data means absent                                   |
| `media.document.set`                     | `{key, baseRevision, data, label?}`                             | New document revision; stale concurrent writes fail                                         |
| `media.document.versions`                | `{key}`                                                         | Latest 20 immutable version descriptors                                                     |

Documents allow 2 MiB each and are independent of the small `storage` namespace. Writes preserve existing data if validation, revision checks or disk writes fail. Document revision and the editor's project revision are separate counters. A historical version can be read and saved as a new current version; old revision numbers are never reused.

Scene parameters: `kind: 'chapter' | 'explainer'`, `title`, optional `subtitle`, `eyebrow`, up to four `bullets`, `durationSeconds` (0.5–60), even `width`/`height`, and `palette: {background, foreground, accent}` using six-digit hex colors. Generated sources and parameters stay editable in Host storage. The adapter also supports importing an existing authorized HyperFrames project; the current Panel bridge exposes parameterized scenes.

## Processing and lifecycle

Preparation starts with a real stream inspection. Images get orientation-aware thumbnails. Video gets a 30 fps proxy and scene-boundary detection; video with sound and audio sources get waveform and silence analysis. Optional ASR extracts mono 16 kHz audio and runs local Whisper with sentence and word timestamps. Complete long analyses stay in private JSON files with paged access; bounded job summaries explicitly report truncation.

`media.job.changed` publishes scoped job updates. States are `queued`, `running`, `succeeded`, `failed`, and `cancelled`. Closing a Panel does not cancel these jobs. Desktop starts recovery after warming workspace trust; orderly Host shutdown terminates child processes and preserves recovery state. Restart-safe processors can restart interrupted attempts; other processors report an interruption. Cancellation wins over late processor results. Retrying a failed job is explicit.

Repeated preparation and transcription requests share an active job. A request after completion starts a fresh job that validates the processor cache, including tool and processor versions, before reusing artifacts. Revoking the Panel cancels its jobs across all project scopes, even when no guest window remains open.

Export accepts the editor's 30 fps source ranges, primary sequence, independent audio clips and timed captions. It builds H.264/AAC MP4 with explicit duration/stream validation. The native Chromium caption renderer matches the Panel canvas's Unicode font shaping, wrapping and subtitle background. A single timed transparent image track handles all subtitles without opening one FFmpeg input per sentence. Empty captions produce no SRT artifact. MP4 playback and export use the same managed media protocol.

FFmpeg and ffprobe are local dependencies. Local ASR currently needs the `whisper` executable and cached `~/.cache/whisper/base.pt`; it does not silently download models or send media to a cloud provider. HyperFrames needs Node, its CLI and bundled Chrome. Dependency status distinguishes these capabilities. The first render surface supports cuts, still images, audio gain/mixing and captions; crop, speed, arbitrary effects and editable reconstruction of arbitrary HTML scenes are not silently approximated.

The local model `macos-say` appears as **macOS 系统配音**. It uses installed macOS voices and FFmpeg without an API account or model download; other platforms report it unavailable. Plain text is limited to 6,000 characters, `rate` to 0.5–2 (default 1), and `voiceId` to an installed voice. It does not support style instructions. Text is passed through a private file, never interpreted as a command. Cancellation terminates generation; restart-safe local jobs and verified voice/text/rate/tool-version caches use the existing media lifecycle.

### Online voice models

In Desktop **Settings → Connections → 文字配音**, add an **OpenAI 文字配音** connection, choose its model and credential, then set default voice, rate and optional style. A compatible OpenAI credential can be shared with another connection. These connections use the dedicated `speech` tag and `defaults.speech`; the `audio` tag and dictation default remain independent. A custom model catalog may describe another provider only if it actually implements the same `/audio/speech` binary WAV contract; chat API compatibility alone is insufficient.

`media.tts.voices` adds `models` and `defaultModelId`. Each model exposes only `id`, `name`, `provider`, `available`, optional `reason`, `voices`, `defaultVoiceId`, `maxTextLength` and `supportsInstructions`. Online choices come from usable configured connections, and require local FFmpeg/ffprobe to save validated audio. Model IDs bind the configured connection, remote model and endpoint. URLs and credentials never cross the Panel bridge or enter persisted job input. New requests without `modelId` use the configured speech default, or macOS when no valid default exists; an explicit `macos-say` always stays local. Already persisted `tts` jobs keep the local processor regardless of later settings changes.

Online input is limited to 4,096 characters and 0.5–2 speed. Style instructions are limited to 2,000 characters; omitting them uses the connection default, while `""` explicitly clears it. `gpt-4o-mini-tts` supports style instructions; `tts-1` and `tts-1-hd` do not. Voices are validated against the selected model. The Host freezes selected parameters before queuing and revalidates the connection before calling the provider. Successful results contain `{asset, inspection, speech: {text, voiceId, engine, rate, modelId?, instructions?}}` with no Host paths. Audio is a validated 48 kHz mono WAV, playable and editable on an independent track and included in MP4 export.

Online `tts-online` jobs support cancellation and bounded timeouts, refuse redirects, cap downloaded WAV data at 64 MiB and decoded duration at ten minutes, and avoid provider response bodies in errors. An interrupted online request becomes failed after restart and requires explicit retry, because retrying may incur another provider charge. No remote generation is triggered by listing models. Automated tests use local mock HTTP responses and real audio conversion, without a live API key. The wire format and built-in models follow the official [speech API](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create) and [text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech).

The Panel's default demonstration includes a packaged Chinese narration MP3. It uses the same audio playback/export path as other local sources; it is not browser speech playback that disappears from an exported recording.

## Verification

From the repository root:

```sh
bun test packages/desktop/src/main/media packages/desktop/src/main/panel-app-protocol.test.ts packages/desktop/src/main/panel-app-permissions.test.ts
CODESHELL_MEDIA_TEST_ASR=1 bun test packages/desktop/src/main/media/media-processors.test.ts
```

From `packages/desktop`, `bun run smoke:video-media` runs a real Electron/FFmpeg check. It creates Chinese captions and a separate audio track, exports MP4 and SRT, loads the MP4 through the actual `cspanel` Range handler, seeks caption and gap frames, and verifies readable canvas pixels. Evidence and frame images are written to `artifacts/video-studio/native-render`. The native smoke is explicit because it needs a working desktop display; FFmpeg integration tests skip when the dependency is absent.

`bun run smoke:video-production` exercises the complete native production path: real speech transcription, preprocessing and cache reuse, a rendered HyperFrames chapter, word-timed Chinese captions, independent background music, MP4 export and reopened media. Outputs and machine-readable evidence are written to `artifacts/video-studio/production-smoke`. This check uses a deterministic edit plan; it does not claim to run a configured language model. Panel tests separately cover the Skill task contract and automatic workflow state.
