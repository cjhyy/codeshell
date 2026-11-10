# D2 preload contract mismatches — decision required (2026-11-10)

Baseline: `fcd8406d5`. Branch: `codex/desktop/d2-preload-type-contract`.
Worktree: `/private/tmp/codeshell-architecture-d2`.

Adding only `satisfies CodeshellApi` to the object passed to
`contextBridge.exposeInMainWorld("codeshell", ...)` produces **21 distinct
TypeScript diagnostics**, all in `packages/desktop/src/preload/index.ts`.
This exceeds the checklist's limit of 20. No mismatch has been fixed, the
experimental source edit has been restored, and the main-side pilot has not
been attempted. D2 remains pending the owner's decision; no guard was weakened.

Validation: root `bun run build` passed. `bun run --cwd packages/desktop typecheck`
failed with the 21 diagnostics below; because its first command failed, the mobile
pass was not reached. Dependencies are each checkout's own fresh workspace dist.

Reproduce: change the final `});` of preload/index.ts to
`} satisfies CodeshellApi);`, then rerun the Desktop typecheck. The full captured
output is included below and also at `/private/tmp/codeshell-d2-initial-typecheck.log`.

| # | Member | Baseline line:column | Code |
| --- | --- | --- | --- |
| 1 | `run` | `527:3` | TS2322 |
| 2 | `cancel` | `562:3` | TS2322 |
| 3 | `steer` | `576:3` | TS2322 |
| 4 | `unsteer` | `595:3` | TS2322 |
| 5 | `approve` | `619:3` | TS2322 |
| 6 | `keepWaitingForQuestion` | `698:3` | TS2322 |
| 7 | `closeSession` | `700:3` | TS2322 |
| 8 | `forkSession` | `701:3` | TS2322 |
| 9 | `configure` | `716:3` | TS2322 |
| 10 | `onStreamEvent` | `724:3` | TS2322 |
| 11 | `onApprovalRequest` | `777:3` | TS2322 |
| 12 | `onApprovalResolved` | `784:3` | TS2322 |
| 13 | `onMobileSessionSettings` | `791:3` | TS2322 |
| 14 | `onStatus` | `798:3` | TS2322 |
| 15 | `onAgentLifecycle` | `805:3` | TS2322 |
| 16 | `saveMemory` | `885:3` | TS2322 |
| 17 | `installLocalPanelApp` | `1254:3` | TS2322 |
| 18 | `onUpdaterStatus` | `1365:3` | TS2322 |
| 19 | `onEvent` | `1692:5` | TS2322 |
| 20 | `onMessage` | `1713:5` | TS2322 |
| 21 | `onRoomState` | `1817:5` | TS2322 |

The mismatches include RPC result types (`Promise<unknown>` versus declared
responses), the overloaded approval argument positions, event callback payload
annotations, SaveMemoryInput, and a missing packageDigest in the declared local
Panel install success result. This inventory does not decide which side should
change.

```text
$ tsc --noEmit && tsc -p tsconfig.mobile.json --noEmit
src/preload/index.ts(527,3): error TS2322: Type '(task: string, opts?: { cwd?: string; sessionId?: string; bucket?: string; browserPartition?: string; permissionMode?: string; planMode?: boolean; behaviorMode?: "quickChatRestricted"; workspaceProfile?: string; sessionBrief?: string; sessionMessageTargets?: Array<{ sessionId: string; title: string; workspaceRoot: s...' is not assignable to type '(prompt: string, opts?: { cwd?: string | undefined; sessionId?: string | undefined; bucket?: string | undefined; browserPartition?: string | undefined; permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "auto" | "plan" | undefined; ... 8 more ...; goal?: string | undefined; } | undefined) => Promise<...'.
  Type 'Promise<unknown>' is not assignable to type 'Promise<RpcResponse<unknown>>'.
    Type 'unknown' is not assignable to type 'RpcResponse<unknown>'.
src/preload/index.ts(562,3): error TS2322: Type '(sessionId?: string, options?: { keepGoal?: boolean; }) => Promise<unknown>' is not assignable to type '(sessionId?: string | undefined, options?: { keepGoal?: boolean | undefined; } | undefined) => Promise<RpcResponse<unknown>>'.
  Type 'Promise<unknown>' is not assignable to type 'Promise<RpcResponse<unknown>>'.
    Type 'unknown' is not assignable to type 'RpcResponse<unknown>'.
src/preload/index.ts(576,3): error TS2322: Type '(sessionId: string, text: string, id?: string, clientMessageId?: string, attachments?: InputAttachmentMeta[]) => Promise<unknown>' is not assignable to type '(sessionId: string, text: string, id?: string | undefined, clientMessageId?: string | undefined, attachments?: InputAttachmentMeta[] | undefined) => Promise<...>'.
  Type 'Promise<unknown>' is not assignable to type 'Promise<RpcResponse<unknown>>'.
    Type 'unknown' is not assignable to type 'RpcResponse<unknown>'.
src/preload/index.ts(595,3): error TS2322: Type '(sessionId: string, id: string) => Promise<unknown>' is not assignable to type '(sessionId: string, id: string) => Promise<RpcResponse<unknown>>'.
  Type 'Promise<unknown>' is not assignable to type 'Promise<RpcResponse<unknown>>'.
    Type 'unknown' is not assignable to type 'RpcResponse<unknown>'.
src/preload/index.ts(619,3): error TS2322: Type '(sessionIdOrRequestId: string, requestIdOrDecision: string | "approve" | "deny", decisionOrReason?: "approve" | "deny" | string, reasonOrAnswer?: string, answer?: string, scopeArg?: "once" | "session" | "project", pathScopeArg?: "file" | "dir" | "tool") => Promise<...>' is not assignable to type '{ (sessionId: string, requestId: string, decision: "approve" | "deny", reason?: string | undefined, answer?: string | undefined, scope?: "once" | "session" | "project" | undefined, pathScope?: "dir" | ... 2 more ... | undefined): Promise<...>; (requestId: string, decision: "approve" | "deny", reason?: string | undef...'.
  Types of parameters 'scopeArg' and 'pathScope' are incompatible.
    Type '"dir" | "file" | "tool" | undefined' is not assignable to type '"once" | "session" | "project" | undefined'.
      Type '"dir"' is not assignable to type '"once" | "session" | "project" | undefined'.
src/preload/index.ts(698,3): error TS2322: Type '(sessionId: string, requestId: string) => Promise<unknown>' is not assignable to type '(sessionId: string, requestId: string) => Promise<RpcResponse<unknown>>'.
  Type 'Promise<unknown>' is not assignable to type 'Promise<RpcResponse<unknown>>'.
    Type 'unknown' is not assignable to type 'RpcResponse<unknown>'.
src/preload/index.ts(700,3): error TS2322: Type '(sessionId: string) => Promise<unknown>' is not assignable to type '(sessionId: string) => Promise<RpcResponse<unknown>>'.
  Type 'Promise<unknown>' is not assignable to type 'Promise<RpcResponse<unknown>>'.
    Type 'unknown' is not assignable to type 'RpcResponse<unknown>'.
src/preload/index.ts(701,3): error TS2322: Type '(params: { sourceSessionId: string; targetSessionId?: string; mode: "full" | "summary"; forkKind?: "side"; throughEventId?: string; fromEventId?: string; toEventId?: string; quickChatClaimId?: string; }) => Promise<...>' is not assignable to type '(params: ForkSessionParams) => Promise<ForkSessionResult>'.
  Type 'Promise<unknown>' is not assignable to type 'Promise<ForkSessionResult>'.
    Type 'unknown' is not assignable to type 'ForkSessionResult'.
src/preload/index.ts(716,3): error TS2322: Type '(params: { sessionId?: string; model?: string; permissionMode?: string; planMode?: boolean; reloadModels?: boolean; reloadSettings?: boolean; }) => Promise<...>' is not assignable to type '(params: { sessionId?: string | undefined; model?: string | undefined; permissionMode?: string | undefined; planMode?: boolean | undefined; reloadModels?: boolean | undefined; reloadSettings?: boolean | undefined; }) => Promise<...>'.
  Type 'Promise<unknown>' is not assignable to type 'Promise<RpcResponse<unknown>>'.
    Type 'unknown' is not assignable to type 'RpcResponse<unknown>'.
src/preload/index.ts(724,3): error TS2322: Type '(cb: (env: { sessionId: string; event: unknown; }) => void) => (() => void)' is not assignable to type '(cb: (env: StreamEventEnvelope) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'env' and 'env' are incompatible.
      Type '{ sessionId: string; event: unknown; }' is not assignable to type 'StreamEventEnvelope'.
        Types of property 'event' are incompatible.
          Type 'unknown' is not assignable to type 'StreamEvent'.
src/preload/index.ts(777,3): error TS2322: Type '(cb: (req: unknown) => void) => (() => void)' is not assignable to type '(cb: (env: ApprovalRequestEnvelope) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'env' and 'req' are incompatible.
      Type 'unknown' is not assignable to type 'ApprovalRequestEnvelope'.
src/preload/index.ts(784,3): error TS2322: Type '(cb: (req: unknown) => void) => (() => void)' is not assignable to type '(cb: (env: ApprovalResolvedEnvelope) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'env' and 'req' are incompatible.
      Type 'unknown' is not assignable to type 'ApprovalResolvedEnvelope'.
src/preload/index.ts(791,3): error TS2322: Type '(cb: (env: unknown) => void) => (() => void)' is not assignable to type '(cb: (env: MobileSessionSettingsEnvelope) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'env' and 'env' are incompatible.
      Type 'unknown' is not assignable to type 'MobileSessionSettingsEnvelope'.
src/preload/index.ts(798,3): error TS2322: Type '(cb: (evt: unknown) => void) => (() => void)' is not assignable to type '(cb: (evt: AgentStatusEvent) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'evt' and 'evt' are incompatible.
      Type 'unknown' is not assignable to type 'AgentStatusEvent'.
src/preload/index.ts(805,3): error TS2322: Type '(cb: (evt: unknown) => void) => (() => void)' is not assignable to type '(cb: (evt: AgentLifecycleEvent) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'evt' and 'evt' are incompatible.
      Type 'unknown' is not assignable to type 'AgentLifecycleEvent'.
src/preload/index.ts(885,3): error TS2322: Type '(input: Record<string, unknown>) => Promise<any>' is not assignable to type '(input: SaveMemoryInput) => Promise<string>'.
  Types of parameters 'input' and 'input' are incompatible.
    Type 'SaveMemoryInput' is not assignable to type 'Record<string, unknown>'.
      Index signature for type 'string' is missing in type 'SaveMemoryInput'.
src/preload/index.ts(1254,3): error TS2322: Type '(input: { cwd: string; source: import("@cjhyy/code-shell-core").PanelAppSourceInput; reviewToken: string; overwrite?: boolean; }) => Promise<{ ok: true; id: string; } | { ok: false; alreadyInstalled?: true; previewChanged?: true; error: string; }>' is not assignable to type '(input: { cwd: string; source: PanelAppSourceInput; reviewToken: string; overwrite?: boolean | undefined; }) => Promise<{ ok: true; id: string; packageDigest: string; } | { ...; }>'.
  Type 'Promise<{ ok: true; id: string; } | { ok: false; alreadyInstalled?: true | undefined; previewChanged?: true | undefined; error: string; }>' is not assignable to type 'Promise<{ ok: true; id: string; packageDigest: string; } | { ok: false; alreadyInstalled?: true | undefined; previewChanged?: true | undefined; error: string; }>'.
    Type '{ ok: true; id: string; } | { ok: false; alreadyInstalled?: true | undefined; previewChanged?: true | undefined; error: string; }' is not assignable to type '{ ok: true; id: string; packageDigest: string; } | { ok: false; alreadyInstalled?: true | undefined; previewChanged?: true | undefined; error: string; }'.
      Type '{ ok: true; id: string; }' is not assignable to type '{ ok: true; id: string; packageDigest: string; } | { ok: false; alreadyInstalled?: true | undefined; previewChanged?: true | undefined; error: string; }'.
        Property 'packageDigest' is missing in type '{ ok: true; id: string; }' but required in type '{ ok: true; id: string; packageDigest: string; }'.
src/preload/index.ts(1365,3): error TS2322: Type '(cb: (status: unknown) => void) => (() => void)' is not assignable to type '(cb: (status: UpdaterStatus) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'status' and 'status' are incompatible.
      Type 'unknown' is not assignable to type 'UpdaterStatus'.
src/preload/index.ts(1692,5): error TS2322: Type '(cb: (event: unknown) => void) => (() => void)' is not assignable to type '(cb: (event: ImGatewayUiEvent) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'event' and 'event' are incompatible.
      Type 'unknown' is not assignable to type 'ImGatewayUiEvent'.
src/preload/index.ts(1713,5): error TS2322: Type '(cb: (env: { roomId: string; msg: unknown; }) => void) => (() => void)' is not assignable to type '(cb: (env: { roomId: string; msg: RoomMessageWire; }) => void) => Unsubscribe'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'env' and 'env' are incompatible.
      Type '{ roomId: string; msg: unknown; }' is not assignable to type '{ roomId: string; msg: RoomMessageWire; }'.
        Types of property 'msg' are incompatible.
          Type 'unknown' is not assignable to type 'RoomMessageWire'.
src/preload/index.ts(1817,5): error TS2322: Type '(cb: (room: unknown) => void) => (() => void)' is not assignable to type '(cb: (room: RoomPublic) => void) => () => void'.
  Types of parameters 'cb' and 'cb' are incompatible.
    Types of parameters 'room' and 'room' are incompatible.
      Type 'unknown' is not assignable to type 'RoomPublic'.
```
