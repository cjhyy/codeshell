# Optional Desktop cloud account

CodeShell opens and runs local projects without an account or an account-server
connection. The sidebar account entry and Settings → General open the same
optional cloud account flow, with GitHub sign-in first, separate password login
and account-creation modes, explicit GitHub linking, and logout.
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
races, GitHub PKCE/cancellation/linking, native TLS/redirect/body limits, account
enrollment without sharing, LAN preservation, and rotating relay credentials.
These fixtures do not claim production deployment or a real GitHub OAuth account
has passed acceptance.
