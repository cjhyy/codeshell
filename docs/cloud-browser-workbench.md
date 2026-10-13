# Account website and private cloud workbench

The website opens the existing project picker and CodeShell workbench after
Account sign-in. It uses actual project runtimes, files, configuration, sessions,
and WebSockets. Profile, security, login sessions, and connections live at
`/settings/account/*`. Administrator routes require verified Account roles and
server capabilities; no account receives that role from UI state or a nickname.

The independently deployed Account service owns registration, password login,
GitHub identity, and session authority. A GitHub identity may create an account;
Link connections keep their separate credentials and resource grants. Browser
Account cookies are scoped to `/api/v1/account` and remain HttpOnly. Website
cookie changes are serialized across tabs. Native login grants are held only
during exchange into browser cookies.

Cloud uses a fixed Account origin, a separate service secret, and one-use v2
tickets to establish its own restricted browser cookie. It continuously validates
Account authority and checks project ownership on HTTP and WebSocket access.
Account root credentials are not forwarded to Cloud or project runtimes.

Multi-account mode requires a fresh registry. Stable `(Account origin, account
UUID)` identities map to separate owners; display-name and username edits do not
change ownership. It cannot reinterpret an existing single-operator installation.
The operator chooses runtime memory, CPU, PID, concurrent runtime, and project
limits. Browser callers cannot override those limits.

Website environment/session operations use `/api/v1/cloud-browser/*`, and private
runtime traffic uses `/p/<project UUID>/*`. Existing standalone Hub API and `/ws`
remain independent. A regular Headless Hub publicly returns `no-store 404` for
the cloud capability probe so its existing sign-in UI can load.

Validation includes guarded browser/session, registry ownership, backup,
resource-limit, and legacy Hub tests; packed public-package consumers; and a
local composition using two real Account users, real Headless runtimes and Core
workers with an owned loopback model. Browser acceptance verified a completed
conversation, restored cookies/workspace after reload, separate account settings,
and an unsent draft retained when returning from settings. Target Docker and
production deployment receipts belong in the services repository. Local model
fixtures do not establish production model-provider availability.
