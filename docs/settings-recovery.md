# Recovering damaged project settings

`code-shell settings-recovery` is an offline administrator command for a desktop
project or a cloud project's actual working directory. Stop the project and its
workers first. It is not exposed to Panels, paired browsers or generic settings
RPC. It does not grant a remote guest permission to change trust roots.

Use it when invalid JSON or invalid settings (including damaged Panel version
pins) prevent ordinary settings/package management from loading. It repairs a
complete settings document; it never guesses missing permissions, deletes Panel
pins to select the latest package, or resets a damaged document to defaults.
This does not replace package repair, document migration, or server-volume backup.

## Inspect and prepare

```sh
code-shell settings-recovery inspect --project /absolute/project
code-shell settings-recovery inspect --project /absolute/project --from /private/corrected.json
```

Inspection writes no files and prints JSON containing the canonical project,
selected scope, active filename, status, sizes, hashes and a revision. It never
prints configuration values. `--scope local` selects `settings.local.*`; the
default `project` selects `settings.*`. It does not inspect or change user settings.
For a worktree, specify the directory that actually owns the configuration being
repaired; inspect the reported project and active filename before applying.

Prepare a complete corrected JSON document or use a reviewed known-good copy.
Preserve the original fields you still need, including permissions and extension
fields. Keep any credentials in the private file, not in command-line arguments
or logs. Inspection reports `candidate.status` and `candidate.sha256`; only a
schema-valid JSON object is accepted. No model, API key or normal startup setup
is required to run recovery.

## Apply the reviewed file

```sh
code-shell settings-recovery repair --project /absolute/project \
  --from /private/corrected.json \
  --expected-revision <revision-from-inspect> \
  --candidate-sha256 <candidate-sha256-from-inspect>
```

The command uses the ordinary settings directory lock, rechecks the revision,
backs up the original JSON bytes, then atomically installs the exact reviewed
bytes as `settings.json` (or `settings.local.json`). Existing YAML alternatives
remain untouched. Their hashes are part of the revision, so an intervening YAML
change also stops the operation. Unknown extension fields in the candidate are
retained. There is no implicit merge with the damaged file.

Backups live under `.code-shell/settings-recovery/`, with a private directory and
private files on POSIX. A local `.gitignore` excludes the backup directory contents
from ordinary Git staging. The backup and replacement file are flushed before the
replacement is reported; directory flushing is supported on POSIX. Files must
be bounded regular files, and linked configuration/backup directories or files
are rejected. A backup failure prevents replacement. Output includes a
`backupId`, the new revision and the actual resulting status. If a write fails or
its durability is uncertain, inspect the current state before retrying; keep the
reported backup ID.

The command does not discover or terminate other processes. The administrator
must stop the project before use; restart it afterward so workers discard cached
settings. Normal online Panel upgrades must continue using the reviewed package
management flow and its running-task checks.

## Roll back

```sh
code-shell settings-recovery inspect --project /absolute/project
code-shell settings-recovery restore --project /absolute/project \
  --backup-id <backup-id> --expected-revision <current-revision>
```

Restore first backs up the current JSON, then restores the earlier exact bytes.
If JSON was previously absent, it removes the replacement and the unchanged YAML
alternative becomes active again. A changed YAML alternative, damaged backup,
wrong project/scope or stale revision prevents rollback. The returned new backup
ID can undo the rollback itself.

Restoring the original damaged bytes restores the original fault too; the result
reports that status explicitly. Backups contain sensitive original bytes encoded
as base64, not encrypted. Keep their directory private and include it only in
trusted project backups. This command does not authenticate an administrator
against an attacker with the same filesystem access. It is not a mechanism for
restoring a copied backup into a different project path; use a reviewed JSON
candidate for that case.
