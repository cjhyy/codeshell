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
`accountOrigin`, `redeem(ticket, installationId)` and
`validate(principal, installationId)`. Server requires an explicit binding with
the matching Account origin, UUID and external Cloud origin. Missing or unexpected
Account configuration fails startup. `CLOUD_MANAGEMENT_AUTHORITY_VERSION = 2`
lets the composition reject older packages that silently ignore unknown options.

Main first requests `GET /api/v1/cloud-management/capabilities` from the exact
Cloud origin. Its response contains exactly `{version:2, mode:"cloud-account",
cloudOrigin, installationId, accountOrigin}`. Main validates the fixed origins and
UUID, then sends its Account bearer only to the configured Account origin's
`POST /api/v1/account/cloud-management/tickets` with `{cloudOrigin, installationId}`.
Account explicitly pins both target values in operator configuration; discovery
alone cannot authorize a target. The response contains exactly `{ticket, expiresAt,
cloudOrigin, installationId, accountOrigin}`. The opaque 43-character base64url
ticket expires within 60 seconds and the root session deadline, is single use,
and remains bound to the live Account root, process epoch and target installation.
A restored installation UUID requires explicit operator reconfiguration.

Main sends only JSON `{ticket}` to the exact Cloud HTTPS origin's
`POST /api/v1/cloud-management/session`, without Cookie/Authorization/Origin.
The trusted private version 2 HMAC protocol redeems that ticket against the
controller's own installation and Cloud origin. Raw `{accountToken}` requests,
the old private exchange action and version 1 packages are refused.
The 201 response is `{token, session}`. Session contains exactly `id`,
`kind: "cloud-management"`, `audience`, `installationId`, `accountOrigin`,
`accountId`, `managementEpoch`, `expiresAt`. It omits the internal owner id and
Account root/session ids. The Cloud grant expires within ten minutes and no later
than the Account principal deadline. Account access/refresh credentials never
enter Cloud requests, worker configuration, renderer responses, URLs or error messages.

Native management calls use Cloud bearer only and omit cookies. Main installs only
the Cloud grant as `cs_cloud_management` with HttpOnly, Secure on HTTPS,
SameSite=Strict, path `/` and expiry no later than the session deadline, in a
partition bound to Cloud origin, Account UUID and management epoch. Web requests
use that cookie alone; mixing the bearer and same-named cookie is refused.
The partition also includes Account origin and the individual grant id, so old
cleanup cannot remove a renewed session's cookie. One window is reused per grant.

The Desktop project chooser requires the saved Account identity before explicit
Cloud discovery; construction and address editing do not connect. List, create,
start, stop and open all use the one Main-owned management bridge. Account origin,
UUID, Main frame ownership and operation incarnation are checked across awaits.
Failed operations keep a visible uncertain state until explicit reload. An initial
list failure retains the attempted identity so the user can still revoke that
Cloud, even after editing the address. The Dialog is locked synchronously before
the request starts and IME composition cannot accidentally submit it.

Cloud logout destroys that grant's windows before asynchronous cookie deletion,
then independently requests remote revocation. Failed cleanup or an unknown
acknowledgement stays available for retry. Late grants and late window failures
also retain cleanup/revocation debt. Account logout retires its Cloud and relay
resources and still attempts root revocation after a local cleanup failure.
Expiry closes managed windows; users explicitly reconnect for a new grant.

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
foreign Account/legacy/browser-ticket refusal, exact public capability DTO, raw
Account credential rejection and ticket replay refusal, readiness/availability revocation,
continuous live SSE retirement and idempotent logout. The network fixture installs
exact-origin/process refusal before importing Core and uses private synthetic HOME,
credentials and listeners. Legacy lifecycle, registry and backup regressions pass.
The old registry refusal test imports the actual previous Git source algorithm and
checks that it does not rewrite bytes.

The Desktop combination passed **83 tests / 492 assertions**, including strict
DTOs, fixed Account target tickets, actual native Node HTTPS headers/TLS/body
limits, Account refresh/logout and late-result boundaries, real React chooser
and Link interactions, window policy/capture and unchanged architecture budgets.
The cleanup test additionally runs the compiled manager under native Node with
`--unhandled-rejections=strict`: an early rejected local cookie cleanup stays
handled while the independent remote acknowledgement is delayed. Tests also
cover synchronous cleanup throws, late cookie cleanup after Account retirement,
shutdown during exchange and explicit revocation retries.

`node packages/desktop/scripts/smoke-managed-cloud-window.mjs` built the actual
window modules and ran Electron **33.4.11** against a private exact HTTPS origin.
It verified no preload/local bridge/Node integration, sandbox/context isolation,
HttpOnly/Secure/Strict scoped cookies, same-grant window reuse, separate Accounts,
renewed-grant preservation, synchronous window closure, default-session
preservation, expiry and ownership loss during native loading. Five actual HTTPS
page requests passed; the external probe was blocked. All five reported Electron
processes exited and all windows closed before the runner deleted its private
HOME. The runner is included in the normal Electron CI command. This fixture
does not use native Account credential storage, models or operator credentials.

Services ticket/adapter PR #42 passed all six CI jobs and merged as
`66fb017638bcef0c6c846cd4fdc180da37d64a40`; its exact final code, five extracted
candidate tarballs, actual Account/private HMAC/inner Hub consumer and executable
offline CLI receipts live in the Services repository's
`docs/cloud-account-ticket-delivery.md`. Web PR #147 passed all twelve CI jobs
and merged as `17501c750c5f8c60578b7a67539ffae7daaf4953`. Its twenty browser
checks use 390/1440 viewports and do not establish physical phone acceptance.

This checkpoint does not claim a production migration, official package release,
deployed reverse-proxy reachability, physical Mobile or Desktop user acceptance.
Services private mounting/composition and Desktop/Web Account-mode consumers are
tracked separately. Final actual Main-to-Account-to-Cloud HTTPS interoperability,
exact Host PR CI and official release/target validation still remain.
