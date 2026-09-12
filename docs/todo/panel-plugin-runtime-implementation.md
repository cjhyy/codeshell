# Panel plugin runtime release acceptance

Scope: finish Video Studio plugin ownership and the generic Host interfaces needed by it, then publish compatible Panel and CodeShell versions. Unrelated ongoing branches and dirty work are excluded.

Published versions: CodeShell 0.9.11 / API 14 and Video Studio 0.5.0. Implementation, local acceptance and publication verification are complete.

## Implementation and acceptance

- [x] Installed native tool declarations validate content hashes at review/install; process entry grants bind the reviewed package revision and executable.
- [x] Generic resources preserve existing asset identifiers, bound-project scopes and storage layout; support binary uploads, direct materialization and atomic capture; reject revoked/symlink/identity changes. Temporary directory identity pins are released with the grant.
- [x] Process receipts, sequence cursors, bounded stdin, and cancellation confirmation work after event loss; cancellation waits for actual process exit.
- [x] Desktop and Web advertise actual permissions, method availability, transport limits and stable error categories. The Panel SDK handles admission, structured errors and event reconciliation.
- [x] Opt-in Desktop background tool jobs persist input/receipts independently of a visible guest. The Panel selects retry policy; updates/revocation stop execution; older revisions retain read-only history.
- [x] Video inspection, proxies, frames, waveforms, silence/scenes, transcription, rendering, audio extraction/enhancement, TTS installation/inference, templates and project rules run in Panel tools.
- [x] Existing resource IDs, documents, preview URLs and task history remain accessible. Legacy Host execution methods are removed; bounded safe recipes allow the Panel to rebuild supported historical requests.
- [x] Real FFmpeg processing passes through the Panel browser bridge, reviewed installed entry, generic task executor and direct resource transport. The test imports a generated five-second H.264/AAC clip, inspects and prepares it, then captures a non-silent three-second 48 kHz mono WAV. Reopening reuses persisted inspection/task results; another project is denied; all process owners are released.
- [x] Natural-Chinese Audio8 inference passes in the independently packaged native CLI. Its synthetic reference is identified as such; it does not establish user voice likeness or replace complete Panel UI validation.
- [x] Local Host package-release smoke validates 10 tarballs, 47 typed entry points and 45 runtime entry points. Resource/media compatibility and isolated Desktop bridge checks pass. Further changes must rerun their affected gates.
- [x] Final Panel UI fixture migration, release build/source parity and aggregate release gates pass. UI: 35/35; local media: 28/28; Linux media: 27 passed plus one macOS-only speech case skipped; offline Video tests: 222/222.
- [x] Updated Panel and CodeShell release artifacts are published; remote versions, digests and CI are verified.

## Evidence and remaining scope

Validation used isolated worktrees: `/tmp/codeshell-plugin-runtime-20260913` and `/tmp/codeshell-video-studio-release-20260913`. The ignored Host artifact directory `artifacts/video-studio/plugin-runtime-validation/` contains the local bridge/executor runner, generated reference WAV and `evidence.json` for the real FFmpeg chain. Its observed runtime is a single local measurement, not a performance guarantee.

The prior published Video Studio 0.4.7 is the compatibility baseline for this completed migration. Full Web adaptation of Desktop-only native Panel workflows, remote native-window selection and other Hub work remain separate TODO items; API 14 discovery must keep unsupported Web methods absent.

## Published evidence

- [CodeShell 0.9.11](https://github.com/cjhyy/codeshell/releases/tag/v0.9.11), release commit `7ec494f7236036b2ee4b7d5baf91bcfb5ae191d5`: [main CI](https://github.com/cjhyy/codeshell/actions/runs/34710235108) passes all nine jobs; [release workflow](https://github.com/cjhyy/codeshell/actions/runs/34710237530) passes all seven jobs. Fourteen public assets cover macOS ARM64/x64, Windows and Linux. All three updater manifests identify 0.9.11; manifest hashes and listed target sizes were checked. All ten npm packages report 0.9.11 for the exact version and latest tag.
- [Video Studio 0.5.0](https://github.com/cjhyy/codeshell-panel-apps/releases/tag/video-studio-v0.5.0), release commit `3d86cc6adc6b454f47b60fac18d77458c1f52e36`: [complete candidate CI](https://github.com/cjhyy/codeshell-panel-apps/actions/runs/34711359283) passes types, deterministic builds, media, offline suites, UI, large documents and fidelity checks. The public main/tag manifests match the reviewed package byte for byte.
- The downloaded `video-studio-0.5.0.zip` is 2,525,818 bytes with SHA-256 `f224dcb37d6b77035648d787853a20bf38df3643936ea91341448e67a6d33628`. Its 21 files include the tracked installable package and MIT license; both native-entry digests and the ZIP contents were verified after download. It includes the existing public demo narration, but no personal recordings, experimental audio, model weights or development dependencies.

Install CodeShell first, then update the Panel from its source or use the [published install directory](https://github.com/cjhyy/codeshell-panel-apps/tree/video-studio-v0.5.0/panels/video-studio). Future model and media-tool changes belong to the independently versioned Panel.
