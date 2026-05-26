# A3 — WebFetch SSRF Redirect Guard Design

**Date:** 2026-05-26
**Status:** Approved (Option A) — implementation in progress
**Closes:** [Gate 0](../../architecture/16-core-overall-design-standard.md#gate-0-safety-gate) bullet 7 + [§S4](../../architecture/16-core-overall-design-standard.md#s4-security-boundaries-fail-closed) last item
**Plan reference:** [Phase A — A3](../plans/2026-05-26-core-stabilization.md#a3-webfetch-ssrf-redirect-guard)

---

## Problem

`packages/core/src/tool-system/builtin/web-fetch.ts:84-92` calls:

```ts
const res = await fetch(url, {
  ...
  redirect: "follow",
  signal: AbortSignal.timeout(30_000),
});
```

with no per-hop validation. Three concrete leaks:

1. **No per-hop host check.** The initial URL passes through `isBlockedHost`, but any 3xx response from a public host can redirect to `http://127.0.0.1/admin` or `http://169.254.169.254/latest/meta-data/iam/security-credentials/` (AWS instance metadata) and the runtime follows it silently.
2. **No DNS resolution.** A public-looking host like `evil.example.com` can resolve to `127.0.0.1` or `169.254.169.254`. The string-based block list never sees the IP.
3. **No cap on redirect chain length.** Node `fetch` has an internal cap (~20) but we should set our own conservative limit and surface a clear error.

The current header allowlist (`BLOCKED_REQUEST_HEADERS`) is fine and stays.

## Approach (Option A)

Replace the single `fetch(url, { redirect: "follow" })` with a manual redirect loop. Each hop:

1. Reparse the URL.
2. Reject if protocol is not `http:` or `https:`.
3. Reject if hostname matches the existing string block list (`isBlockedHost`).
4. Resolve all IPs via `node:dns` `lookup({ all: true })`.
5. Reject if any resolved IP falls in the private/loopback/link-local/metadata ranges (`isBlockedIp`).
6. Issue the request with `redirect: "manual"`.
7. If status is 3xx and `Location` header present: resolve the relative URL against the current one, increment hop count, and loop.
8. Otherwise return the response.

Cap at `MAX_REDIRECTS = 5`. On exceeded, return a clear error.

### IP block list

Mirror the hostname block list but operate on parsed IPs. Use `node:net` `isIPv4` / `isIPv6` to dispatch:

- IPv4: `10.0.0.0/8`, `127.0.0.0/8`, `169.254.0.0/16` (link-local + AWS/GCP/Azure metadata), `172.16.0.0/12`, `192.168.0.0/16`, `0.0.0.0/8`, `100.64.0.0/10` (CGNAT, treat as private), `224.0.0.0/4` (multicast), `240.0.0.0/4` (reserved).
- IPv6: `::1`, `fc00::/7` (ULA: covers `fc00:`/`fd00:`), `fe80::/10` (link-local), `::ffff:0:0/96` (IPv4-mapped — strip mapping then re-check as IPv4), `2001:db8::/32` (documentation), `100::/64` (discard).

We do not parse CIDR with a library — implement direct prefix checks. The set is small and stable.

### Known limitations (documented, not fixed in A3)

- **TOCTOU between `dns.lookup` and `fetch`.** Node's built-in `fetch` (undici) does its own DNS resolution, so an attacker controlling DNS for `evil.com` can return `1.2.3.4` to our `lookup` call and `127.0.0.1` to undici's. Closing this requires a custom undici `Dispatcher` and is out of scope for A3. Mitigation: we still block almost every realistic SSRF vector (static private DNS, AWS metadata via direct redirect, IPv6 ULA, etc.).
- **`http://x@127.0.0.1/` userinfo confusion.** `new URL()` already exposes `hostname` cleanly, so `isBlockedHost(parsed.hostname)` works correctly; included as a regression test.
- **DNS-over-HTTPS to a private resolver.** We use the system resolver; if the user has configured an attacker-controlled resolver locally, that's outside our threat model.

### Header / credential handling

No change in scope, but on each redirect hop:

- Drop `Authorization`, `Cookie`, `Proxy-Authorization` if the redirect changes origin (host or port or scheme). This is the same policy `fetch(... redirect: "follow")` already applies internally, but we now control it explicitly.

### Public surface

`webFetchTool(args)` signature unchanged. Behavior changes:

- Redirect-driven SSRF returns `Error: refusing to follow redirect to ...` rather than the page body.
- DNS-resolved private IP returns `Error: refusing to fetch <host> (resolves to private/loopback IP <ip>)`.
- Over 5 redirects returns `Error: too many redirects (max 5)`.

### Tests

A new file `tests/web-fetch-ssrf.test.ts`. We spin up a local HTTP server (`node:http`) bound to `127.0.0.1:<random port>` that serves crafted redirects, then assert the tool refuses appropriately.

Cases:

1. **Redirect to loopback** — public-looking server returns 302 to `http://127.0.0.1/x` → refused.
2. **Redirect to link-local metadata** — 302 to `http://169.254.169.254/...` → refused.
3. **Redirect to IPv6 loopback** — 302 to `http://[::1]/x` → refused.
4. **Redirect chain stays public** — 2 hops within a public host (we mock `dns.lookup` to return `1.2.3.4`) → succeeds.
5. **Too many redirects** — server loops to itself 10 times → `Error: too many redirects`.
6. **Userinfo in URL** — `http://evil@127.0.0.1/x` → refused (hostname-based check still fires).
7. **DNS-private redirect** — redirect target hostname resolves to `127.0.0.1` (we mock `dns.lookup`) → refused.
8. **Credential header dropped on cross-origin redirect** — request with `Cookie` set redirects to a different origin; server logs received headers; assert no `Cookie` on the second hop. *(Verify the existing built-in behavior; if not present, document and skip.)*
9. **Plain success** — single 200 from `1.2.3.4`-resolving host → text content returned.
10. **Existing pre-check still works** — initial URL `http://127.0.0.1/x` → refused before any fetch.

For tests that need DNS mocking, use `bun:test` `mock.module` (or monkey-patch the imported dns helper).

## Out of scope

- TOCTOU close (custom undici `Dispatcher`).
- HTTPS certificate pinning.
- `WebSearch` tool (separate path).
- Request body / non-GET methods (the tool is GET-only).
- Rate limiting.

## Verification

- All new tests pass.
- `tests/permission.test.ts` etc. continue to pass (A3 is isolated to web-fetch).
- `bun run lint:engine-bypass` OK.
- A quick manual fetch against a real public URL (e.g. `https://example.com/`) still returns content.

## Risk and rollback

- Risk: a legitimate redirect that briefly transits a private-looking IP (e.g. some health-checked CDN) gets refused. Mitigation: error message names the resolved IP so users can diagnose; we can extend the allowlist later if a real-world case appears.
- Risk: `node:dns` resolution adds latency (10–50ms per hop). Acceptable for an LLM tool.
- Rollback: revert is local to `web-fetch.ts` and the new test file.
