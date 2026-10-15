# CodeShell Host

Minimal HostRuntime foundation shared by Desktop, serve and Panel task workers.
Depends only on Core. The registry owns capability declarations, legacy worker
request classification and dispatch, and synchronous adapter/service lifecycle.
Adapters supply platform handlers; no Electron, transport or coding pack is loaded.

`interceptHostRequest` consumes unsupported worker requests before client routing.
Supported handlers keep their existing wire format; ordinary approvals and AskUser
continue through the host's client approval path. This package does not implement
Protocol v2, credential storage, automation scheduling or the later service moves.
