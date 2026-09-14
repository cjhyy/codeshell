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
