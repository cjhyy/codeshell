# Public npm release confirmation

`scripts/publish-release-packages.ts --execute` separates publisher acceptance
from public registry confirmation. Bun exiting zero records an **accepted**
submission. It does not print `Published` or finish the release successfully until
public metadata confirms both the exact package name/version and the requested
dist-tag.

The script submits packages in the audited dependency order, then checks all
accepted packages concurrently. This confirmation phase has **one ten-minute
budget for the whole batch**, starting after submission finishes. Polls are ten
seconds apart. Each public HTTP read is limited to fifteen seconds or the
remaining batch budget, whichever is shorter. The standalone
`publishReleasePackage()` helper uses the same budget for its single package.
Submission time and the existing bounded retries for failed publisher commands
are separate from the confirmation budget.

The budget accommodates the approximately four-to-six-minute visibility delay
observed during v0.9.27, while avoiding nine sequential per-package waits. This is
an operational allowance, not a guarantee of npm propagation time. The v0.9.27
packages ultimately became publicly visible; the change closes an acceptance
gap rather than establishing that this release failed.

Confirmation reads use the public `https://registry.npmjs.org/` exact-version and
dist-tags endpoints without authentication. Every request carries `Cache-Control:
no-cache` and a fresh query nonce. An exact-version 404, a missing/stale tag,
transient network failure, or transient HTTP response may be retried within the
confirmation budget. Unauthorized reads, invalid exact-version metadata, and
unexpected failures remain fatal. Child/request diagnostics are not copied into
release logs.

A confirmation timeout fails the CLI and therefore blocks the dependent GitHub
Release job. It never triggers another publish command or a dist-tag write.
Inspect public exact-version and tag metadata before explicitly recovering a
release; a publisher-accepted package may become visible after the timeout.
The existing-version path still requires the requested tag immediately and never
moves a newer tag backwards. `--dry-run` and `--list` remain entirely local.
