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
Protocol v2, credential storage, automation scheduling or the later service moves.

Desktop bundles this package into its main process, so its dependency belongs in
Desktop `devDependencies`. The production workspace materialization list used by
`predist` also drives the packaging guard; bundled Host is not copied as a runtime
workspace symlink.

Panel workers use `CODE_SHELL_CREDENTIAL_ACCESS=local`: they read Core's local
credential store, not Desktop's credential IPC/safeStorage service. Foreign
safeStorage ciphertext fails closed; supported plaintext tags and legacy bare
plaintext remain readable under the existing local store rules. This is not
credential-service parity or a separate per-task vault.
