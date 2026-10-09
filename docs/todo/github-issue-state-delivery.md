# GitHub Issue close/reopen delivery boundary

This source change adds `LinkAction github.update_issue` for **one existing Issue
and one desired `open` or `closed` state**. It belongs to the next release after
the frozen 0.9.29 source. It adds no sidebar or management screen. It does not
change titles, bodies, assignees, labels, milestones or `state_reason`, and it
cannot operate on pull requests.

## Authority and execution

- Explicitly reconnect a PAT, browser OAuth or remote Link connection to grant
  `github.get_repository`, `github.get_issue` and `github.update_issue`. An old
  connection, an absent/empty capability set, a token refresh or a legacy CLI
  grant does not acquire this action. CLI remains read-only. Source views remain
  fixed read-only views and cannot invoke this write.
- The existing native approval describes the exact detached owner, repository,
  Issue number and desired state. Bound validation/verification reads still pass
  through the owning tool executor, permission classifier, hooks, task signal and
  live account/grant checks. Write approval does not grant read permission.
- Before mutation, read the repository's numeric ID/full name and the Issue's
  numeric ID/number/API URL/repository URL. A `pull_request` key, an unexpected
  identity, a moved path or missing identity blocks the operation. Already at the
  desired state means zero writes and another independent identity/state read.
- Send at most one PATCH with only `{ "state": "open" | "closed" }`. The default
  local transport sends once without pooled socket replay or redirects. Local
  OAuth and Services do not retry a rejected write after refresh. A response is
  an acknowledgement, not verification.
- The persistent receipt pins repository ID, Issue ID, Issue number and desired
  state. Independently read both resources again before `verified`. A changed ID
  or mismatched state cannot verify even if PATCH returned success. The existing
  unknown/restart barrier blocks resend, changed parameters and later intent;
  no reconcile or batch slots are introduced.

Remote execution also needs the separate Services `github:update_issue` scope.
Services validates selected repositories, rejects PRs and mismatched identities,
uses a single PATCH, and returns an acknowledgement. Existing Services grants stay
unchanged. A Host connected to an older Services deployment must reconnect only
after that deployment offers the new scope; there is no backend fallback.

## Provider limits

GitHub treats pull requests as Issues in its REST representation; checking the
`pull_request` field is required. The update endpoint uses the repository path
and Issue number. The documented API offers no conditional repository/Issue ID
compare-and-swap for this operation. Identity checks detect a rename, transfer,
recreation or Issue move observed before/after the send; they cannot make the
remote read/PATCH/read interval atomic. Another actor may change state after a
successful verification.

This adapter deliberately omits `state_reason`. It verifies only the requested
open/closed state and does not promise that a prior reason is preserved or select
completed/not-planned/reopened semantics. GitHub controls any resulting reason.
See the primary [Get/Update an Issue REST documentation](https://docs.github.com/en/rest/issues/issues#update-an-issue).

## Acceptance

The guarded unit suite covers desired-state/no-op behavior, strict parameters,
PR/identity rejection, changed IDs, denied reads, hooks, capability/account/grant
changes, cancellation, CLI rejection and persistent unknown barriers. The compiled
SDK smoke selects LinkAction through ToolSearch, then crosses the production
remote adapter and a real owned HTTP fixture, then also exercises the default
local PAT transport with fixed GitHub endpoints routed only to that fixture.
It checks actual PATCH bodies, lost-response single sends and durable
Session/transcript terminal behavior, and starts a second guarded Node process
to prove no resend on restart. Its preload receipt binds actual PID/PPID, private HOME hash and exact
fixture origin before Core import. These controlled fixtures do not constitute
real GitHub account or deployed Services acceptance. No real account, OAuth,
paid model, production deployment or 0.9.29 publication is part of this change.
