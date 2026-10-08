# GitHub Star fixed actions

This delivery adds only single-target `get_repository`, `get_starred`, and
`set_starred` Link actions. `set_starred` accepts `owner`, `repo`, and a required
boolean `starred`; it does not accept an API method, endpoint, body, or batch.
The existing native Link write approval describes those exact detached values.
It adds no sidebar or Panel feature.

The owning Engine's OperationController validates the repository's positive ID
and exact full name, persists that numeric ID in its operation reference,
reads the current account's Star state, sends at most one
mutation, and independently reads the resulting state through the same bound
ToolExecutor, permission rules, hooks, and live connection checks. Already
satisfied state receives an explicit `changed: false` result only after another
independent identity and state read. Verification requires the same persisted ID
and full name. A renamed/deleted/recreated target stays unverified across restart;
a new same-name repository cannot satisfy the old operation. GitHub's mutation API
addresses repository names and offers no atomic ID precondition here, so the
identity/read-to-write race can be detected afterward, not eliminated. A write acknowledgement alone never proves success.

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
send transport. CLI **all write actions are disabled**, including `create_issue` and manually
edited or previously saved write grants. Real gh follows a 307 with another
PUT/DELETE; stdin POST follows 301/302/303 with a GET and reports success.
Managed `gh api --include` supports only the new read actions: it parses one exact
HTTP status, accepts its HTTP-404 exit only for reads, and rejects killed/error
processes. New CLI connections advertise only non-write actions. Write dispatch is rejected
before native approval, process launch, or transport, including direct adapter
calls. Explicitly connect PAT, browser OAuth, or remote Link for writes; no automatic backend fallback occurs.
Remote resources remain restricted to repositories explicitly selected in the
grant. The companion services PR adds the reviewed adapter whitelist and consent
labels, preserves old grants, and disables its refresh/retry path for Star writes.
It is tested locally and is **not deployed** pending real-provider acceptance.

Validation uses private HOME, USERPROFILE, app state, and an allowlisted environment
before importing Core. The actual compiled SDK Engine consumer covers verified
Star, an unknown response plus restart without resend, and a managed **fixture CLI** child read path. The compiled Engine also rejects old explicit CLI issue/Star write grants before approval, with no additional child or HTTP request. That synthetic executable validates
the adapter and child isolation; it does not establish real gh transport safety. The worker and every CLI subprocess emit exact-localhost bootstrap
receipts containing PID, parent PID, and private-home hash. Fake models and
synthetic localhost credentials make no paid-model or real GitHub writes. This
network guard confines trusted test HTTP clients; it is not an OS sandbox.

Official contracts checked:

- [GitHub REST starring](https://docs.github.com/en/rest/activity/starring)
- [Get a repository](https://docs.github.com/en/rest/repos/repos#get-a-repository)
- [Fine-grained PAT URL permissions](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens#pre-filling-fine-grained-personal-access-token-details-using-url-parameters)

Real upstream write acceptance, additional verified action families, batch slots,
manual reconciliation, and retaining/compacting operation history remain open.

The optional `node scripts/audit-github-cli-star.mjs` diagnostic separately ran
installed **gh 2.87.3** against a controlled localhost server with a private HOME
and synthetic GH_TOKEN. PUT and DELETE each followed HTTP 307 to `/destination`,
producing a second physical mutation; fresh EOF cases each sent once. A
production-shaped POST with `--input -` followed 301/302/303 with GET and exited
successfully, while 307/308 each failed after one POST without forwarding the
stdin body. The audit does not claim duplicate POSTs. The native
Go binary is not confined by the Node HTTP guard. Its only destination and every
redirect in this diagnostic are controlled localhost URLs, with update checks
disabled. This is a diagnostic for that installed version, not an assurance about
all gh versions or failure modes.

Source audit: [gh 2.87.3 HTTP client](https://github.com/cli/cli/blob/v2.87.3/api/http_client.go)
uses [go-gh 2.13.0](https://github.com/cli/go-gh/blob/v2.13.0/pkg/api/http_client.go),
whose client keeps Go's default redirect behavior. A future CLI writer needs a
reviewed, enforceable fixed-endpoint single-send mode before any write capability
can be advertised. The fake managed CLI child in the SDK smoke is only read and
process-isolation evidence; verified issue/Star writes use safe HTTP adapters.

Unregistered `risk: write` Link actions now fail before native approval or
transport: only reviewed fixed adapters may enter the persistent controller.
Unknown/running receipts retain the existing no-reconciliation behavior. Only
succeeded-but-unverified receipts may be independently rechecked; neither path
repeats the mutation.
