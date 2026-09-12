# Panel plugin runtime release acceptance

Scope: finish Video Studio plugin ownership and the generic Host interfaces needed by it, then publish compatible Panel and CodeShell versions. Unrelated ongoing branches and dirty work are excluded.

Implementation candidates: CodeShell 0.9.11 / API 14 and Video Studio 0.5.0. Status below separates completed local work from release publication.

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
- [ ] Final Panel UI fixture migration, release build/source parity and remaining aggregate release gates pass on the final candidate.
- [ ] Updated Panel and CodeShell release artifacts are published and remote versions, digests and CI are verified.

## Evidence and remaining scope

Authoritative isolated worktrees: `/tmp/codeshell-plugin-runtime-20260913` and `/tmp/codeshell-video-studio-release-20260913`. The ignored Host artifact directory `artifacts/video-studio/plugin-runtime-validation/` contains the reproducible bridge/executor script, generated reference WAV and `evidence.json` for the real FFmpeg chain. Its observed runtime is a single local measurement, not a performance guarantee.

The prior published Video Studio 0.4.7 is a compatibility baseline. These local changes are not yet a published release. Full Web adaptation of Desktop-only native Panel workflows, remote native-window selection and other Hub work remain separate TODO items; API 14 discovery must keep unsupported Web methods absent.
