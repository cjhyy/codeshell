# CodeShell Host

Minimal HostRuntime foundation shared by Desktop, serve and Panel task workers.
Depends only on Core. The registry owns capability declarations, legacy worker
request classification and dispatch, and synchronous adapter/service lifecycle.
Adapters supply platform handlers; no Electron, transport or coding pack is loaded.

`interceptHostRequest` consumes unsupported worker requests before client routing.
Supported handlers keep their existing wire format. Ordinary approvals keep the
host client approval path; AskUser requires a real text-answer UI. Desktop/Web
retain that path, while Panel task hosts immediately return a typed `unavailable`
decision with an explicit unsupported reason. They never turn a yes/no confirmation
into a user answer; Core retires asynchronous questions without injecting an answer
or starting a follow-up run. This package does not implement
Protocol v2, credential storage, automation scheduling or output replay.

Desktop bundles this package into its main process, so its dependency belongs in
Desktop `devDependencies`. The production workspace materialization list used by
`predist` also drives the packaging guard; bundled Host is not copied as a runtime
workspace symlink.

Panel workers use `CODE_SHELL_CREDENTIAL_ACCESS=local`: they read Core's local
credential store, not Desktop's credential IPC/safeStorage service. Foreign
safeStorage ciphertext fails closed; supported plaintext tags and legacy bare
plaintext remain readable under the existing local store rules. This is not
credential-service parity or a separate per-task vault.

The first shared services live under `services/` and are exported from this package:

- `readSkillInventory(cwd)` combines Core discovery and effective enablement; it
  does not grant renderer file access or authorize mutations.
- `probeMcp(config, { cwd, signal })` owns the bounded sibling probe and closes it
  on completion, cancellation or timeout. The Core internal connection owns MCP
  SDK imports and stdio process groups; Host imports only Core and Node builtins.
- `probeConfiguredModel` owns Hub's existing tool-free, single-request connection
  test. This is an ownership move, not a replacement for model metadata/listing.
- `readSessionFile`/`readSessionFileSync` and candidate scanners share bounded
  ordinary-file reads, safe IDs and identity checks. Roots are explicit; default
  scanners use Core `sessionsRoot()`. Adapters retain their catalog semantics.

Storage consumers import `@cjhyy/code-shell-host/session-files`; that entry does
not load probes, model clients or skill inventory. List-only state reads retry
at most twice after an ordinary file is atomically replaced, while single-session
authorization reads reject identity changes. Desktop catalog state is capped at
2 MiB; oversized entries are omitted with `SESSION_LIST_STATE_TOO_LARGE`, without
logging state contents. Candidate discovery uses lstat and does not open transcripts.

MCP adapters select their stdio policy explicitly: Desktop tolerates non-JSON
launcher banners and valid JSON logger records that fail JSON-RPC validation;
Hub remains strict. Both retain byte limits, cancellation and process cleanup.
Optional HTTP GET/SSE diagnostics do not invalidate successful
POST requests. Host returns neutral error codes and bounded safe detail; adapters
choose local or server wording, and explicit credentials remain redacted.

Preview redaction treats authentication fields (including apikey/x-apikey),
envHeaders, bearerTokenEnvVar and explicit token argv as private at any length.
Other env/envVars and argv values of at least eight characters are also private,
including positional arguments; flag names are syntax. Short ordinary scalars
such as DEBUG=1, MODE=read and LOG_LEVEL=info keep tool names and descriptions
readable. Protocol/content-type headers remain ordinary text. This policy lives
in Host and applies to both adapters.

These explicit async methods do not change HostRuntime's synchronous lifecycle.
Desktop retains path grants/cache/OAuth resolution; Hub retains HTTP authority,
owner cancellation, review tokens, revision checks and mutation gates. Snapshot,
journal, output replay, UI catalog and transcript formatting remain with their
existing owners. See the [review evidence](../../../docs/todo/evidence/host-shared-services-cc-review-20261015.md)
for review state and validation limits.
