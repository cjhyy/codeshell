# Trusted browser video capture

Web Panels can request a bounded recording chooser in the authenticated
workbench. The chooser uses the device running the browser, including when the
project executes on a remote server. The Panel iframe retains its opaque origin,
sandbox and camera/microphone/display-capture denial.

## Interface and discovery

Both optional methods require the existing `resources` permission. They do not
grant direct device access to the Panel. Discover methods from `availableMethods`;
do not infer support from API 14 or from the Desktop-only `media.capture` permission.
The existing `resources.recordAudio` interface and its limits remain compatible.

```ts
await host.call("resources.recordVideo.capabilities", {});
// { camera, screen, microphone, systemAudio, maxDurationSeconds, maxBytes }

await host.call("resources.recordVideo", {
  source: "camera", // or "screen"
  microphone: true,
  systemAudio: false,
  maxDurationSeconds: 300,
  maxBytes: 64 * 1024 * 1024,
});
// { asset, capture: { source, microphone, systemAudio } }
// or { cancelled: true }
```

Discovery checks secure-context, capture API and video encoder availability
without requesting permission or enumerating devices. Camera and screen are
reported separately. `systemAudio: true` means display audio can be requested;
the browser may still return no audio track. It does not promise system-wide
sound or a particular application. Actual device presence, OS permission and
source availability are checked when the user starts. The successful receipt
reports the audio tracks actually included in the recording.

The capabilities method remains discoverable when capture is unavailable, so a
Panel can still offer recovery of saved resources. `resources.recordVideo` is
filtered from the trusted browser's context when neither source is supported.
The server validates permission and returns an effect; only the trusted browser
can supply device capability values.

`source` is required. `microphone` defaults to true; `systemAudio` defaults to false
and can be true only with screen capture. Duration defaults to 300 seconds and
size to 64 MiB, with independent hard limits of 1200 seconds and 200 MiB. Unknown
fields, invalid sources and out-of-range values are rejected. There are no
guest-supplied device IDs, capture source IDs, disk paths or encoding commands.

## Consent, scope and transport

The request opens trusted UI; it does not start capture. The user must click Start
in that UI. Screen selection uses this activation and requires a fresh source
selection. After stopping, the user can preview, download a local backup, discard,
or explicitly save to the project. Recording or saving makes workbench navigation
dirty and the Panel iframe inert. Only one recording/confirmation is active.

All source and mixed tracks are owned by the chooser. Stop, source-ended,
cancellation, size/duration limits, encoder failure, panel/page close and grant
revocation release tracks and any audio context. A late permission response is
released after cancellation. Stopping a display while microphone permission is
still pending cannot later start the encoder. Unexpected unrequested audio never
enters the encoder. Device access is not a durable background task and cannot be
resumed across page close or browser suspension.

Capture and upload keep the original project, workspace and grant. Switching
projects/sessions remounts the workbench Panel; its abort signal and operation
generation invalidate old work, including A → B → A transitions. No operation
retargets an active recording to another project's current URL.

Saving uses existing `resources.upload.*` custody, 32 KiB chunks, original bytes
and SHA-256 verification. MIME metadata is normalized to `video/webm` or
`video/mp4`, excluding encoder codec parameters. The uploader paces writes using
the grant's `capabilities.bridge` transfer budget; it does not increase server
quotas. Other traffic can still exhaust shared quotas and require explicit retry.
The chooser has a 25-minute total lifetime and the bridge advertises a 30-minute
method timeout. Per-operation network limits and bridge rate budgets still apply.

Failed saves retain the in-page Blob for preview and backup. Explicit Save retries
query the same acknowledged upload, then resume or obtain its idempotent finish
receipt. An unknown begin response can leave an expiring partial upload; it does
not imply a published asset. If finish succeeded but its response or the Panel
page was lost, the published original remains available through paginated
`resources.list`, `resources.get`, `resources.open` and `resources.preview` in the
same project/app scope. Recording and adding a resource to a domain document are
separate operations owned by the Panel. Unsaved Blobs are not persisted across
page close; partial uploads retain the resource service's existing expiry policy.

## Supported environments and evidence

Capture needs HTTPS or a trusted localhost origin, browser capture APIs and a
supported MediaRecorder video encoder. Mobile browsers may offer camera capture
without display capture. Permissions are requested only after explicit start;
discovery cannot guarantee hardware or OS authorization.

The Electron cloud workbench uses a source chooser restricted to its own trusted
top-level window, an active user gesture and the current navigation generation.
It rechecks after asynchronous selection, rejects iframes and stale navigations,
and does not install a Desktop preload. It does not change ordinary browser
guests or local Panel capture. Windows may provide system loopback audio; other
platforms can record microphone audio without system sound. The native system
picker is disabled because it can bypass the authorization callback.

Packaged macOS builds declare `NSCameraUsageDescription` and
`NSMicrophoneUsageDescription` through `build.mac.extendInfo` in the Desktop
package. Both strings explain capture after the user explicitly starts recording;
the microphone description also covers existing voice input. These usage strings
are required by Electron's [macOS media permission API](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesaskformediaaccessmediatype-macos)
and do not grant device access or replace the trusted workbench consent prompt.

Unit/HTTP tests cover consent boundaries, source/audio projection, cancellation,
late permissions, ABA, MIME normalization, exact upload receipts and transfer
pacing. `bun scripts/smoke-panel-video-capture.mjs` runs the production workbench,
real browser MediaRecorder and real HTTP resource service. It uses synthetic
camera/microphone devices and captures only its isolated fixture tab. It checks
playable WebM, backup and exact project bytes after lost write/finish responses,
resource-list recovery, and authorization cleanup. Physical devices, all browser
platforms, models, deployment and complete Panel business workflows require
separate acceptance; these checks do not mark all six Panels complete.
