# Link 在 headless 服务端的可行性核验

> 状态：现状核验（Findings），**未改任何代码**
> 日期：2026-09-06
> 起因：服务端部署形态下 Link（GitHub/GitLab/Figma/Notion/Slack…）还能不能用？
> 上游文档：`docs/architecture/local-link-mvp.md`、`codeshell-hub-remote-service-architecture.md`

## 0. 结论

**Link 不是被 Electron / safeStorage 卡住的**——加密边界当初就是按"宿主可注入"设计的，
core 里一行 Electron 都没有。

真正卡住 headless 的是 **stdio worker 里一行无条件的 IPC 注入**：它把本来能独立工作的
本地凭证读取替换成一个只有 Electron 主进程会应答的 IPC client。

**这是接线缺口，不是架构缺口。**

## 1. 加密层本就为 headless 设计（已核验）

- `packages/core/src/credentials/cipher.ts:19-30` — `EncryptionCipher` 是**注入式接口**
- `cipher.ts:41-58` — `PlaintextCipher`，注释明写为
  "Headless and SDK hosts have no safe key store... owner-only (0o600) plaintext"
- `cipher.ts:71` — **进程默认就是 `PlaintextCipher`**，宿主不调 setter 也能跑
- `cipher.ts:8-10` — 文件自带不变量：`grep -R safeStorage packages/core/src` 必须为空

独立复核：`grep -rn 'from "electron"' packages/core/src/` → **0 命中**，不变量成立。

只有 desktop 注入 Electron cipher：`packages/desktop/src/main/credential-cipher.ts:13`
（`import { safeStorage } from "electron"`），安装于 `desktop/src/main/index.ts:3161`。

存储层 `packages/core/src/credentials/store.ts:1-23` 只 import `node:fs/path/os`，纯 Node。

## 2. LinkAction 由 core 注册，且没有 availability 门（已核验）

- `packages/core/src/tool-system/builtin/index.ts:124` import，`:1017-1029` 注册进共享 builtin 表
- `:1027-1029` 的 `exposure` **只有** `defaultPermissionRules`，**没有 `availability` 谓词**
  （对比邻居 `UseCredential` `:1011`、`InjectCredential` `:1043` 都有）
- `:1015-1016` 注释确认是有意为之：
  "Link discovery remains available even when no saved connection is usable."

→ headless serve worker 经 `packages/server/src/serve/cli.ts:86-88` 装 coding 模块，
**确实拿得到 LinkAction 工具**，没有任何 desktop 专属门禁。

## 3. 两个执行 backend 零 Electron（已核验）

- `packages/core/src/links/cli.ts:1-4` 只 import `node:child_process`(execFile)/`fs`/`os`/`path`
  `:18` providers = `github|gitlab|notion|todoist|vercel`
  `:52,69,85,91,96` 分别 shell 出 `gh`/`glab`/`ntn`/`td`/`vercel`
  → 只要服务器装了这些 CLI 且已登录，**原样可跑**
- `packages/core/src/links/http.ts` — **一个 import 都没有**，纯 `fetch` + HTTPS allowlist (`:3-14`)

## 4. 真正的阻塞点：一行

`packages/core/src/cli/agent-server-stdio.ts:394`：

```ts
setDefaultCredentialAccess(createIpcCredentialAccess(stdioTransport));
```

**无条件执行**（已 sed 复核 385-400 行，确认外层无任何宿主判断分支）。

它替换掉了本来可用的 `localCredentialAccess`
（`packages/core/src/credentials/access.ts:100-102`，实现在 `:265-312`，
其中 `:292-300` 正是 `purpose: "link"` 分支——**这条 fallback 完全具备 headless 能力**），
换成一个需要宿主推 `desktop/credentialSnapshot`、应答 `desktop/credentialResolve`
的 IPC client（`access.ts:120,198`）。

**只有 Electron 应答**：`packages/desktop/src/main/agent-bridge.ts:945-947`（应答请求）
与 `:1401`（推 snapshot）。server 侧 `headless-server.ts` / `worker-bridge-core.ts`
**完全没有 credential 处理**。

### 4.1 headless 下的实际退化行为（已核验 `access.ts:160-180`）

| 调用                   | headless 结果             | 后果                                                |
| ---------------------- | ------------------------- | --------------------------------------------------- |
| `listMasked`           | `[]`（无 snapshot entry） | `isLinkActionAvailable` false，已连接 Link 全不可见 |
| `listMaskedWithStatus` | `readable: false`         | `status.ts:161` 置 `credentialStore.state="error"`  |
| `resolveValue`         | 发进虚空，30s 后 reject   | `access.ts:153-156`，每次 Action 挂满 30 秒         |

注意是**静默退化**，不是响亮报错——文案只说
"Saved Link credentials could not be read"（`status.ts:169-170`）。

## 5. 要动的地方，按工作量排序

1. **（最小，解锁 HTTP-token + CLI 两条路）**
   `agent-server-stdio.ts:394` 改为仅在宿主是 Electron 时注入 IPC access，
   headless 保留 `localCredentialAccess`（它已经会读盘、已经处理 `purpose:"link"`）。
2. **（小，属部署文档而非代码）**
   确认 serve 不设 cipher → `PlaintextCipher` 生效。headless 凭证文件是
   **0o600 明文**，这是要写进部署文档的安全决策。
3. **（中）headless 没有连接/授权 UI。**
   Link 的连接流程全是 Electron IPC（`desktop/src/main/index.ts:3729`
   `links:listLocalProviders`、`:3808-3963` CLI/浏览器连接）。
   凭证需带外 provision，或另建 serve 侧等价物。
   有利因素：`link-provider-catalog.ts:1-2` 只依赖 `@cjhyy/code-shell-link` + core，
   两者都无 Electron，**目录逻辑本身可移植**。
4. **（中）写操作需要 `ctx.askUser`**，否则 `link-action-tool.ts:225-229` 硬失败。
   serve/mobile 栈已有审批管道（`room-manager.ts:194,1088`），属接线非新架构。

## 6. 已有的 non-Electron 测试（佐证代码本就宿主无关）

全部在 bun 下裸跑，无 Electron mock：

- `packages/core/src/links/cli.test.ts`
- `packages/core/src/links/link-action-tool.test.ts`（`:6,265,296,311` 注入假 `CredentialAccess`）
- `packages/core/src/links/link-action-discovery.test.ts`（`:20,55`）
- `packages/core/src/links/status.test.ts`（`:289,325` 正好覆盖 headless 会撞上的 error 退化）
- `packages/core/src/credentials/cipher.test.ts:81`（显式测 `PlaintextCipher`，即 headless 配置）

## 7. 诚实边界

以上为**静态追踪**结论，其中"加密不变量"与"阻塞行无条件"两条我已独立复核。
**没有真跑 `code-shell-serve` 实测**——该 worktree 尚未 `bun install` / `build`。
第 4.1 节的退化行为是从代码推导的，未经运行时观察。

另需澄清一个措辞：`local-link-mvp.md` 里的"本地优先"指的是**执行位置**
（Action 由本机 CLI / fetch 直接跑，不经云端中继），与 Electron 无关——
服务端部署后这一性质依然成立，只是"本机"变成了那台服务器。
