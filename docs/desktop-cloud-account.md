# Optional Desktop cloud account

CodeShell opens and runs local projects without an account or an account-server
connection. Settings → General includes an optional cloud account section with
password registration/login, GitHub login, explicit GitHub linking, and logout.
The service address defaults to `https://115.159.45.55` and remains editable for
self-hosted deployments. Prefilling it does not initiate an account connection;
the selected server must expose the account API before sign-in is available.
Registration availability and GitHub OAuth configuration belong to the selected
Services deployment. Usernames use 3–64 letters, digits, periods, underscores or
hyphens; passwords require at least 12 characters.

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
