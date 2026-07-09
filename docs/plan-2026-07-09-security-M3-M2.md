# 2026-07-09 security M3/M2 统一实现方案

> 范围：只做设计。本文面向后续串行实现，不修改 `packages/**`。  
> 基线事实来自 `docs/review-2026-07-09/pre-beta-05-security-investigation.md`，并用当前代码重新核对了 file:line。

## 0. 结论先行

- **先做 M3，再做 M2**。M3 先把 `sessionId -> bucket -> guest/partition` 路由收紧；M2 的 `InjectCredential` 和 cookie restore 会复用同一条 main↔worker 桥，如果先做 M2，会在仍可能跨 session 注入的桥上叠加加密改造，测试边界更乱。
- **M2 L 档推荐方案：方案 (c) 混合**。worker 持有无 secret 的 credential metadata snapshot，以及必须进入子进程环境的少量派生结果（`exposeAsEnv`）；真正的 token/link/cookie secret material 由 main 的 safeStorage-backed credential service 按需解密/派生后返回。理由：覆盖现有同步调用点的侵入面小于全 async 化，同时避免方案 (a) 把所有凭证明文一次性灌进 worker。
- **安全目标边界**：L 档解决 at-rest 加密。被实际使用的 secret 仍会在 worker/main/子进程内存或临时 `cookies.txt` 中短暂出现，这是现有 agent 执行模型不可避免的运行时暴露；关键是 `credentials.json` 不再明文落盘，且 worker 不再直接读取 `enc:safeStorage:*` 密文文件。

## 1. 现状事实

### 1.1 M3 browser automation / cookie 注入跨 session

已确证：

- renderer 已按 bucket 隔离浏览器 partition：`packages/desktop/src/renderer/panels/PanelArea.tsx:425-429` 把 browser panel partition 设成 `persist:browser:<sanitized bucket>`。
- `<webview>` partition 已冻结，避免 React rerender 后串 partition：`packages/desktop/src/renderer/browser/WebviewHost.tsx:21-32`。
- main 只允许 `persist:browser` 前缀 partition，拒绝任意 partition：`packages/desktop/src/main/index.ts:1217-1227`。
- main 侧 guest registry 仍是全局单例：`packages/desktop/src/main/browser-driver/active-guest.ts:13-35` 只有 `active` 和 `guests`，没有 `sessionId`/`bucket`/`partition`。
- attach 时只 `registerGuest(guest)`，没有登记 bucket/partition：`packages/desktop/src/main/index.ts:1229-1231`。
- worker 的 browser action 已带 `sessionId`，parser 也保留了它：`packages/desktop/src/main/browser-driver/intercept.ts:40-43`。
- AgentBridge 处理 browser action 时忽略 `parsed.sessionId`，仍把全局 `activeGuest/listGuests/focusGuest` 传给 automation host：`packages/desktop/src/main/agent-bridge.ts:398-419`。
- `handleBrowserAction` 依赖注入的 target 仍是单个 `activeGuest()`：`packages/desktop/src/main/browser-driver/automation-host.ts:90-108`、`:130-139`。
- auto-open 从 main 发全局 `browser:open-url`，不带 session/bucket：`packages/desktop/src/main/agent-bridge.ts:553-564`、`packages/desktop/src/preload/index.ts:165-173`、`packages/desktop/src/renderer/App.tsx:3061-3079`。
- `InjectCredential` 的 worker 请求带 `sessionId`，main 已用它解析 cwd：`packages/desktop/src/main/agent-bridge.ts:466-479`；但注入目标仍是全局 `activeGuest()?.session`：`packages/desktop/src/main/agent-bridge.ts:483-492`。
- cookie restore 后 reload 是全窗口广播：AI 注入路径 `packages/desktop/src/main/agent-bridge.ts:493-495`；手动 restore 路径 `packages/desktop/src/main/index.ts:1871-1874`；renderer 每个 browser panel 都监听无 bucket reload：`packages/desktop/src/renderer/browser/useBrowserTabs.ts:287-290`。
- 手动 cookie capture/restore 已经把 bucket 传进 main：preload `packages/desktop/src/preload/index.ts:1030-1052`，CookieTab `packages/desktop/src/renderer/credentials/CookieTab.tsx:190-197`、`:239-243`，main `packages/desktop/src/main/index.ts:1814-1844`、`:1852-1876`。

推测/需实现时验证：

- renderer 当前只有它自己可靠知道 UI `bucket`（`repoKey::sessionId`）和 engine session route；main 不应从 cwd 反推 bucket。`App.tsx` 已有 `engineToBucketRef` 路由语义：`packages/desktop/src/renderer/App.tsx:449-475`、`:1538-1566`。
- Electron `did-attach-webview` 事件本身不足以恢复原始 bucket。需要 renderer 在 webview attach 后把 `guestId + bucket + partition + engineSessionId` 注册回 main，或在 `agent/run` 前单独注册 `sessionId -> bucket`。

### 1.2 M2 明文凭证 / SafeStorageCipher 未启用

已确证：

- `CredentialStore` 在读盘边界解密，调用者拿到 plaintext secret：`packages/core/src/credentials/store.ts:74-87`。
- `CredentialStore` 在写盘边界加密 secret：`packages/core/src/credentials/store.ts:92-109`。
- 当前默认 cipher 是 `PlaintextCipher`，写 `plain:<secret>`：`packages/core/src/credentials/cipher.ts:41-57`、`:71-82`。
- `SafeStorageCipher` 已实现，输出 `enc:safeStorage:<base64>`；safeStorage 不可用时回退 `plain:`：`packages/desktop/src/main/credential-cipher.ts:19-50`。
- desktop main 已 import `setDefaultCredentialCipher` / `SafeStorageCipher`，但 app ready 时故意不安装 safeStorage cipher：`packages/desktop/src/main/index.ts:1595-1605`。
- agent worker 是独立子进程：`packages/desktop/src/main/agent-bridge.ts:157-160`。worker 入口 `packages/core/src/cli/agent-server-stdio.ts:1-7`，没有 Electron safeStorage。
- `EncryptionCipher` 是同步接口：`packages/core/src/credentials/cipher.ts:19-30`。不能在 `decrypt()` 内做跨进程 async 请求。

worker 侧所有读 `CredentialStore` / 获取 secret plaintext 的调用点：

| 链路 | 当前 file:line | 当前行为 | L 档改造后 |
| --- | --- | --- | --- |
| UseCredential 动态描述 | `packages/core/src/credentials/use-credential-tool.ts:65-73` | `new CredentialStore(cwd).listMasked()`；虽然输出脱敏，但会经 `list()->read()->decrypt` | 改读 metadata snapshot；不触碰 disk secret，也不触发 safeStorage 解密 |
| UseCredential list | `packages/core/src/credentials/use-credential-tool.ts:151-162` | 构造 `CredentialStore`，无 id 时 `listMasked(scope)` | 改 `credentialAccess.listMasked(cwd, scope)`；desktop worker 从 main snapshot 读 metadata |
| UseCredential token/link | `packages/core/src/credentials/use-credential-tool.ts:165-194` | `resolve(id, scope)` 后直接返回 `cred.secret` | gate 仍用 metadata 的 `label/autoUseByAI/type`；通过 async host resolver `resolveValue(id, scope, cwd)` 向 main 要 plaintext value |
| UseCredential cookie materialize | `packages/core/src/credentials/use-credential-tool.ts:197-214` | worker 解析 `cred.secret` 并写临时 Netscape `cookies.txt` | gate 仍在 worker；通过 host resolver 请求 main 解密 cookie jar，并由 main 直接 materialize `cookies.txt` 或返回 Netscape 文本给 worker 写。推荐 main materialize，worker 只拿 `{cookiesFile,count}` |
| exposeAsEnv | `packages/core/src/engine/engine.ts:3428-3436` | `new CredentialStore(cwd).envExposures(credScope)` 同步返回 `ENV -> secret` | main 在 snapshot 中预派生 `envExposures`；worker 的 `readShellEnv()` 同步读取该派生 map。进入 shell env 的 plaintext 是必要暴露 |
| InjectCredential 可见性 guard | `packages/core/src/credentials/inject-credential-tool.ts:96-101` | `listMasked(...).some(type==="cookie")` | 改 metadata snapshot；只判断 cookie metadata |
| InjectCredential 工具执行 | `packages/core/src/credentials/inject-credential-tool.ts:131-164` | worker `resolve()` 得 cookie credential，用 metadata gate；实际 restore 走 `ctx.injectCredentialToBrowser` | worker 不读 secret；metadata gate 后调用 host inject。main 用 safeStorage decrypt jar 并 restore 到 M3 指定 bucket/session |
| MCP credentialRef | `packages/core/src/tool-system/mcp-manager.ts:475-480` | `new CredentialStore(undefined).resolve(id)?.secret` 组 HTTP Authorization | `performConnect()` 已 async，改为 await host credential resolver，再调用纯 `buildHttpHeaders()`；headless fallback 用 local store |
| tool 可见性 guard | `packages/core/src/tool-system/builtin/index.ts:858-862` | `new CredentialStore(cwd).listMasked().length > 0` | 改 metadata snapshot；若 desktop worker snapshot 不可用，fail-closed 隐藏 credential 工具 |

main 侧也会读 secret，但 main 可以安装 `SafeStorageCipher`：

- UI credential list/save/remove/patch：`packages/desktop/src/main/index.ts:1777-1812`。
- 手动 restore cookie：`packages/desktop/src/main/index.ts:1857-1871`。
- AI InjectCredential host action：`packages/desktop/src/main/credential-action.ts:19-27`。
- MCP probe：`packages/desktop/src/main/mcp-probe-service.ts:182-183`。

## 2. M3 完整修设计

### 2.1 数据模型

新增 main 侧 registry（替换 `active-guest.ts` 的全局 active 单例语义）：

```ts
type BrowserBucket = string;       // renderer 原始 bucket，例如 repoKey::sessionId
type BrowserPartition = string;    // persist:browser:<sanitized bucket>

interface GuestRecord {
  guest: WebContents;
  guestId: number;
  bucket: BrowserBucket;
  partition: BrowserPartition;
  engineSessionId?: string;
  windowId?: number;
  attachedAt: number;
  lastFocusedAt: number;
  source: "panel" | "popout";
}
```

索引：

- `byGuestId: Map<number, GuestRecord>`
- `guestIdsByBucket: Map<BrowserBucket, Set<number>>`
- `activeGuestIdByBucket: Map<BrowserBucket, number>`
- `bucketBySessionId: Map<string, BrowserBucket>`
- `partitionByBucket: Map<BrowserBucket, BrowserPartition>`

核心 API：

- `registerSessionBucket(sessionId, bucket, partition?)`
- `registerGuest({ guest, bucket, partition, engineSessionId?, source })`
- `activeGuestForBucket(bucket): WebContents | null`
- `activeGuestForSession(sessionId): { guest, bucket, partition } | null`
- `listGuestsForBucket(bucket): GuestTab[]`
- `focusGuestForBucket(bucket, tabId): boolean`
- `partitionForSession(sessionId): BrowserPartition | null`
- `forgetSession(sessionId)`：清 `bucketBySessionId`，不强行销毁 guest；guest destroy 时自清。

保留 `listGuestSessions()` 只服务“抓所有当前活着的浏览器面板 session”这种显式 all-sessions UI 功能，不能被 automation/inject 默认使用。

### 2.2 sessionId -> bucket 映射来源

main 不反推 bucket，**由 renderer 注册**：

- `App.tsx` / send path 在发 `agent/run` 时，把 `{ sessionId, bucket: activeBucket }` 作为 main-only routing metadata 交给 AgentBridge；AgentBridge 存 `sessionId -> bucket` 后，转发给 worker 前剥离该 main-only 字段，避免污染 core protocol。
- renderer 每次 session 选择、engine session 绑定、snapshot rehydrate 后，也可调用独立 IPC `browser:register-session-bucket`，作为 run 前预热和 reload 后恢复。
- `PanelArea.tsx` 已拿到 `bucket` 与 `engineSessionId`：`packages/desktop/src/renderer/panels/PanelArea.tsx:390-415`。把二者继续传给 `BrowserPanel/WebviewHost`。
- `WebviewHost` 在 webview attach/dom-ready 后用 `webview.getWebContentsId()` 通过 preload 调 `browser:guest-attached`，payload 带 `{ guestId, bucket, partition, engineSessionId }`。main 用 `webContents.fromId(guestId)` 找到 guest 并完成 registry enrichment。

如果 main 在 `did-attach-webview` 先看到 guest 但还没收到 renderer metadata，先放入 pending；automation 不允许使用 pending guest。超时未登记则丢弃并记录 debug log。

### 2.3 调用点改法

browser action：

- `parseBrowserActionLine()` 已保留 `sessionId`：`intercept.ts:40-43`，无需重造协议。
- `AgentBridge.maybeHandleBrowserAction()` 改为：
  - 无 `parsed.sessionId`：返回 `{ ok:false, detail:"browser action missing sessionId" }`。
  - `sessionId` 找不到 bucket：返回 `{ ok:false, detail:"no browser bucket registered for session ..." }`。
  - deps 包装为当前 session/bucket：
    - `activeGuest: () => activeGuestForSession(parsed.sessionId)?.guest ?? null`
    - `openPanel: (url) => openBrowserPanelForSession(parsed.sessionId, url)`
    - `listTabs: () => listGuestsForSession(parsed.sessionId)`
    - `switchTab: (tabId) => focusGuestForSession(parsed.sessionId, tabId)`
- `handleBrowserAction()` 可基本不改；它只消费 deps。若实现时要让错误更明确，可把 deps 类型从 `activeGuest()` 扩为 `targetGuest()`，但不是必要依赖。

auto-open / `browser_navigate`：

- `openBrowserPanel(url)` 改 `openBrowserPanelForSession(sessionId, url)`。
- main 发 `browser:open-url` payload：`{ sessionId, bucket, url }`。
- preload `browser:open-url` re-dispatch `codeshell:open-url` 时保留 bucket。
- `App.tsx` 的 `onOpenUrl` 不再用 `activeBucketRef.current`，而是优先使用 `detail.bucket`；没有 bucket 才允许旧的 clicked-link path 使用 active bucket。
- open 后 polling `activeGuestForBucket(bucket)`，不能 polling 全局 `activeGuest()`。
- 找不到 bucket 或 6s 内没有目标 guest attach：fail-closed，返回可行动错误“请打开该对话的浏览器面板后重试”。

InjectCredential：

- `inject-credential-tool.ts` 继续只发 `{ credentialId, credentialScope }`，sessionId 由 `AgentServer` envelope 带上。
- `AgentBridge.maybeHandleCredentialAction()` 保留当前 “用 originating sessionId 解析 cwd” 逻辑：`agent-bridge.ts:466-479`。
- 目标改为：
  - `const target = targetForSession(parsed.sessionId)`；
  - 无 sessionId/bucket/guest：fail-closed，不 fallback 到 `activeGuest()` 或默认 `persist:browser`。
  - `restoreCookiesToBrowser(jar, mode, target.guest.session)` 或直接用 registry 的 `partition`；两者必须和 bucket 校验一致。
- restore 后只发 `browser:reload` 给目标 bucket：`{ bucket }`。

手动 cookie restore：

- `credentials:restoreCookieToBrowser` 已接收 `bucket`：`main/index.ts:1852-1876`。
- 增加 `bucket` 校验：必须是当前 renderer 已注册的 bucket，或至少能被 `browserPartitionForBucket(bucket)` 规范化；空 bucket 不再隐式 restore 到 shared partition，除非调用方显式声明 legacy/popout。
- reload payload 改 `{ bucket }`；`useBrowserTabs.ts:287-290` 只 reload 自己 bucket 匹配的 panel。

popup / open-tab：

- `guest.setWindowOpenHandler()` 当前发全局 `browser:open-tab`：`main/index.ts:1242-1244`。
- 通过 `byGuestId` 找该 guest 的 bucket，payload 改 `{ url, bucket }`；renderer 的 `onBrowserOpenTab` 只处理当前 panel bucket。

### 2.4 fail-closed 行为

- automation 收到无 `sessionId`、无 `sessionId -> bucket`、bucket 下无 live guest、tabId 不属于该 bucket：返回 `{ ok:false, detail }`，不操作任何浏览器。
- InjectCredential 找不到目标 bucket/guest：返回 `{ ok:false, error }`，不 restore cookie。
- reload 没有 bucket：不广播；记录 warning。
- manual all-sessions capture 保持显式 all-sessions 功能，但 UI 文案必须继续说明会合并所有 live browser sessions。

### 2.5 M3 回归风险

- 单面板：低。注册多一步，但路由结果应等价。
- 多 session：中。以前“误打到当前 active”会变成 fail-closed 或打到正确 bucket；可能暴露“目标 session 没打开 browser panel”的 UX，需要清晰错误。
- popout/legacy：中。`BrowserPanel` 注释称 popout/legacy 默认 shared partition：`packages/desktop/src/renderer/panels/BrowserPanel.tsx:84-91`。需要决策 popout 是否参与 AI automation；默认建议不参与，除非显式绑定 owner bucket。
- 并发 attach：中。`did-attach-webview` 与 renderer `guest-attached` 注册有竞态，需要 pending + timeout + destroy cleanup。
- renderer reload：中。全局 reload 改成定向后，未传 bucket 的老调用不会刷新，需要测试所有 restore 路径。

## 3. M2 L 档设计

### 3.1 三种 worker 明文方案比较

#### (a) 启动时 main 解密全量 plaintext snapshot 喂给 worker

优点：

- 侵入面最小，现有 `CredentialStore` 同步调用点可以用内存 store 兼容。
- UseCredential、env、MCP、guard 几乎不用 async 化。

缺点：

- worker 内存持有所有 user/project 凭证明文，包含本轮不使用的 secret。
- 单 worker 服务多 session，snapshot 范围很容易扩大到“所有已知项目 + user”。
- credential 在 UI 中新增/修改后，worker snapshot 会 stale；必须额外做刷新协议。
- 如果通过 env var 传 snapshot，会泄漏到子进程环境，绝对不能这么做；只能走私有 stdio/control IPC。

#### (b) CredentialStore secret 读取改 async / host resolver

优点：

- 安全收益最好：secret 默认留在 main，worker 按需拿当前要用的一条。
- UI 更新天然实时。

缺点：

- 现有同步面太多：`EncryptionCipher`、`CredentialStore.list/resolve/envExposures/listMasked`、`Engine.readShellEnv()`、tool visibility guard 都是同步。
- 把 `Engine.buildToolContext()` / per-turn toolDefs assembly / MCP connect / credential tools 全部 async 化，侵入面大，容易影响非 desktop core/TUI/SDK。

#### (c) 混合：metadata snapshot + host secret/materializer resolver（推荐）

做法：

- worker 持有 **无 secret metadata snapshot**：`id/type/label/autoUseByAI/autoInjectByAI/exposeAsEnv/meta/hasSecret/secretHint`。
- worker 同步调用点只读 metadata 或 main 预派生结果：
  - dynamic tool description、tool guard、InjectCredential availability 读 metadata；
  - `exposeAsEnv` 读 main 预派生的 `ENV -> plaintext` map，因为这些值本来必须进入 shell child process env。
- 需要真正 secret 的路径用 async host resolver：
  - UseCredential token/link：resolver 返回 plaintext value；
  - UseCredential cookie：resolver/materializer 返回 `cookiesFile,count`；
  - MCP credentialRef：`performConnect()` await resolver；
  - InjectCredential：worker 不拿 jar，main restore。

推荐理由：

- 覆盖现有同步调用点，不需要把整个 engine/tool visibility 改 async。
- 不把所有凭证明文一次性灌入 worker；只有实际使用的 secret 和 env-exposed 派生值进入 worker/子进程。
- headless/SDK 仍可用默认 local `CredentialStore + PlaintextCipher`，不依赖 Electron。

### 3.2 新的 credential access 契约

在 core 增加一个 host-agnostic credential access 层，默认实现仍是 local disk store：

```ts
interface CredentialMetadata {
  id: string;
  type: "token" | "link" | "cookie";
  label: string;
  autoUseByAI?: boolean;
  autoInjectByAI?: boolean;
  exposeAsEnv?: string;
  meta?: Record<string, unknown>;
  hasSecret: boolean;
  secretHint?: string;
}

interface CredentialAccess {
  listMasked(cwd: string | undefined, scope: "full" | "project"): CredentialMetadata[];
  resolveMeta(cwd: string | undefined, id: string, scope: "full" | "project"): CredentialMetadata | undefined;
  envExposures(cwd: string | undefined, scope: "full" | "project"): Record<string, string>;
  resolveValue?(req: { cwd?: string; id: string; scope: "full" | "project"; purpose: "use" | "mcp" }): Promise<string>;
  materializeCookie?(req: { cwd?: string; id: string; scope: "full" | "project" }): Promise<{ cookiesFile: string; count: number }>;
}
```

默认 local implementation：

- 用现有 `new CredentialStore(cwd)`，保持 TUI/headless/SDK 行为。
- 默认 cipher 仍是 `PlaintextCipher`。
- 如果遇到 foreign `enc:*` 且没有可用 cipher，不能把 `enc:safeStorage:*` 当成 secret 返回；应返回 credential unavailable / empty secret 的错误，避免 agent 把 ciphertext 当 token 用。

desktop worker implementation：

- `agent-server-stdio.ts` 启动时安装 IPC-backed `CredentialAccess`。
- main 在每次 `agent/run` 前发送 fresh metadata snapshot（user + 该 session cwd 的 project）和 `envExposures`。
- worker 的 resolver 请求走私有 stdio control message，AgentBridge 拦截后由 main 解密/派生并回包。该 control message 不转发 renderer，不进入 transcript。
- main 维护 version/revision。UI save/remove/patch 后 bump revision；下次 run 前强制刷新 snapshot。若运行中修改，可选择立即 push snapshot；最低要求是下一 turn/run 生效。

### 3.3 每条 worker 链路改造

UseCredential 工具：

- `useCredentialToolDefFor(cwd)` 改读 `CredentialAccess.listMasked()`；输出只含 id/type，不含 secret。
- `useCredentialTool()` 开始时取 access，不再直接 `new CredentialStore(cwd)`。
- 无 id：metadata list。
- 有 id：`resolveMeta()` 拿 label/type/autoUseByAI，执行现有 `credentialUseGate()`。
- token/link gate 通过后：`await access.resolveValue({ cwd, id, scope, purpose:"use" })`；返回 `{ kind:"value", value }`。
- cookie gate 通过后：`await access.materializeCookie({ cwd, id, scope })`；返回 `{ kind:"cookie", cookiesFile, count }`。推荐 main 解密 jar 并写临时 `cookies.txt`，这样 worker 不拿 cookie jar JSON。
- headless/local fallback：materialize 逻辑沿用 `parseCookieJar()` + `formatNetscapeCookies()` + `writeFileSync(..., 0o600)`。

exposeAsEnv：

- `Engine.readShellEnv()` 中 `new CredentialStore(cwd).envExposures(credScope)` 改成 `credentialAccess.envExposures(cwd, credScope)`。
- desktop worker 这里读取 snapshot 内的 main-prederived map，同步返回，避免 `readShellEnv()` async 化。
- 仍保持当前 layering：`localEnvironment.env` floor，credential env 低于 `settings.env`，见 `engine.ts:3427-3436`。

InjectCredential 工具侧：

- `isInjectCredentialAvailable()` 改读 metadata snapshot，判断是否存在 `type:"cookie"`。
- `injectCredentialTool()` 的 `resolve(id, scope)` 改 `resolveMeta()`；只用 metadata 做 type check、label、`autoInjectByAI` gate。
- gate 通过后继续调用 `ctx.injectCredentialToBrowser(cred.id, scope)`。
- main 的 `resolveCookieCredentialForBrowser()` 在安装 `SafeStorageCipher` 后解密 cookie jar；再结合 M3 的 target bucket restore。

MCP credentialRef：

- `buildHttpHeaders()` 保持纯同步 helper。
- `MCPManager.performConnect()` 已经 async；在 HTTP transport 分支中：
  - 如果 `config.credentialRef` 存在，先 `await credentialAccess.resolveValue({ cwd: undefined, id, scope:"full", purpose:"mcp" })`。
  - 再把 resolver 结果喂给 `buildHttpHeaders()`。
- desktop worker 通过 main resolver 解密；headless/SDK fallback 读 local user-scope store。
- desktop main 的 MCP probe 仍在 main 内读 store：`mcp-probe-service.ts:182-183`，安装 `SafeStorageCipher` 后自然可解。

tool 可见性 guard：

- `isUseCredentialAvailable(cwd)` 改为 metadata `listMasked(cwd, scope).length > 0`。
- `BUILTIN_TOOL_GUARDS` 当前 guard ctx 已有 `cwd/settingsScope`：`builtin/index.ts:842-853`，确保 UseCredential guard 也接收 settingsScope，避免 project-scope 泄露 user metadata。

CredentialStore / cipher：

- `CredentialStore` 继续是 disk boundary abstraction，desktop main 使用 `SafeStorageCipher`，core/headless 默认 `PlaintextCipher`。
- 增加测试确保 `PlaintextCipher`/local fallback 遇到 `enc:safeStorage:` 时 fail-closed，不把 ciphertext 作为 plaintext secret 返回给工具。

### 3.4 迁移策略

推荐 **startup 一次性迁移 + lazy 补迁移**：

- desktop app ready 时先 `setDefaultCredentialCipher(new SafeStorageCipher())`，替换 `main/index.ts:1595-1605` 的 no-op。
- 立即迁移 user store：`~/.code-shell/credentials.json`。
- 对已知 project store 迁移：复用类似 `knownAttachmentCwds()` 的项目枚举（`main/index.ts:1560-1575`），覆盖 `loadProjects()` 和 no-repo cwd。
- 迁移过程：用 `SafeStorageCipher.decrypt()` 读 `plain:` 和 legacy bare plaintext，然后写回同一 credential，触发 `CredentialStore.write()` 输出 `enc:safeStorage:*`。
- 对未知项目的 `.code-shell/credentials.json`：当 UI/agent 第一次访问该 cwd 的 credentials 时 lazy rewrite。
- 迁移必须幂等：已有 `enc:safeStorage:*` 不 double encrypt；现有 `cipher.test.ts:63-78` 已覆盖 fake cipher 单层语义，需加 safeStorage/fake host 迁移测试。
- 文件权限保持 0o600；如果实现时发现目录权限未固定，补 0o700。

兼容输入：

- `plain:<secret>`：safeStorage 可读，迁移后写 `enc:safeStorage:*`。
- legacy bare plaintext：safeStorage 可读，迁移后写 `enc:safeStorage:*`。
- foreign `enc:*`：main 无法解密时保留但标记 unavailable；不得把原文传给 worker。

### 3.5 平台降级

`SafeStorageCipher.encrypt()` 在 safeStorage 不可用时回退 `plain:`：`packages/desktop/src/main/credential-cipher.ts:28-31`。

方案行为：

- macOS/Windows/有 keyring 的 Linux：默认写 `enc:safeStorage:*`。
- Linux/无 keyring/portable 环境：继续写 `plain:`，但 UI 必须明确提示“OS keychain unavailable，credentials are stored owner-only plaintext (0o600)”。
- main 提供 `credentials:securityStatus` 或复用 credential list payload 带状态：`{ mode:"safeStorage" | "plaintext-fallback", reason? }`。
- 记录一次 warning log，但不要阻止保存，除非卡密sama 决定改成 strict mode。

### 3.6 headless / SDK / project-scope

- 纯 core/TUI/SDK 没有 Electron main，继续默认 `PlaintextCipher` + local `CredentialStore`。
- `settingsScope:"project"` 仍只读 project store，不读 user store；现有隔离语义在 `CredentialStore.list()` / `envExposures()` 已有测试：`store.test.ts:55-71`、`:111-119`。
- desktop worker 如果 IPC credential access 未安装，不应 fallback 读取 `enc:safeStorage:*` 文件；desktop host 下这是配置错误，credential secret 相关操作 fail-closed。
- project-scope metadata snapshot 只能包含 project credentials；full scope 才合并 user + project。

## 4. 串行 stage 分解

### Stage 0：补齐 characterization tests（不改变行为）

目标：先把当前风险写成 failing tests，避免 M3/M2 交错时误判。

文件：

- `packages/desktop/src/main/browser-driver/active-guest.test.ts`（新增）
- `packages/desktop/src/main/browser-driver/intercept.test.ts`
- `packages/core/src/credentials/use-credential-tool.test.ts`
- `packages/core/src/engine/engine.shell-env.test.ts`
- `packages/core/src/tool-system/mcp-manager.test.ts`

断言：

- 两个 bucket 各有 guest，A session 的 action 不允许选择 B active guest。
- `parseBrowserActionLine()` / `parseCredentialActionLine()` 缺 sessionId 时后续桥应 fail-closed。
- fake encrypted store 下，UseCredential/exposeAsEnv/MCP 不应返回 ciphertext。

风险：测试可能需要把 AgentBridge 的路由逻辑抽成纯 helper，否则直接测 Electron bridge 成本高。

### Stage 1：M3 guest registry 与 renderer 注册契约

文件：

- `packages/desktop/src/main/browser-driver/active-guest.ts`
- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/panels/PanelArea.tsx`
- `packages/desktop/src/renderer/panels/BrowserPanel.tsx`
- `packages/desktop/src/renderer/browser/WebviewHost.tsx`
- `packages/desktop/src/renderer/browser/useBrowserTabs.test.ts`

对外契约变化：

- 新增 internal IPC：`browser:register-session-bucket`、`browser:guest-attached`。
- `onBrowserOpenTab` payload 从 `{ url }` 扩展为 `{ url, bucket? }`。

TDD 断言：

- `activeGuestForBucket("A")` 和 `activeGuestForBucket("B")` 独立更新 focus。
- destroy A guest 不影响 B active。
- `focusGuestForBucket("A", tabIdOfB)` 返回 false。
- renderer 注册的 partition 必须等于 `persist:browser:<sanitized bucket>`；不一致拒绝登记。

回归风险：webview attach 竞态；StrictMode 双注册；popout 没有 bucket。

### Stage 2：M3 browser action / auto-open 定向路由

文件：

- `packages/desktop/src/main/agent-bridge.ts`
- `packages/desktop/src/main/browser-driver/automation-host.ts`（尽量只改类型/错误文案）
- `packages/desktop/src/main/browser-driver/intercept.test.ts`
- `packages/desktop/src/main/browser-driver/automation-host.test.ts`
- `packages/desktop/src/renderer/App.tsx`
- `packages/desktop/src/preload/index.ts`

对外契约变化：

- `browser:open-url` payload 带 `{ sessionId, bucket, url }`。
- AgentBridge 需要保存 `sessionId -> bucket`，和既有 `sessionId -> cwd` 同生命周期。

TDD 断言：

- A session 发 `browser_navigate`，即使 B guest 最近 focus，也只调用 A bucket 的 guest/openPanel。
- A session `list_tabs` 只返回 A bucket tabs。
- A session `switch_tab` B tabId fail。
- 无 bucket mapping / 无 live guest 时返回 `{ok:false}`，不 fallback。

回归风险：clicked chat link 仍应走 active bucket；AI auto-open 才要求 explicit bucket。

### Stage 3：M3 InjectCredential / cookie restore / reload 定向

文件：

- `packages/desktop/src/main/agent-bridge.ts`
- `packages/desktop/src/main/credential-action.ts`
- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/preload/index.ts`
- `packages/desktop/src/preload/types.d.ts`
- `packages/desktop/src/renderer/browser/useBrowserTabs.ts`
- `packages/desktop/src/renderer/credentials/CookieTab.tsx`（若需传更严格 bucket）

对外契约变化：

- `browser:reload` payload 从无参改 `{ bucket }`。
- AI InjectCredential 无目标 bucket/guest 时失败，不再写入最近 active guest。

TDD 断言：

- A session InjectCredential 只调用 A guest session/partition 的 `restoreCookiesToBrowser`。
- restore 后只向 A bucket BrowserPanel reload；B 不 reload。
- 手动 restore `activeBucket` 空时 fail 或明确 legacy，不默默 shared partition。

回归风险：用户手动“切换账号”时当前 browser panel 未挂载，是否允许只写 partition 不 reload需拍板。

### Stage 4：M2 core credential access abstraction

文件：

- `packages/core/src/credentials/access.ts`（新增）
- `packages/core/src/credentials/store.ts`
- `packages/core/src/credentials/cipher.ts`
- `packages/core/src/credentials/use-credential-tool.ts`
- `packages/core/src/credentials/inject-credential-tool.ts`
- `packages/core/src/engine/engine.ts`
- `packages/core/src/tool-system/builtin/index.ts`
- `packages/core/src/tool-system/mcp-manager.ts`
- `packages/core/src/tool-system/context.ts`

对外契约变化：

- core 新增 optional credential access provider；默认 local disk provider 保持 headless/SDK 兼容。
- `InjectCredentialFn` 不必传 secret，仍传 id/scope。
- MCPManager 可接收 credential resolver 或从 runtime/global provider 取。

TDD 断言：

- fake provider 下 UseCredential token 返回 provider plaintext，不读 disk。
- fake provider 下 cookie materialize 返回 provider 的 cookiesFile/count。
- `Engine.readShellEnv()` 使用 provider envExposures，且 `settings.env` 仍覆盖 credential env。
- `isUseCredentialAvailable` / `isInjectCredentialAvailable` 只看 metadata。
- foreign `enc:safeStorage:*` 在 local plaintext fallback 下不作为 secret 返回。

回归风险：tool guard 当前签名只有 cwd 的地方要扩 settingsScope；MCPManager 构造签名影响测试。

### Stage 5：M2 desktop main safeStorage service 与 worker handshake

文件：

- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/main/credential-cipher.ts`
- `packages/desktop/src/main/agent-bridge.ts`
- `packages/core/src/cli/agent-server-stdio.ts`
- `packages/core/src/protocol/server.ts`（如果 resolver 复用 pending approval/control channel）
- `packages/core/src/protocol/transport.ts`（仅当需要 internal control message）

对外契约变化：

- main app ready 安装 `setDefaultCredentialCipher(new SafeStorageCipher())`。
- 新增 main↔worker internal credential messages：
  - `desktop/credentialSnapshot`：main -> worker，带 metadata + envExposures + revision。
  - `desktop/credentialResolve`：worker -> main，请求 token/link plaintext。
  - `desktop/credentialMaterializeCookie`：worker -> main，请求 cookie cookiesFile/count。
- internal messages 不进 renderer、不进 transcript、不进 normal approval UI。

TDD 断言：

- worker 收到 snapshot 后，metadata guard 可见；未收到 snapshot 时 desktop credential tools fail-closed。
- resolver 请求由 main 用 SafeStorageCipher 解密后返回。
- logs/desktop logger 不记录 plaintext secret；必要时复用 `redact-secrets.ts`。

回归风险：stdio 上 internal message 与 JSON-RPC agent message 混流；需要明确 namespace 和 AgentBridge 拦截顺序，避免被 renderer 看见。

### Stage 6：M2 migration 与 UI status

文件：

- `packages/desktop/src/main/index.ts`
- `packages/desktop/src/main/credential-migration.ts`（新增）
- `packages/desktop/src/main/credentials-service.ts` 或 settings/credentials IPC service
- renderer credentials UI 文案文件（例如 `packages/desktop/src/renderer/i18n/ns/extensions.ts`）

对外契约变化：

- `credentials:securityStatus` 返回 safeStorage 状态。
- 首次 app ready 后迁移 known credential stores。

TDD 断言：

- bare plaintext 和 `plain:` 首次迁移后磁盘不含 secret，含 `enc:safeStorage:`。
- safeStorage unavailable fake cipher 下磁盘为 `plain:`，UI status 为 plaintext fallback。
- migration 幂等，不 double encrypt。

回归风险：迁移未知项目只能 lazy；用户看到某些旧项目文件暂未迁移，需要文案不要承诺“全盘所有历史项目已迁移”。

### Stage 7：M2 全链路回归

文件：

- `packages/core/src/credentials/use-credential-tool.test.ts`
- `packages/core/src/credentials/inject-credential-tool.test.ts`
- `packages/core/src/engine/engine.shell-env.test.ts`
- `packages/core/src/tool-system/mcp-manager.test.ts`
- `packages/desktop/src/main/credential-action.test.ts`
- 新增 worker/main integration test（可用 fake bridge）

TDD 断言：

- credentials.json 全为 fake `enc:safeStorage:*`，worker UseCredential token 返回 plaintext。
- cookie credential 全加密，UseCredential materialize 后 `cookies.txt` 含 cookie name/value，不含 ciphertext。
- `exposeAsEnv` 在 Engine tool context 中是 plaintext。
- MCP `credentialRef` 组出 `Authorization: Bearer <plaintext>`。
- InjectCredential worker 不拿 jar；main restore 收到 decrypted jar。
- tool guard 与 dynamic description 可见但不泄漏 secret。

回归风险：测试中要防止默认 local provider 掩盖 desktop provider 未安装的问题；desktop 模式测试应把 local disk 放入无法由 PlaintextCipher 解开的 fake `enc:safeStorage`。

## 5. 测试策略

### 5.1 “凭证全加密后 worker 各链路仍拿到明文/派生结果”

用 fake safeStorage cipher 避免依赖 Electron keychain：

- main 写入 fake `enc:safeStorage:<base64>`，断言 raw file 不含 secret。
- 启动 fake worker credential access，禁止 direct `CredentialStore` plaintext fallback。
- UseCredential token：断言工具 JSON 是 `{kind:"value", value:"tok-123"}`。
- UseCredential cookie：断言返回 cookiesFile；文件存在、mode 0o600、内容含 `web_session` 和 cookie value，不含 `enc:safeStorage`。
- exposeAsEnv：构造 Engine，断言 `buildToolContext().shellEnv.FIGMA_TOKEN === "s-mquq0f4p"`。
- MCP credentialRef：断言 HTTP headers `Authorization === "Bearer figd_secret"`。
- InjectCredential：fake main resolver 断言 worker 只传 id/scope/session，main 解密后 restore jar。
- tool guard：有 metadata 时 UseCredential/InjectCredential 可见；metadata 空时不可见；任何描述/guard 输出不含 plaintext。

### 5.2 “A session 自动化不打到 B session”

用 fake guest registry：

- register `sessionA -> bucketA -> guestA`，`sessionB -> bucketB -> guestB`。
- focus guestB，使它成为 B bucket active。
- 发 `sessionA` 的 snapshot/navigate/click，断言调用 guestA debugger/CDP，guestB 无调用。
- `list_tabs` for A 只列 A tabs。
- `switch_tab` with B tabId from A returns false。
- InjectCredential for A restore target 是 guestA.session 或 bucketA partition；reload payload 只有 bucketA。
- no mapping/no guest：返回 fail-closed，不操作任何 guest。

### 5.3 必跑命令

- `bun test packages/desktop/src/main/browser-driver`
- `bun test packages/core/src/credentials`
- `bun test packages/core/src/engine/engine.shell-env.test.ts`
- `bun test packages/core/src/tool-system/mcp-manager.test.ts`
- `bun test packages/desktop/src/main/credential-action.test.ts`
- 最后跑一次相关 desktop renderer tests：`bun test packages/desktop/src/renderer/browser`

仓库现有 `bun run typecheck` 非干净 gate，按 `CODESHELL.md` 说明不能把全仓 typecheck 既有错误作为本任务阻塞，但改动文件本身必须类型正确。

## 6. 开放问题 / 需卡密sama拍板

1. **SafeStorage 不可用时策略**：按现有 `SafeStorageCipher` fallback 写 `plain:` 并 UI 明示，还是严格失败禁止保存？
2. **UseCredential cookie materialize 的进程归属**：推荐 main 解密并写 `cookies.txt`，worker 只拿 path/count；是否接受 main 创建 tool 临时文件？
3. **env-exposed credentials 的明文范围**：`exposeAsEnv` 必然进入 worker/子进程环境。是否接受 snapshot 预派生这些 env secret，还是要求每个命令启动前再向 main 拉取？
4. **MCP credentialRef scope**：当前实现明确 user-scope：`mcp-manager.ts:475-480`。L 档是否继续 user-only，还是引入 project-aware MCP credentialRef？
5. **InjectCredential 无 live target browser 时行为**：推荐 fail-closed；是否允许自动打开目标 session browser panel 后再注入？
6. **popout 是否参与 AI automation**：推荐默认不参与，除非绑定 owner bucket；需要定规则。
7. **迁移范围承诺**：startup 迁移 known projects + user，未知 project lazy。是否需要提供一次性“扫描所有最近项目/手选目录迁移”的 UI？
8. **worker snapshot 刷新时机**：最低每次 `agent/run` 前刷新；是否要求 UI 保存 credential 后立即 push 到 live worker？

## 7. 自检

- worker 明文链路已覆盖：UseCredential list/value/cookie、dynamic description、exposeAsEnv、InjectCredential availability/tool、MCP credentialRef、tool guard、main-side restore/probe。
- stage 顺序是真串行：先 M3 建 session/bucket target contract，再 M2 在该 contract 上改 credential resolver 和 safeStorage。
- headless/SDK 兜底明确：core 默认 local `CredentialStore + PlaintextCipher`；desktop worker IPC 缺失时 fail-closed，不读 safeStorage ciphertext。
- M3 fail-closed 明确：无 sessionId、无 bucket、无 target guest、cross-bucket tabId 都不 fallback 到 global active guest。
