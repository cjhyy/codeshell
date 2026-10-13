# Cloud website workbench

The website opens the existing CodeShell Workbench, rather than an Account
dashboard. `WebsiteEntry` opts in only after a valid version-1
`/api/v1/cloud-browser/capabilities` response. An explicit 404 preserves the
original Hub `AuthGate`; malformed responses or temporary failures do not
downgrade a website into legacy workspace authority.

After Account authentication, the browser compares Account's fixed Cloud target
with the public capability and current origin. A one-use Account ticket obtains
the separate Cloud browser cookie. Only then does `ProjectsGate` fetch actual
private projects and mount `App`/`Workbench`. A single running project opens
automatically; creating and opening a project performs the real create/start
requests. Empty or unavailable environments show their actual state.

## Navigation

- `/`: project selection or the active conversation workbench.
- `/settings/account/profile`, `/security`, `/sessions`, `/connections`: Account
  settings, available even when the execution environment is unavailable.
- `/admin/users`, `/summary`, `/audit`: Account administrator views, gated by
  validated runtime role/capabilities and the server's independent checks.
- `/api/v1/account/manage`: compatible SPA route when the deployment routes that
  exact legacy entry to the website bundle.
- Existing `?project=...&session=...&view=history|files|links|panels|settings`
  selections are recoverable; `section=models|skills|mcp` selects workspace
  settings. Account navigation retains only these bounded public selections.

Account settings share one React session provider. Opening them keeps the real
workbench mounted and retains its unsent conversation. A change of Account UUID
or root-session UUID immediately fences the Cloud grant at render time, then
unmounts the previous project state. Account settings never fetch workspace data.

## Browser authority

Password and identity-only GitHub sign-in retain the native Account contract.
Their grant exists only in the current operation, is checked against its client
generation, and is immediately rotated through the fixed Account
`POST /api/v1/account/web/session` exchange. It is never put in React state,
local/session storage, URLs, Cloud requests, or runtime configuration. GitHub
association uses the separate signed-in `/web/github/*` receipt scope.

The website restores HttpOnly Account cookies using `/web/session`, obtains the
current CSRF token, and refreshes only when required. Every settings request,
including reads, carries that token. A shared same-origin Web Lock serializes
Account exchange/refresh/logout/session deletion and Cloud cookie operations
across tabs. Cookie mutations finish before the lock is released; UI cancellation
only decides whether their result is published. A cancelled exchange revokes its
own issued session while still holding the lock. A stale tab checks the captured
root and Cloud session before attempting logout, so it cannot sign out a newer
account. Browsers without Web Locks fail closed for cookie mutations.

Cloud tickets contain only the configured target and are one-use. The browser
does not convert Account credentials into old Hub cookies or adopt existing
shared workspaces. The multi-account controller and matching published runtime
must be enabled and verified separately; this UI does not migrate production
workspace ownership or claim provider, Docker, or deployment acceptance.

## Verification

Guarded Web tests exercise the actual React provider/shell with synthetic HTTP
responses and an inert WebSocket, plus the existing Hub/Desktop workbench
regressions. They cover fixed-target comparison, cookie exchange, cross-tab
refresh and logout ordering, stale OAuth results, cross-account/root rendering,
private project create/start, settings navigation/draft retention, member/admin
access, and session actions. They do not contact a real provider or use operator
credentials. Typecheck and a production Web build are separate checks.
