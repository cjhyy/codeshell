# Optional Desktop cloud account

CodeShell opens and runs local projects without an account or an account-server
connection. The sidebar account entry opens the optional cloud account flow, with
GitHub sign-in first, separate password login and account-creation modes, GitHub
identity binding, and logout.
The account entry is a compact avatar icon beside Settings in the sidebar footer;
its hover text and accessible description retain the account name and state.
The service address defaults to `https://115.159.45.55` and remains editable for
self-hosted deployments. Prefilling it does not initiate an account connection;
the selected server must expose the account API before sign-in is available.
Opening the account form checks the selected service's public sign-in capabilities.
GitHub login/linking and registration stay disabled until their availability is
confirmed; an unconfigured GitHub service is explained inline. Changing the address
invalidates the previous result, and a failed check can be retried. Password login
remains available independently of this check. The sidebar and local account status
still perform no network requests.

Registration availability and GitHub OAuth configuration belong to the selected
Services deployment. Enabling GitHub requires a GitHub OAuth App with callback
`<service-origin>/api/v1/account/github/callback`, and both
`ACCOUNT_GITHUB_CLIENT_ID` and `ACCOUNT_GITHUB_CLIENT_SECRET` configured on the
account server. These values belong to the server; the client secret must never
be entered in Desktop or sent to the renderer. The public
`GET /api/v1/account/status` reports `githubEnabled: true` only after configuration.
Usernames use 3–64 letters, digits, periods, underscores or
hyphens, starting with a letter or digit, and are normalized to lowercase;
passwords require at least 12 characters. Password registration asks for password
confirmation and signs in immediately on success. Password login does not create
an account. Both password forms support Enter submission and prevent duplicate
submissions while a request is pending.

## Registration and sign-in

| Entry                       | Existing identity                                                     | New identity                                                                          |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Continue with GitHub        | Signs in to the account already linked to that GitHub numeric ID      | Creates a CodeShell account and signs in after authorization, if registration is open |
| Password login              | Signs in with the registered CodeShell username and password          | Reports invalid credentials; use Create account to register                           |
| Create account              | Reports an unavailable username instead of replacing an account       | Creates the password account and signs in                                             |
| Link GitHub while signed in | Keeps the current CodeShell account; repeated matching links are safe | Adds the GitHub identity to the current account instead of creating another           |

GitHub sign-in never requires filling in a CodeShell username or password first.
First-time GitHub accounts use a generated `github-<numeric-id>` username and
have no password. A later GitHub username change still resolves to the same
CodeShell account. The service does not merge accounts by matching names or email.
An existing password user who wants both sign-in methods should log in with their
password and choose Link GitHub. An identity already linked to another CodeShell
account cannot be transferred through this flow.

When registration is closed, existing password and linked GitHub accounts can
still sign in; a new GitHub identity cannot create an account. Existing users can
still explicitly link GitHub. When GitHub OAuth is not configured, both GitHub
actions remain disabled with an explanation. The selected service's public
capability response is authoritative; updating Desktop does not configure its
OAuth App or enable registration on that server.

The CodeShell cloud account is the personal identity used here. A self-hosted
Hub administrator is a separate, instance-local management identity and its
credentials cannot be entered as cloud-account credentials. No Hub administrator
registration is needed for the Desktop cloud-account flow. Email verification,
password reset/change, and adding a password to a GitHub-only account are not
implemented in the current account API.

## Nickname and login username

The sidebar avatar opens the account dialog; General settings no longer repeat the
account form. A service reporting `profileEnabled: true` enables profile editing.
Nickname (`displayName`) controls display text, while the unique username
(`username`) is used for password login. They can be changed independently, and
only changed fields are submitted. Nicknames support 1–64 Unicode code points
including Chinese and emoji after trimming and NFC normalization; control and
invisible direction characters are rejected. Existing accounts initially display
their username as their nickname.

Saving preserves the stable account UUID, GitHub identity, sessions, devices and
Link ownership. After a username change, password login uses the new username;
GitHub login still resolves by numeric identity. Renaming a GitHub-only account
does not add a password. Main validates the returned account and saves encrypted
credentials before publishing success. Logout, account switching, refresh and
concurrent windows cannot publish an older profile over a newer account state.

The Web cloud account menu also offers an Account profile link to the fixed
`<accountOrigin>/api/v1/account/manage` portal. Its URL contains no credentials,
and no link is available when the Cloud session lacks an account origin. The
portal has its own GitHub/password login because the Cloud cookie is scoped to
the workbench. It keeps account credentials only in page memory and offers the
same nickname/username editing. The profile link does not authorize Link access.

## GitHub login and data connection

“Continue with GitHub” defaults to “Connect GitHub too” when the selected service
supports the account-to-Link handoff. It can be unchecked to sign in only. Older
services remain usable for sign-in; the unavailable connection option is explained
inline. Binding a GitHub login identity to an existing password account remains a
separate action and does not start a data connection.

With the option enabled, Desktop prepares its existing Link PKCE job without opening
a browser. The account service verifies that job with the configured Link service
before requesting `repo read:user` in one GitHub authorization. It exchanges the
upstream code once, creates or finds the CodeShell account by numeric GitHub ID, and
issues the account session. A short-lived authenticated server handoff carries only
the GitHub credential and verified identity to Link. Desktop saves the account first,
then opens a one-use Link claim in the system browser. The usual repository and action
consent is still required before Desktop receives a Link grant.

Account identities/sessions remain in the account database; encrypted provider
credentials, connections, repository/action grants, and owner-to-connection mappings
remain in Link's database. CodeShell account bearer tokens never go to Link. Claim
tickets remain in main memory, expire ten minutes after preparation, and are excluded
from account persistence and renderer status. Repeated login reuses the same remote
connection for the exact account origin, account UUID and GitHub ID. Desktop also
reuses a uniquely matching user connection, preserving its local ID and label while
retiring its previous grant; ambiguous matches fail safely.

Login succeeds independently of Link. Connection progress appears after sign-in;
canceling or failing that step keeps the signed-in account. Logging out preserves
existing Link connections. Disconnecting Link preserves the account and GitHub login
identity. Neither operation broadens or revives an earlier repository/action grant.

Both services may use the same GitHub OAuth App, with both exact callback URLs
registered. The bridge additionally requires `ACCOUNT_LINK_ORIGIN` and
`ACCOUNT_LINK_HANDOFF_SECRET` on Account, and `LINK_ACCOUNT_ORIGIN` and
`LINK_ACCOUNT_HANDOFF_SECRET` on Link. The origins must identify the paired services,
the 32-byte hex secret must match, and both must use the same GitHub Client ID.
These are server settings, never Desktop inputs. Public capability discovery reports
`githubLinkEnabled`; it indicates configured support, while each actual preparation
still validates the live bridge.

## Local credentials and remote access

Signing in does not register this computer, start remote access, upload projects,
or authorize a phone. In Mobile Remote, “Register with current account” explicitly
registers the computer at the signed-in service origin. Connecting still requires
the computer's access passcode and separate phone pairing. The existing self-hosted
directory ticket flow, LAN mode, and temporary Cloudflare tunnel remain available.

The native account and relay directory use the same canonical HTTPS origin in
this version. The account management token is never sent to a separately entered
relay address. Relay uses a derived, account-bound device token with its own
refresh token. Control reconnect resolves the current device credential; every
data connection retains the credential authenticated by its control connection.

Account tokens live only in Electron main, in a separate OS-keychain-encrypted
file. A missing keychain or Linux `basic_text` backend disables cloud sign-in
instead of saving plaintext; local work is unaffected. Renderer snapshots expose
only account identity, service origin and state. Passwords are cleared from the
form on submit. GitHub opens the fixed GitHub authorization endpoint in the
system browser; its PKCE verifier, polling receipt, and CodeShell tokens remain
in main, and no CodeShell token is placed in a browser URL. Cloud workbench
cookies remain isolated from the native account.

Logout immediately clears local account authority and stops/removes that account's
relay registration. It preserves a running LAN Host and local tasks. Server
revocation uses a fresh access token, sharing an in-flight refresh when needed;
late responses cannot restore a logged-out or replaced identity. If the server
cannot confirm revocation, the UI reports that local logout succeeded and asks
the user to revoke the device in account session management when online.

Removing a saved computer registration also loads its device grant on a fresh
process so the grant can be revoked. If encrypted registration cannot be read,
removal still clears the local file and stops its transports; no unknown device
credential is guessed or sent. Remote revocation cannot be confirmed in that
case and remains available through the account service's session management.

Construction and status reads perform no network requests. Stored sign-in state
is checked/refreshed only when cloud functionality is used, and never blocks local
startup. No remote connection is started automatically after application restart.

Guarded tests cover anonymous/offline operation, token confidentiality, encrypted
storage, singleflight refresh, account/origin isolation, logout and account-switch
races, GitHub PKCE/cancellation/identity binding, optional Link handoff and failure
isolation, one-use claim navigation, remote connection reuse, native TLS/redirect/body limits, account
enrollment without sharing, LAN preservation, and rotating relay credentials.
These fixtures do not claim production deployment or a real GitHub OAuth account
has passed acceptance.
