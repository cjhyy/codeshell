# MCP OAuth issuer binding

The Core, Server and Desktop SDK dependency floor is `^1.31.0`; the lockfile
resolves 1.31.0. This addresses the affected SDK range in
[GHSA-6qxp-vccf-f47h / CVE-2026-104850](https://github.com/advisories/GHSA-6qxp-vccf-f47h).
No other resolved dependency version changes.

Desktop is an OAuth client: `McpOAuthService.discoveryLogin()` calls SDK `auth()`
twice with one temporary provider. It saves the SDK's token and registration
objects unchanged between those calls. Its cached discovery state keeps the
callback exchange at the authorization server selected before opening the browser.
The persisted token and client-registration issuer now come from SDK stamps and
must match the actual discovery URL. SDK 1.31 does not validate the metadata
document's self-declared `issuer`, so that field is not used as the binding key.

The SDK provider receives a pre-registered public client ID and its available
issuer binding. It never receives stored refresh tokens or stored client secrets.
An older `secret.issuer` / public `meta.issuer` may be an unvalidated metadata echo;
the fallback is used only for that public client ID. A newly supplied public ID
without an issuer still supports interactive sign-in and receives the SDK stamp
after a successful exchange. An old secret-bearing registration with no issuer
cannot enter discovery: the service preserves the old credential and asks for a
new credential binding.

Desktop's existing custom refresh and revocation use saved endpoints, without SDK
rediscovery, and reject redirects. Credentials without an issuer can continue to
refresh at their saved endpoint. Re-login cannot carry a saved client secret to a
replacement authorization or token endpoint; it requires a new credential.
There is no automatic credential deletion or claim that operator credentials
have been exposed. A new interactive sign-in still requires trusting the MCP
server and the authorization server it advertises.

Core MCP connections and Server/Desktop probes supply their authenticated fetch
or request headers to the transport rather than an SDK OAuth `authProvider`.
That narrower transport behavior does not remove Desktop's direct `auth()` path.

`mcp-oauth-issuer.test.ts` runs the actual installed SDK against two independent
local authorization servers. It checks saved stamps, changed discovery between
authorization and callback, cross-issuer refresh/client-secret rejection, public
pre-registration, legacy boundaries and endpoint replacement. Its dedicated CI
invocation uses the guarded runner's real private HOME and installs global fetch
and HTTP(S) exact-origin guards before the first SDK/Core import. PID, private
HOME hash and exact origin receipts are emitted; this is application-level
network confinement, not an OS sandbox. Existing refresh/redirect/rotation and
MCP authorization tests remain active. All tokens, secrets and accounts are
synthetic; no live OAuth or model requests are needed.
