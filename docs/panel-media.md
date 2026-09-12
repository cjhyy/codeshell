# Legacy media bridge compatibility

CodeShell API 14 keeps existing resource IDs, document revisions, media URLs
and historical job records while Video Studio moves its processing into the
independently published Panel package. New code should use the [generic native
tool and resource APIs](panel-native-tools.md).

The Host no longer installs TTS engines, invokes FFmpeg/Whisper, chooses voice
reference lengths or frame rates, constructs HyperFrames templates, or registers
video processors. Video Studio owns those operations, their dependency setup,
progress stages, retry decisions and UI. The package lives in
[codeshell-panel-apps](https://github.com/cjhyy/codeshell-panel-apps/tree/main/apps/video-studio);
install the generated [panels/video-studio](https://github.com/cjhyy/codeshell-panel-apps/tree/main/panels/video-studio).

The `media` compatibility permission still requires `context.workspace` and a
trusted project. It retains:

| Method group                                    | Compatibility behavior                                                                                                                                     |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `media.import`, `media.export`                  | Native file selection and authorized resource import/export. Import returns a job whose result contains assets; format analysis is performed by the Panel. |
| `media.assets.list/get/read`                    | Existing resource records and bounded byte reads. Existing preparation records remain readable.                                                            |
| `media.document.get/set/versions`               | Bounded versioned JSON documents with optimistic concurrency. The Host does not interpret a video project schema.                                          |
| `media.recording.begin/write/get/finish/cancel` | Existing chunked recording transport and resource registration. The Panel inspects the resulting audio/video.                                              |
| `media.jobs.list/get/cancel`                    | Historical receipts and cancellation. Legacy media processors do not run again in the Host.                                                                |
| `media.jobs.retry`                              | Refuses Host-side reruns and directs the Panel to rebuild through the safe recipe interface.                                                               |
| `media.transcript`, `media.analysis`            | Read bounded pages of previously saved analysis only; new analysis runs in Panel tools.                                                                    |
| `media.jobs.recipe`                             | Safe, bounded inputs for a Panel to rebuild a compatible historical request; unavailable recipes require reselecting source inputs.                        |
| `media.status`                                  | Compatibility storage/transport capability discovery; processing is identified as Panel native.                                                            |

Microphone/camera/screen capture still requires `media.capture`, reviewed Panel
permissions and OS consent. Host resource custody enforces scope, quotas,
identity, atomic publication and preview MIME/CSP policy. Those controls are
independent of media analysis or TTS model choice.

Video Studio handles its old `media.*` UI calls inside its own bridge, mapping
new work to reviewed tools and generic Desktop tasks. This translation preserves
the editor's workflow without restoring media business logic in CodeShell.

Resource and historical-document scopes remain tied to the bound project path,
including when the session runs in one of that project's worktrees. Workspace
imports resolve their selected relative files against the trusted current
worktree; that selection does not change the resource scope or its preview URL.
New `media.recording.finish` receipts contain `{asset,provenance}` and omit
inspection. Previously finished receipts can still contain their old inspection.
The Panel performs any missing inspection through its reviewed native entry.
