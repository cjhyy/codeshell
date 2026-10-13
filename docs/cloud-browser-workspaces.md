# Independent Account browser workspaces

The Server supports an explicit fresh-install browser mode:

```ts
await startProjectControlServer({
  host: "127.0.0.1",
  port: 4100,
  dataDir: "/var/lib/codeshell-cloud-browser",
  publicOrigin: "https://cloud.example.com",
  accountMode: "multi-account",
  accountAuthority, // trusted fixed-origin CloudAccountAuthority v2 adapter
  runtimeImage, // reviewed immutable project runtime image
  staticRootDir,
});
```

Missing `accountMode` retains existing Hub or explicit single-operator Account
adoption. Browser mode requires a fixed Account authority and public origin. It
refuses legacy registry v1/v2 and any existing Hub authority directory. It never
adopts a previous owner, matches a username/provider identity, or grants an
administrator role to the first login.

Registry v3 stores one configured Account origin and management epoch. Each
`(accountOrigin, accountId)` has a durable independently generated owner UUID.
Every project belongs to exactly one owner. Project list/create/get/start/stop/open
and the existing `/p/{projectId}/...` HTTP/WebSocket proxy use that owner scope.
Default limits are 16 projects and two running projects per owner, four running
projects and 128 projects in the installation. Revocation failure terminates only
the affected owner's runtimes. Normal controller shutdown still stops all owned
runtimes before releasing its registry lease.

## Browser bootstrap

`CLOUD_BROWSER_AUTHORITY_VERSION === 1` is exported by the focused Server `serve`
entry. Only an installation explicitly started in browser mode provides:

```http
GET /api/v1/cloud-browser/capabilities
```

The fixed public response contains exactly `version: 1`, `mode: "cloud-browser"`,
`cloudOrigin`, `installationId` and `accountOrigin`. It cannot register or select
an authority. The Account service must separately pin the Cloud origin and
installation and issue an existing target-bound one-use v2 ticket.

```http
POST /api/v1/cloud-browser/session
Content-Type: application/json
Origin: <exact Cloud origin>
Sec-Fetch-Site: same-origin

{"ticket":"<Account-issued one-use ticket>"}
```

Use a same-origin browser JSON fetch with cookies enabled. Exact Host and Origin,
Fetch Metadata, unambiguous cookie headers, no Authorization header, bounded JSON
and no query/extra fields are required. The private v2 authority consumes the
ticket and verifies the current Account root; no Account bearer reaches Cloud or
the project. Success is HTTP 201:

```json
{
  "authenticated": true,
  "mode": "cloud-account",
  "session": "<existing safe CloudManagementSession DTO, without ownerId>"
}
```

Only the `cs_cloud_browser` HttpOnly/SameSite=Strict/Path=/ cookie carries the
restricted Cloud credential; HTTPS also sets Secure. No token appears in JSON,
URLs, iframe state or local storage. Its deadline is at most ten minutes and no
later than the verified Account principal. Every request and proxy lease performs
continuing private validation. The native `/cloud-management/session` interface
keeps its existing browser refusal; browser mode does not expose native grants.

The frontend obtains a new ticket before expiry and repeats bootstrap with the
current cookie. Same Account/root/authority-epoch renewal rotates the cookie token
while retaining the Cloud session ID and live project connections. A stale failed
validation cannot revoke its independently redeemed replacement. An identity or
root change creates a new session and revokes the previous cookie scope.

`GET /api/v1/auth/status` retains `mode: "cloud-account"`, `authenticated` and the
safe session DTO. Same-origin JSON `POST /api/v1/auth/logout` or
`POST /api/v1/cloud-browser/logout` with `{}` revokes this Cloud session and clears
its cookie. Account logout remains a separate authority action and invalidates
derived Cloud access through continuing validation.

Opaque Panel iframes retain their existing registered, project/session/generation
bound read-only asset capabilities. They do not receive Cloud or Account cookies.
A different signed-in user cannot borrow such an asset capability. Ordinary
project APIs continue to require the current cookie and origin checks.

## Recovery and delivery

Browser-mode backup and restore require explicit matching `multiAccountOrigin`.
Manifest v2 accepts only the fixed controller files `project-control/initialized`
and `project-control/registry.json`; unknown controller state is refused. Restore
preserves owner/project identity and project data credentials while rotating the
installation ID and management epoch. Old registries reject schema 3 without
changing its bytes. Existing legacy backup/adoption contracts remain separate.

Controlled HTTP tests cover two-account isolation, CSRF, ticket replay, cookie
renewal, stale validation, late startup and owner-scoped emergency termination.
A confined native Node fixture verifies foreign WebSocket refusal, live root
revocation, retention of another account's transport and complete controller
shutdown. These checks use synthetic identities and runtimes. Runtime image,
network policy, real model/tool execution, target backup/restore, package delivery
and production acceptance require their own evidence; this source feature does
not add an outbound network firewall or authorize an existing shared Hub.
