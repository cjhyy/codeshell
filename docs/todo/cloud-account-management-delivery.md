# Cloud Account management authority

The Server implements one explicitly adopted Account UUID managing one existing
single-operator Cloud installation. Project/volume ids, owner ids and runtime
credentials remain intact. Other Accounts are refused; this is not multi-tenant
runtime isolation. OAuth stays in Account.

## Offline adoption

`code-shell-cloud-account --inspect --data-dir <canonical path>` shows only the
installation, owner ids/usernames and project status for explicit operator review.
Stop the controller/projects and make the existing full installation/volume backup
before `--adopt`; supply the exact Account origin/UUID and reviewed installation,
sole legacy owner UUID/username, plus a private external evidence directory.

The tool holds the actual single-controller lease. It first durably copies original
registry/initialization/Hub authority bytes and SHA-256 receipt outside the source.
It publishes a pending barrier, commits registry format 2 with explicit binding,
revokes and flushes every old Hub session, flushes a completion receipt, then clears
the pending barrier. Historical registry code rejects version 2; unknown metadata
alone was not used as a compatibility barrier. A failure leaves original evidence
and the pending transaction for deterministic same-input retry or explicit
diagnosis. Unknown source/evidence changes are refused. No automatic rollback
re-enables legacy login. Evidence includes password hashes and must stay private.
It is authority evidence, not a substitute for backing up project volumes.

Every actual fsync cut is tested with a real failure and retry, including the
registry rename/parent-directory boundary. Live controllers latch a post-rename
durability failure instead of serving cached pre-write state. Cold controllers
refuse any pending marker, including a dangling symlink. Restore creates a new
installation namespace and management epoch while preserving Account ownership
and project credentials.

## Main and Web contract

The trusted Services composition supplies `accountAuthority` with fixed
`accountOrigin`, `exchange(token, installationId)` and
`validate(principal, installationId)`. Server requires an explicit binding with
the matching Account origin, UUID and external Cloud origin. Missing or unexpected
Account configuration fails startup. `CLOUD_MANAGEMENT_AUTHORITY_VERSION = 1`
lets the composition reject older packages that silently ignore unknown options.

Main sends only JSON `{accountToken}` to the exact configured Cloud HTTPS origin's
`POST /api/v1/cloud-management/session`, without Cookie/Authorization/Origin.
The 201 response is `{token, session}`. Session contains exactly `id`,
`kind: "cloud-management"`, `audience`, `installationId`, `accountOrigin`,
`accountId`, `managementEpoch`, `expiresAt`. It omits the internal owner id and
Account root/session ids. The Cloud grant expires within ten minutes and no later
than the Account principal deadline. Account access/refresh credentials never
enter worker configuration, renderer responses, URLs or error messages.

Native management calls use Cloud bearer only and omit cookies. Main installs only
the Cloud grant as `cs_cloud_management` with HttpOnly, Secure on HTTPS,
SameSite=Strict, path `/` and expiry no later than the session deadline, in a
partition bound to Cloud origin, Account UUID and management epoch. Web requests
use that cookie alone; mixing the bearer and same-named cookie is refused.

Existing project list/create/start/stop/get routes enforce the owner id through
the explicit Account session union, without a fake Hub username/session. The new
`POST /api/v1/projects/:id/open` with `{}` verifies the running generation and
returns `{project, url: "<exactCloudOrigin>/?project=<UUID>"}`. The URL has only the
project query and no credentials. Actual API/WS proxy traffic stays under
`/p/<UUID>/...`; that prefix is not an HTML page entry.

Status is `GET /api/v1/auth/status`: `{initialized:true, mode:"cloud-account",
authenticated:false}` when absent/locally invalid, or authenticated true plus the
public session. A newly failed upstream validation returns a safe 401 and retires
the grant; subsequent status is false. Old Hub setup/login/device-session management
is forbidden. `POST /api/v1/cloud-management/logout` and `/api/v1/auth/logout`
accept `{}` plus one Cloud bearer/cookie, return `{revoked:true}`, clear the cookie,
and idempotently retire a known grant even after expiry. Unknown grants get 401.

Every request and asynchronous lifecycle boundary checks the actual Account root,
process/recovery epoch and deadline. Proxy validation also covers frame forwarding,
response streaming, assets and the periodic two-second sweep. Revocation/outage
closes existing transports, logs out private inner runtime cookies and stops the
runtime if logout cannot be acknowledged. No completed authority result is cached.

## Evidence and remaining acceptance

Guarded source tests cover real HTTP list/create/start/open/stop, cookie status,
foreign Account/legacy/browser-exchange refusal, readiness/availability revocation,
continuous live SSE retirement and idempotent logout. The network fixture installs
exact-origin/process refusal before importing Core and uses private synthetic HOME,
credentials and listeners. Legacy lifecycle, registry and backup regressions pass.
The old registry refusal test imports the actual previous Git source algorithm and
checks that it does not rewrite bytes.

This checkpoint does not claim a production migration, official package release,
deployed reverse-proxy reachability, physical Mobile or Desktop user acceptance.
Services private mounting/composition and Desktop/Web Account-mode consumers are
tracked separately and require final combined package/consumer validation.
