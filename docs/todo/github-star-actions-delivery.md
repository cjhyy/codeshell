# GitHub Star fixed actions

This delivery adds only single-target `get_repository`, `get_starred`, and
`set_starred` Link actions. `set_starred` accepts `owner`, `repo`, and a required
boolean `starred`; it does not accept an API method, endpoint, body, or batch.
The existing native Link write approval describes those exact detached values.
It adds no sidebar or Panel feature.

The owning Engine's OperationController validates the repository's positive ID
and exact full name, reads the current account's Star state, sends at most one
mutation, and independently reads the resulting state through the same bound
ToolExecutor, permission rules, hooks, and live connection checks. Already
satisfied state receives an explicit `changed: false` result only after another
independent read. A write acknowledgement alone never proves success.

One trusted user intent owns one Star target. The existing HMAC ledger binds
intent, account, connection, remote grant, verification generation, target,
parameters, and postcondition. Changed arguments conflict; unknown sends fence
later writes and survive a new ledger/Engine. Neither timeout nor lost response
causes another send. Separate trusted batch slots and manual reconciliation are
future work.

All three new actions require explicit saved capability IDs. Old bindings with
missing, empty, or older capability arrays gain none by upgrading. Local OAuth
refresh preserves its old capability intersection; remote grants and token
scopes remain exact. Explicit new connection/reconnection reviews the current
action set. PAT instructions prefill and name **account-level Starring: write**;
GitHub App users must separately enable the App's Starring user write permission.
CodeShell never changes App permissions, requests an upstream scope expansion,
or silently switches account/backend. Insufficient provider permission fails.

The fixed provider endpoints are:

- `GET /repos/{owner}/{repo}` for identity.
- `GET /user/starred/{owner}/{repo}`: 204 means true, 404 means false.
- `PUT` or `DELETE /user/starred/{owner}/{repo}`: 204 acknowledges the send,
  with `Content-Length: 0` and no JSON payload. GitHub requests explicitly name
  `User-Agent: CodeShell-Link`, including the Node single-send transport.

Status endpoints accept legal empty and plain-text responses without JSON parsing.
All other statuses fail closed. HTTP mutations use the existing single physical
send transport; managed `gh api --include` parses one exact HTTP status, accepts
its documented HTTP-404 exit only for reads, and rejects killed/error processes.
Remote resources remain restricted to repositories explicitly selected in the
grant. The companion services PR adds the reviewed adapter whitelist and consent
labels, preserves old grants, and disables its refresh/retry path for Star writes.
It is tested locally and is **not deployed** pending real-provider acceptance.

Validation uses private HOME, USERPROFILE, app state, and an allowlisted environment
before importing Core. The actual compiled SDK Engine consumer covers verified
Star, an unknown response plus restart without resend, and a real managed CLI
child path. The worker and every CLI subprocess emit exact-localhost bootstrap
receipts containing PID, parent PID, and private-home hash. Fake models and
synthetic localhost credentials make no paid-model or real GitHub writes. This
network guard confines trusted test HTTP clients; it is not an OS sandbox.

Official contracts checked:

- [GitHub REST starring](https://docs.github.com/en/rest/activity/starring)
- [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository)
- [Fine-grained PAT URL permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters)

Real upstream write acceptance, other verified write consumers, batch slots,
manual reconciliation, and retaining/compacting operation history remain open.
