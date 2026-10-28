# Persistent file references for Panels

Panels can reference authorized local files without copying them into the managed
resource library. This is a general Host resource capability; catalogs, editing
rules, model preparation, progress and recovery UI remain in the Panel.

Discover methods through `availableMethods`. Existing `asset-<sha256>` resources
remain immutable content snapshots. New `external-<64 hex>` references have a
separate identity and make no content-hash guarantee. Their public descriptor is
`{id, kind: "external", name, mimeType, bytes, lastModified, createdAt, state}`.
The Host stores source locations privately, scoped to the Panel app and project.
Descriptors and portable Panel documents do not expose an absolute source path.

- `resources.references.create({directoryHandle, path, name?, mimeType?, expectedBytes?, expectedLastModified?})`
  creates a reference to a file under a currently authorized directory. It needs
  resources and process permissions, because the directory handle comes from the
  process/filesystem interface. Repeated registration of the same source identity
  reuses the ID; creation does not read or hash the entire file.
- Desktop-only `resources.references.pick({multiple?, filters?, id?})` uses the
  native file chooser and needs resources permission. It returns `{references}`;
  cancellation returns an empty list. An optional existing ID selects a single
  file for strict reconnection. A multi-selection is limited to 128 files.
- `resources.references.get({id})` returns `{reference}` with state `available`,
  `missing`, or `changed`.
- `resources.references.relink({id, directoryHandle, path})` reconnects a moved
  original only when its device/inode, size and modification time still match.
  A replacement or a copy on another filesystem must be registered as a new
  reference; Panels decide how users review a new source version.
- `resources.references.forget({id})` forgets only the reference and stops its
  streams. It never deletes the original file.

`resources.get`, bounded `resources.read`, and `resources.materialize` accept both
resource kinds. Materialization deliberately creates a temporary task input only
when a processor needs it, computes a real hash and verifies the completed copy;
it does not create a second persistent resource. Tools still receive task-local
input paths, never an unrestricted source-file path.

Desktop `/media/<id>` serves references with GET/HEAD and byte ranges. Media and
resources permissions, current trust and project scope are required. Every read
checks file and ancestor identity before and after reading; changed sources do
not silently replace previous content. Explicit revocation, forgetting, request
cancellation, app unloading and Host shutdown close active streams. Scope/trust
authorization is checked before each new read, including when a paused stream
resumes. Closing a Panel does not persist its process directory grants; previously
registered file references can reopen independently after restart.

## Saving computer files from the paired browser

In the Desktop's paired Web workbench, `resources.open({assetId})` opens a Host
preview with **保存到此设备** and **复制下载地址**. The file remains on the computer;
the browser streams it over the current remote connection. Clipboard denial
shows a selectable address. These links require the same signed-in browser and
live Panel grant; closing the Panel or revoking access invalidates them. They
are not public or permanent share links.

`filesystem.openDirectory` exposes the currently authorized directory through
**查看并下载文件**. Its file responses support GET/HEAD and single byte ranges,
including suffix ranges, up to the existing 2 GiB per-file limit. Invalid ranges
return 416. Mutable directory files have no stable validator, so an `If-Range`
request returns the complete current file. Downloads continue checking access
while streaming. Hidden files, sensitive names, symlinks and hardlinks remain
excluded.

The phone and Desktop share bindings and resources for the same project. The
phone chooses its own current project; another project's bindings are not copied
automatically. The Panel list displays the binding project to make that scope
visible.

`bun run test:mobile-panel-downloads` exercises opaque iframe modules through the
real tunnel passcode gate in a 390px browser, saves synthetic computer bytes,
checks copied URLs and clipboard fallback, and verifies range reads and access
revocation. It uses a private HOME and makes no provider or video-site requests.
Set `CODESHELL_TEST_CHROMIUM` to an installed Chromium executable when needed.
