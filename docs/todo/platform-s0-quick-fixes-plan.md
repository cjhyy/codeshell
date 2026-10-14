# 平台收敛 S0 快速修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 headless serve 对它不支持的宿主请求立即返回 `unsupported`，不再挂起；所有宿主都能报告统一的契约版本；收紧 REPL 环境变量；删除没人用的进程审批存储。

**Architecture:** 新增 `packages/core/src/contracts.ts` 作为契约版本的唯一定义，server、desktop 引用它；渲染进程共享的字面量用漂移测试守住。serve 侧新增一个纯函数模块 `host-requests.ts`，识别浏览器 / 凭据 / 工作区三种回环和 `desktop/*` 授权请求，并生成类型化的 `unsupported` 应答，`headless-server.ts` 在转发 worker 消息前调用它。AgentServer 新增最小版 `initialize`，只返回协议版本和契约表。

**Tech Stack:** TypeScript、Bun test（经 `scripts/run-bun-test-shard.mjs` 守卫运行）、JSON-RPC 2.0 over stdio / WebSocket。

**上游设计：** [第 16 章](../architecture/16-platform-consolidation.md) §3.2 步骤 1.0 / 1.1、§4.1、§5.1、§5.2、§7.1、§9 的 S0 行。

---

## 范围决定

| 第 16 章 S0 条目                    | 本计划处理       | 说明                                                                                                                                                                    |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.0 清点                            | Task 1           | 产出清单文档，作为 S1 的 v2 命名空间输入                                                                                                                                |
| 1.1 回环分发器加 `host_unsupported` | Task 4–6         | 分发逻辑先放在 `packages/server/src/serve/host-requests.ts`，纯函数、不依赖 serve 内部状态。S1 新建 `packages/host` 时整体搬过去。S0 不新建包，避免改构建顺序和发布配置 |
| `contracts.ts`（含手机协议版本号）  | Task 2–3、Task 7 | 手机 WS 握手里实际带上版本号随 1.5 做，S0 只在契约表和 `/health` 里声明                                                                                                 |
| 删除没人用的进程审批存储            | Task 10          |                                                                                                                                                                         |
| REPL 改环境变量白名单               | Task 9           | 复用 core 已有的 `buildSandboxEnv` 和 `mergeShellEnv`，与沙箱化 Bash 同一套白名单，不再从 server 搬 `safeProcessEnv`                                                    |
| 最小版 `initialize`                 | Task 8           | 方法名直接用 v2 的 `initialize`；没发它的连接行为不变                                                                                                                   |
| 沙箱 report-only                    | **不在本计划**   | 需要先做一次技术验证：seatbelt / bwrap 能否在不拦截的前提下报告"会被拒的操作"。另起计划                                                                                 |
| 域名 / DNS / 备案、生产 Hub 升级    | **不在本计划**   | 运维事项，不涉及代码                                                                                                                                                    |

## 文件结构

| 文件                                                                 | 动作 | 职责                                                        |
| -------------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `docs/todo/platform-s0-protocol-inventory.md`                        | 新建 | 1.0 清点结果                                                |
| `packages/core/src/contracts.ts`                                     | 新建 | 契约版本唯一定义                                            |
| `packages/core/src/contracts.test.ts`                                | 新建 | 锁定契约表，改版本必须同时改测试                            |
| `packages/core/src/index.ts`                                         | 修改 | 导出 `CONTRACTS`                                            |
| `packages/server/src/panels/bridge-contract.ts`                      | 修改 | `panelRuntimeApiVersion` 引用契约表                         |
| `packages/server/src/remote-relay/protocol.ts`                       | 修改 | `RELAY_PROTOCOL_VERSION` 引用契约表                         |
| `packages/server/src/project-runtime/cloud-account-auth.ts`          | 修改 | 引用契约表                                                  |
| `packages/server/src/project-runtime/cloud-browser-auth.ts`          | 修改 | 引用契约表                                                  |
| `packages/desktop/src/main/im-gateway-control-server.ts`             | 修改 | 引用契约表                                                  |
| `packages/desktop/src/main/contract-versions.test.ts`                | 新建 | 渲染进程共享字面量和 chat 包字面量的漂移测试                |
| `packages/core/src/protocol/server.ts`                               | 修改 | `HostLoopbackFailure` 增加 `unsupported`；处理 `initialize` |
| `packages/core/src/protocol/types.ts`                                | 修改 | `Methods.Initialize`                                        |
| `packages/core/src/protocol/server.initialize.test.ts`               | 新建 | `initialize` 测试                                           |
| `packages/server/src/serve/host-requests.ts`                         | 新建 | 识别不支持的宿主请求并生成应答                              |
| `packages/server/src/serve/host-requests.test.ts`                    | 新建 | 纯函数单测                                                  |
| `packages/server/src/serve/headless-server.ts`                       | 修改 | 转发前拦截；`/health` 返回契约表                            |
| `packages/server/src/serve/serve-host-unsupported.test.ts`           | 新建 | serve 端到端测试                                            |
| `packages/server/src/serve/hub-server.test.ts`                       | 修改 | `/health` 断言加上契约表                                    |
| `packages/core/src/tool-system/builtin/repl.ts`                      | 修改 | 环境变量白名单                                              |
| `packages/core/src/tool-system/builtin/repl.test.ts`                 | 修改 | 白名单测试                                                  |
| `packages/desktop/src/main/panel-app-process-approval-store.ts`      | 删除 |                                                             |
| `packages/desktop/src/main/panel-app-process-approval-store.test.ts` | 删除 |                                                             |
| `packages/desktop/src/main/panel-app-process-consent.test.ts`        | 修改 | 去掉对已删存储的引用                                        |
| `docs/architecture/16-platform-consolidation.md`                     | 修改 | 按本计划的范围决定更新 S0 行和 §5.2、§7.1 措辞              |

## 通用约定

- 在 worktree `../codeshell-wt-s0`（分支 `claude/host/s0-quick-fixes`）里工作，不要在主工作区操作。
- 单测一律用守卫运行器：`node scripts/run-bun-test-shard.mjs --timeout 30000 <测试文件...>`。不要裸跑 `bun test`。
- server 和 desktop 的测试读取 core 的 `dist/`。改了 core 之后，先跑 `bun run --cwd packages/core build` 再跑下游测试。
- 只对改过的文件跑 prettier，不要跑 `bun run format`。
- 暂存时逐路径 `git add`，不要 `git add -A`。提交信息末尾加：

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

---

### Task 0: 准备 worktree

**Files:** 无

- [ ] **Step 1: 安装依赖并构建**

```bash
cd ../codeshell-wt-s0
bun install
bun run build
```

Expected: 两条命令都以 0 退出。

- [ ] **Step 2: 跑一遍会被改动的测试，记录基线**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/core/src/tool-system/builtin/repl.test.ts \
  packages/server/src/serve/hub-server.test.ts \
  packages/server/src/serve/hub-panel-loopback.test.ts \
  packages/desktop/src/main/panel-app-process-consent.test.ts
```

Expected: 全部通过。如果基线就有失败，先记录下来，不要在本计划里修。

---

### Task 1: 1.0 协议与宿主请求清点

**Files:**

- Create: `docs/todo/platform-s0-protocol-inventory.md`

- [ ] **Step 1: 采集原始数据**

```bash
grep -oE '"agent/[a-zA-Z]+"' packages/core/src/protocol/types.ts | sort -u
grep -rhoE '"__[a-z_]+_action__"|"__ask_user__"' packages/core/src --include='*.ts' | sort | uniq -c
grep -rhoE '"desktop/[a-zA-Z]+"' packages/core/src --include='*.ts' | sort -u
grep -rhoE '"serve/[a-zA-Z.]+"' packages/server/src/serve --include='*.ts' | sort -u
s=$(grep -n "^type StreamEventPayload" packages/core/src/types.ts | cut -d: -f1)
awk -v s=$s 'NR>s' packages/core/src/types.ts | awk '/^(export |type )/{exit} {print}' \
  | grep -oE '^\s*\| \{\s*type: "[a-z_]+"|^\s+type: "[a-z_]+";' | grep -oE '"[a-z_]+"' | sort -u
grep -rn "registerQuery\|queryHandlers\|extensionQueries" packages/core/src packages/coding/src packages/pet/src packages/arena/src --include='*.ts' 2>/dev/null | grep -v test
```

- [ ] **Step 2: 写清单文档**

文档必须包含以下五张表，每行都填实际值：

```markdown
# S0 协议与宿主请求清点

> 基线：`<git rev-parse --short HEAD 的输出>`。供第 16 章 1.1 与 4.4 使用。

## 1. agent/\* 方法与通知

| 名字 | 方向（请求 / 通知） | v2 去向（`session/*`、`turn/*`、`host/*`、保留、废弃） |

## 2. StreamEvent 类型

| type | v2 Item 类型（按第 16 章 §4.2 表） |

## 3. `__*__` 回环

| toolName | Desktop 处理位置 | serve 现状 | S0 处理 | v2 去向（host/\*） |

## 4. desktop/\* 请求

| method | 发起方文件 | Desktop 处理 | serve 现状 | S0 处理 | v2 去向 |

## 5. 扩展查询（CapabilityModule 注册的 agent/query 子类型）

| 名字 | 注册包 | v2 命名空间 |
```

第 3、4 表的"S0 处理"列：`__browser_action__`、`__credential_action__`、`__workspace_action__` 和所有 `desktop/*` 填"serve 立即返回 unsupported"；`__panel_action__` 和 `__ask_user__` 填"不变"。

- [ ] **Step 3: 提交**

```bash
npx prettier --write docs/todo/platform-s0-protocol-inventory.md
git add docs/todo/platform-s0-protocol-inventory.md
git commit -m "docs(todo): inventory protocol methods and host loopbacks for S0"
```

---

### Task 2: core 契约表

**Files:**

- Create: `packages/core/src/contracts.ts`
- Create: `packages/core/src/contracts.test.ts`
- Modify: `packages/core/src/index.ts`（文件末尾追加一行导出）

- [ ] **Step 1: 写失败的测试**

`packages/core/src/contracts.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { CONTRACTS } from "./contracts.js";

describe("CONTRACTS", () => {
  // Changing a version is a compatibility decision. Update docs/compatibility
  // notes and every peer (Desktop, services, mobile) in the same change.
  test("pins every externally visible contract version", () => {
    expect(CONTRACTS).toEqual({
      agentProtocol: { supported: ["1"], preferred: "1" },
      panelApi: 14,
      cloudManagementAuthority: 2,
      cloudBrowserAuthority: 1,
      relayProtocol: 1,
      desktopControl: 1,
      mobileRemote: 1,
      outputJournal: 1,
    });
  });

  test("cannot be mutated at runtime", () => {
    expect(Object.isFrozen(CONTRACTS)).toBe(true);
    expect(Object.isFrozen(CONTRACTS.agentProtocol)).toBe(true);
    expect(Object.isFrozen(CONTRACTS.agentProtocol.supported)).toBe(true);
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/contracts.test.ts
```

Expected: FAIL，提示找不到 `./contracts.js`。

- [ ] **Step 3: 实现**

`packages/core/src/contracts.ts`：

```ts
/**
 * Single source of truth for every externally visible contract version.
 *
 * Hosts report this table from `initialize` and `/health` so clients and the
 * services repository can decide compatibility from data instead of package
 * versions. Values that must stay literal for the browser-safe renderer bundle
 * (Desktop `shared/panel-apps.ts`, the `chat` package) are pinned to this table
 * by a drift test in Desktop main.
 */
export const CONTRACTS = Object.freeze({
  /** AgentServer JSON-RPC. "1" is today's unversioned surface; v2 adds "2.0". */
  agentProtocol: Object.freeze({
    supported: Object.freeze(["1"] as const),
    preferred: "1" as const,
  }),
  panelApi: 14,
  cloudManagementAuthority: 2,
  cloudBrowserAuthority: 1,
  relayProtocol: 1,
  desktopControl: 1,
  /** Declared now; the mobile WS hello starts carrying it with ch.16 step 1.5. */
  mobileRemote: 1,
  outputJournal: 1,
} as const);

export type Contracts = typeof CONTRACTS;
```

在 `packages/core/src/index.ts` 末尾追加：

```ts
export { CONTRACTS, type Contracts } from "./contracts.js";
```

- [ ] **Step 4: 运行，确认通过**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/contracts.test.ts
```

Expected: 2 pass, 0 fail。

- [ ] **Step 5: 构建 core 并提交**

```bash
bun run --cwd packages/core build
npx prettier --write packages/core/src/contracts.ts packages/core/src/contracts.test.ts packages/core/src/index.ts
git add packages/core/src/contracts.ts packages/core/src/contracts.test.ts packages/core/src/index.ts
git commit -m "feat(core): add CONTRACTS as the single contract version table"
```

---

### Task 3: 各处版本常量引用契约表，加漂移测试

**Files:**

- Modify: `packages/server/src/panels/bridge-contract.ts:3`
- Modify: `packages/server/src/remote-relay/protocol.ts:2`
- Modify: `packages/server/src/project-runtime/cloud-account-auth.ts:13`
- Modify: `packages/server/src/project-runtime/cloud-browser-auth.ts:15`
- Modify: `packages/desktop/src/main/im-gateway-control-server.ts:23`
- Create: `packages/desktop/src/main/contract-versions.test.ts`

- [ ] **Step 1: 写漂移测试**

`packages/desktop/src/main/contract-versions.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { CONTRACTS } from "@cjhyy/code-shell-core";
import { PANEL_APP_API_VERSION } from "../shared/panel-apps.js";
import { DESKTOP_CONTROL_PROTOCOL_VERSION } from "./im-gateway-control-server.js";

// Renderer-shared code may only import browser-safe entries, and the chat
// package does not depend on core, so those two keep literals. This test is
// the guard that keeps them equal to CONTRACTS.
describe("contract version literals", () => {
  test("renderer-shared Panel API version matches CONTRACTS", () => {
    expect(PANEL_APP_API_VERSION).toBe(CONTRACTS.panelApi);
  });

  test("Desktop control protocol version matches CONTRACTS", () => {
    expect(DESKTOP_CONTROL_PROTOCOL_VERSION).toBe(CONTRACTS.desktopControl);
  });

  test("chat package control protocol literal matches CONTRACTS", async () => {
    const source = await readFile(
      new URL("../../../chat/src/protocol.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain(
      `export const DESKTOP_CONTROL_PROTOCOL_VERSION = ${CONTRACTS.desktopControl};`,
    );
  });
});
```

- [ ] **Step 2: 运行，确认通过（当前值都一致，这是守卫测试）**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/main/contract-versions.test.ts
```

Expected: 3 pass。

- [ ] **Step 3: 把 server 和 desktop main 的定义改为引用契约表**

`packages/server/src/panels/bridge-contract.ts`，第 1 行之后加导入，第 3 行改为：

```ts
import { CONTRACTS } from "@cjhyy/code-shell-core";
import { processLimits } from "./process-state.js";

export const panelRuntimeApiVersion = CONTRACTS.panelApi;
```

`packages/server/src/remote-relay/protocol.ts` 第 2 行改为（文件顶部加导入）：

```ts
import { CONTRACTS } from "@cjhyy/code-shell-core";
export const RELAY_PROTOCOL_VERSION = CONTRACTS.relayProtocol;
```

`packages/server/src/project-runtime/cloud-account-auth.ts`：

```ts
export const CLOUD_MANAGEMENT_AUTHORITY_VERSION = CONTRACTS.cloudManagementAuthority;
```

`packages/server/src/project-runtime/cloud-browser-auth.ts`：

```ts
export const CLOUD_BROWSER_AUTHORITY_VERSION = CONTRACTS.cloudBrowserAuthority;
```

两个 cloud 文件都在已有的 `@cjhyy/code-shell-core` 导入里加上 `CONTRACTS`；如果文件还没有从 core 导入，就新增 `import { CONTRACTS } from "@cjhyy/code-shell-core";`。

`packages/desktop/src/main/im-gateway-control-server.ts` 第 23 行改为，并在文件顶部加导入：

```ts
import { CONTRACTS } from "@cjhyy/code-shell-core";
export const DESKTOP_CONTROL_PROTOCOL_VERSION = CONTRACTS.desktopControl;
```

`CONTRACTS` 是 `as const`，这些常量的类型仍是字面量 `1` / `2` / `14`，`typeof X` 的用法不受影响。

- [ ] **Step 4: 类型检查和测试**

```bash
bun run --cwd packages/server build
bun run typecheck:workspaces
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/desktop/src/main/contract-versions.test.ts \
  packages/server/src/remote-relay \
  packages/server/src/project-runtime
```

Expected: typecheck 0 错误；测试全部通过。

- [ ] **Step 5: 提交**

```bash
npx prettier --write packages/server/src/panels/bridge-contract.ts packages/server/src/remote-relay/protocol.ts packages/server/src/project-runtime/cloud-account-auth.ts packages/server/src/project-runtime/cloud-browser-auth.ts packages/desktop/src/main/im-gateway-control-server.ts packages/desktop/src/main/contract-versions.test.ts
git add packages/server/src/panels/bridge-contract.ts packages/server/src/remote-relay/protocol.ts packages/server/src/project-runtime/cloud-account-auth.ts packages/server/src/project-runtime/cloud-browser-auth.ts packages/desktop/src/main/im-gateway-control-server.ts packages/desktop/src/main/contract-versions.test.ts
git commit -m "refactor: derive contract version constants from CONTRACTS"
```

---

### Task 4: core 增加 `unsupported` 失败类型

**Files:**

- Modify: `packages/core/src/protocol/server.ts:315-322`（`HostLoopbackFailure`）
- Modify: `packages/core/src/protocol/server.ts:352-359`（`HOST_LOOPBACK_FAILURE_DETAIL`）

`HOST_LOOPBACK_FAILURE_DETAIL` 是 `Record<HostLoopbackFailure, string>`，漏掉条目会编译失败，所以这一步用类型检查验证，行为由 Task 6 的端到端测试覆盖。

- [ ] **Step 1: 修改联合类型**

```ts
export type HostLoopbackFailure =
  | "denied"
  | "cancelled"
  | "session_closed"
  | "owner_lost"
  | "timed_out"
  /** The host does not provide this capability (e.g. headless serve has no browser). */
  | "unsupported"
  /** The host replied, but with something that wasn't parseable JSON. */
  | "malformed";
```

- [ ] **Step 2: 补齐说明文案**

```ts
const HOST_LOOPBACK_FAILURE_DETAIL: Record<HostLoopbackFailure, string> = {
  denied: "declined by the user",
  cancelled: "cancelled because the turn was stopped",
  session_closed: "cancelled because the session closed",
  owner_lost: "unavailable because the approving client disconnected",
  timed_out: "timed out waiting for the host",
  unsupported: "is not supported by this host",
  malformed: "returned a malformed result",
};
```

- [ ] **Step 3: 类型检查**

```bash
bun run --cwd packages/core build
```

Expected: 0 错误。

- [ ] **Step 4: 提交**

```bash
npx prettier --write packages/core/src/protocol/server.ts
git add packages/core/src/protocol/server.ts
git commit -m "feat(core): classify host loopbacks a host cannot provide as unsupported"
```

---

### Task 5: serve 的宿主请求识别模块

**Files:**

- Create: `packages/server/src/serve/host-requests.ts`
- Create: `packages/server/src/serve/host-requests.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/server/src/serve/host-requests.test.ts`：

```ts
import { describe, expect, test } from "bun:test";
import {
  isHostAuthorityRequest,
  unsupportedHostRequestResponse,
  unsupportedLoopbackAnswer,
  unsupportedLoopbackCapability,
} from "./host-requests.js";

describe("unsupportedLoopbackCapability", () => {
  test("maps the three Desktop-only loopbacks to capability names", () => {
    expect(unsupportedLoopbackCapability("__browser_action__")).toBe("browser");
    expect(unsupportedLoopbackCapability("__credential_action__")).toBe("credential.browserCookie");
    expect(unsupportedLoopbackCapability("__workspace_action__")).toBe("workspace.switch");
  });

  test("leaves loopbacks serve does handle, and ordinary tools, alone", () => {
    expect(unsupportedLoopbackCapability("__panel_action__")).toBeUndefined();
    expect(unsupportedLoopbackCapability("__ask_user__")).toBeUndefined();
    expect(unsupportedLoopbackCapability("Bash")).toBeUndefined();
    expect(unsupportedLoopbackCapability("toString")).toBeUndefined();
    expect(unsupportedLoopbackCapability(undefined)).toBeUndefined();
  });
});

describe("unsupportedLoopbackAnswer", () => {
  test("is a JSON result every core loopback parser reads as a typed failure", () => {
    expect(JSON.parse(unsupportedLoopbackAnswer("browser"))).toEqual({
      ok: false,
      failure: "unsupported",
      capability: "browser",
      error: "browser is not supported by this host (headless serve)",
      detail: "browser is not supported by this host (headless serve)",
    });
  });
});

describe("isHostAuthorityRequest", () => {
  test("matches worker requests in the desktop/ namespace", () => {
    expect(isHostAuthorityRequest({ id: "a-1", method: "desktop/automationCreate" })).toBe(true);
    expect(isHostAuthorityRequest({ id: 7, method: "desktop/credentialResolve" })).toBe(true);
  });

  test("ignores notifications, responses and other namespaces", () => {
    expect(isHostAuthorityRequest({ method: "desktop/operationBatch" })).toBe(false);
    expect(isHostAuthorityRequest({ id: null, method: "desktop/automationCreate" })).toBe(false);
    expect(isHostAuthorityRequest({ id: "r-1" })).toBe(false);
    expect(isHostAuthorityRequest({ id: "r-2", method: "agent/streamEvent" })).toBe(false);
  });
});

describe("unsupportedHostRequestResponse", () => {
  test("is a JSON-RPC MethodNotFound error tagged unsupported", () => {
    expect(JSON.parse(unsupportedHostRequestResponse("a-1", "desktop/automationCreate"))).toEqual({
      jsonrpc: "2.0",
      id: "a-1",
      error: {
        code: -32601,
        message: "desktop/automationCreate is not supported by this host (headless serve)",
        data: { failure: "unsupported", capability: "desktop/automationCreate" },
      },
    });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/serve/host-requests.test.ts
```

Expected: FAIL，找不到 `./host-requests.js`。

- [ ] **Step 3: 实现**

`packages/server/src/serve/host-requests.ts`：

```ts
/**
 * Worker → host requests that a headless serve host cannot fulfil.
 *
 * Desktop main answers the browser, credential-cookie and workspace-switch
 * loopbacks plus the `desktop/*` authority requests. serve used to broadcast
 * them to Web tabs as ordinary approvals, so the worker waited for its timeout
 * (5 minutes for loopbacks, 30 seconds for automation). Answering at once with
 * a typed `unsupported` result lets the tool fail fast with a reason.
 *
 * Pure and host-neutral on purpose: it moves into packages/host unchanged
 * (architecture ch.16 §3.2 step 1.1).
 */

const UNSUPPORTED_LOOPBACK_CAPABILITIES: Readonly<Record<string, string>> = Object.freeze({
  __browser_action__: "browser",
  __credential_action__: "credential.browserCookie",
  __workspace_action__: "workspace.switch",
});

const HOST_AUTHORITY_METHOD_PREFIX = "desktop/";
const METHOD_NOT_FOUND = -32601;

function unsupportedText(capability: string): string {
  return `${capability} is not supported by this host (headless serve)`;
}

export function unsupportedLoopbackCapability(toolName: unknown): string | undefined {
  if (typeof toolName !== "string") return undefined;
  return Object.hasOwn(UNSUPPORTED_LOOPBACK_CAPABILITIES, toolName)
    ? UNSUPPORTED_LOOPBACK_CAPABILITIES[toolName]
    : undefined;
}

/** The `answer` string for an approved loopback decision. */
export function unsupportedLoopbackAnswer(capability: string): string {
  const text = unsupportedText(capability);
  return JSON.stringify({
    ok: false,
    failure: "unsupported",
    capability,
    error: text,
    detail: text,
  });
}

export function isHostAuthorityRequest(message: {
  id?: unknown;
  method?: unknown;
}): message is { id: string | number; method: string } {
  return (
    (typeof message.id === "string" || typeof message.id === "number") &&
    typeof message.method === "string" &&
    message.method.startsWith(HOST_AUTHORITY_METHOD_PREFIX)
  );
}

/** One JSON-RPC response line to write back to the worker. */
export function unsupportedHostRequestResponse(id: string | number, method: string): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: METHOD_NOT_FOUND,
      message: unsupportedText(method),
      data: { failure: "unsupported", capability: method },
    },
  });
}
```

- [ ] **Step 4: 运行，确认通过**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/serve/host-requests.test.ts
```

Expected: 7 pass, 0 fail。

- [ ] **Step 5: 提交**

```bash
npx prettier --write packages/server/src/serve/host-requests.ts packages/server/src/serve/host-requests.test.ts
git add packages/server/src/serve/host-requests.ts packages/server/src/serve/host-requests.test.ts
git commit -m "feat(server): recognize host requests headless serve cannot fulfil"
```

---

### Task 6: serve 在转发前拦截不支持的请求

**Files:**

- Modify: `packages/server/src/serve/headless-server.ts`（`routeWorkerLine`，约 341–460 行；文件顶部导入）
- Create: `packages/server/src/serve/serve-host-unsupported.test.ts`

- [ ] **Step 1: 写失败的端到端测试**

`packages/server/src/serve/serve-host-unsupported.test.ts`：

```ts
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { CONTRACTS } from "@cjhyy/code-shell-core";
import { startHeadlessServer, type HeadlessServer } from "./headless-server.js";

const PASSCODE = "serve-unsupported-passcode";

// Stand-in worker. agent/run's task names what to emit: a loopback toolName
// becomes an approval request; a desktop/* method becomes a worker → host
// request. Whatever the host answers is echoed back as the run result.
const WORKER = `
const {createInterface}=require('node:readline');
const send=(v)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...v})+'\\n');
const runs=new Map();
createInterface({input:process.stdin}).on('line',line=>{
 const frame=JSON.parse(line);
 if(frame.method==='agent/run'){
  const {sessionId,task}=frame.params;
  if(task.startsWith('desktop/')){runs.set('host-'+frame.id,frame);send({id:'host-'+frame.id,method:task,params:{}});return;}
  runs.set(sessionId,frame);
  send({method:'agent/approvalRequest',params:{sessionId,requestId:'req-'+frame.id,connectionId:'c1',generation:1,request:{toolName:task,description:'x',riskLevel:'low',args:{}}}});
 }else if(frame.method==='agent/approve'){
  send({id:frame.id,result:{accepted:true}});
  const run=runs.get(frame.params.sessionId);
  if(run){runs.delete(frame.params.sessionId);send({id:run.id,result:{decision:frame.params.decision}});}
 }else if(frame.method===undefined&&frame.id!==undefined){
  const run=runs.get(frame.id);
  if(run){runs.delete(frame.id);send({id:run.id,result:{hostReply:frame}});}
 }else if(frame.id!==undefined)send({id:frame.id,result:{ok:true}});
});
`;

const roots: string[] = [];
const servers: HeadlessServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function startServer(): Promise<HeadlessServer> {
  const root = mkdtempSync(join(tmpdir(), "serve-unsupported-"));
  roots.push(root);
  const cwd = join(root, "workspace");
  const staticDir = join(root, "static");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, "index.html"), "<!doctype html><title>t</title>");
  const workerEntryPath = join(root, "worker.cjs");
  writeFileSync(workerEntryPath, WORKER);
  const server = await startHeadlessServer({
    host: "127.0.0.1",
    port: 0,
    cwd,
    dataDir: join(root, "serve-data"),
    workerEntryPath,
    sessionRootDir: join(root, "sessions"),
    execPath: process.execPath,
    staticRootDir: staticDir,
    passcode: PASSCODE,
  });
  servers.push(server);
  return server;
}

async function connect(server: HeadlessServer) {
  const ws = new WebSocket(`${server.url.replace(/^http/, "ws")}/ws`, {
    headers: { "x-access-passcode": PASSCODE },
  });
  sockets.push(ws);
  ws.on("error", () => {});
  const received: Array<Record<string, any>> = [];
  ws.on("message", (data) => received.push(JSON.parse(String(data))));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  async function run(sessionId: string, task: string) {
    const id = `run-${sessionId}`;
    ws.send(
      JSON.stringify({ jsonrpc: "2.0", id, method: "agent/run", params: { sessionId, task } }),
    );
    const deadline = Date.now() + 5_000;
    for (;;) {
      const reply = received.find((message) => message.id === id);
      if (reply) return reply;
      if (Date.now() > deadline) throw new Error(`no reply for ${id}`);
      await new Promise((done) => setTimeout(done, 10));
    }
  }
  return { received, run };
}

test("serve answers Desktop-only loopbacks with unsupported instead of broadcasting them", async () => {
  const client = await connect(await startServer());
  for (const [toolName, capability] of [
    ["__browser_action__", "browser"],
    ["__credential_action__", "credential.browserCookie"],
    ["__workspace_action__", "workspace.switch"],
  ] as const) {
    const reply = await client.run(
      `session-unsupported-${capability.replace(/\./g, "-")}`,
      toolName,
    );
    expect(reply.error).toBeUndefined();
    expect(reply.result.decision.approved).toBe(true);
    expect(JSON.parse(reply.result.decision.answer)).toMatchObject({
      ok: false,
      failure: "unsupported",
      capability,
    });
  }
  expect(client.received.some((message) => message.method === "agent/approvalRequest")).toBe(false);
});

test("serve rejects desktop/* worker requests immediately with a typed error", async () => {
  const client = await connect(await startServer());
  const started = Date.now();
  const reply = await client.run("session-unsupported-automation", "desktop/automationCreate");
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(reply.result.hostReply.error).toEqual({
    code: -32601,
    message: "desktop/automationCreate is not supported by this host (headless serve)",
    data: { failure: "unsupported", capability: "desktop/automationCreate" },
  });
});

test("passcode-mode health reports the contract table", async () => {
  const server = await startServer();
  expect(await (await fetch(server.url + "/health")).json()).toEqual({
    status: "ok",
    mode: "passcode",
    contracts: JSON.parse(JSON.stringify(CONTRACTS)),
  });
});
```

第三个测试属于 Task 7，先写在这里，Task 7 再让它通过。

- [ ] **Step 2: 运行，确认前两个失败**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/serve/serve-host-unsupported.test.ts
```

Expected: 第一个测试 FAIL（收到了 `agent/approvalRequest` 广播，run 等不到结果而超时）；第二个 FAIL（超时）；第三个 FAIL（缺少 `contracts`）。

- [ ] **Step 3: 在 `headless-server.ts` 里接入**

文件顶部导入区加：

```ts
import {
  isHostAuthorityRequest,
  unsupportedHostRequestResponse,
  unsupportedLoopbackAnswer,
  unsupportedLoopbackCapability,
} from "./host-requests.js";
```

在 `const routeWorkerLine = (line: string): void => {` 这一行**之前**，加一个闭包（它要用到同一作用域里的 `bridge`、`log`、`randomUUID`）：

```ts
// Answer loopbacks only Desktop main can serve, instead of leasing them to a
// Web tab that has no way to fulfil them (ch.16 §3.2 step 1.1).
const replyUnsupportedLoopback = (params: unknown): boolean => {
  const approval = params as HubApproval | undefined;
  if (!approval || typeof approval.requestId !== "string" || typeof approval.sessionId !== "string")
    return false;
  const request = approval.request as { toolName?: unknown } | undefined;
  const capability = unsupportedLoopbackCapability(request?.toolName);
  if (!capability) return false;
  log("worker.loopback_unsupported", { capability });
  void bridge
    .request(
      "agent/approve",
      {
        sessionId: approval.sessionId,
        requestId: approval.requestId,
        connectionId: approval.connectionId,
        generation: approval.generation,
        decision: { approved: true, answer: unsupportedLoopbackAnswer(capability) },
      },
      {
        id: `unsupported-reply-${randomUUID()}`,
        consume: true,
        settleOnExit: true,
        failFast: true,
        timeoutMs: 5000,
        meta: { origin: "host", producer: "serve-unsupported-loopback" },
      },
    )
    .catch(() => {});
  return true;
};
```

在 `routeWorkerLine` 里，找到这一行：

```ts
    if (!message || message.id === undefined || message.method !== undefined) {
```

紧接其后（在 `if (hubAuth && message?.method === "agent/streamEvent")` 之前）插入：

```ts
if (message && isHostAuthorityRequest(message)) {
  log("worker.host_request_unsupported", { method: message.method });
  bridge.sendLine(unsupportedHostRequestResponse(message.id, message.method));
  return;
}
if (
  !hubAuth &&
  message?.method === "agent/approvalRequest" &&
  replyUnsupportedLoopback(message.params)
)
  return;
```

在 hub 分支里找到：

```ts
if (automationWorker?.handleApproval(approval)) return;
```

紧接其后插入一行（自动化运行仍由 automation worker 先处理）：

```ts
if (replyUnsupportedLoopback(approval)) return;
```

- [ ] **Step 4: 构建并运行**

```bash
bun run --cwd packages/server build
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/server/src/serve/serve-host-unsupported.test.ts \
  packages/server/src/serve/hub-panel-loopback.test.ts \
  packages/server/src/serve/headless-server.test.ts \
  packages/server/src/serve/automation-worker.test.ts
```

Expected: 新文件前两个测试通过，第三个仍失败（留给 Task 7）；其余三个文件全部通过，证明 `__panel_action__`、租约和自动化路径没有变。

- [ ] **Step 5: 提交**

```bash
npx prettier --write packages/server/src/serve/headless-server.ts packages/server/src/serve/serve-host-unsupported.test.ts
git add packages/server/src/serve/headless-server.ts packages/server/src/serve/serve-host-unsupported.test.ts
git commit -m "fix(server): answer Desktop-only host requests as unsupported in serve"
```

---

### Task 7: `/health` 返回契约表

**Files:**

- Modify: `packages/server/src/serve/headless-server.ts:719-721`
- Modify: `packages/server/src/serve/hub-server.test.ts:219`

- [ ] **Step 1: 改 hub 测试的断言（先让它失败）**

`packages/server/src/serve/hub-server.test.ts` 顶部加导入：

```ts
import { CONTRACTS } from "@cjhyy/code-shell-core";
```

第 219 行改为：

```ts
expect(await (await fetch(server.url + "/health")).json()).toEqual({
  status: "ok",
  mode: "hub",
  contracts: JSON.parse(JSON.stringify(CONTRACTS)),
});
```

契约版本号是公开信息，和 `mode` 同级，不包含任何账号或项目数据，所以不违反这个测试"公开入口不暴露 API 数据"的意图。

- [ ] **Step 2: 运行，确认失败**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/server/src/serve/hub-server.test.ts \
  packages/server/src/serve/serve-host-unsupported.test.ts
```

Expected: hub 的 health 测试和 passcode 的 health 测试都 FAIL，缺少 `contracts`。

- [ ] **Step 3: 实现**

`headless-server.ts` 里已有 `import { SessionManager, SettingsManager } from "@cjhyy/code-shell-core";`，在其中加上 `CONTRACTS`。然后把 `/health` 分支改为：

```ts
if (pathname === "/health" && req.method === "GET") {
  hubJson(res, 200, { status: "ok", mode: hubAuth ? "hub" : "passcode", contracts: CONTRACTS });
  return;
}
```

- [ ] **Step 4: 构建并运行**

```bash
bun run --cwd packages/server build
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/server/src/serve/hub-server.test.ts \
  packages/server/src/serve/serve-host-unsupported.test.ts
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
npx prettier --write packages/server/src/serve/headless-server.ts packages/server/src/serve/hub-server.test.ts
git add packages/server/src/serve/headless-server.ts packages/server/src/serve/hub-server.test.ts
git commit -m "feat(server): report the contract table from /health"
```

---

### Task 8: AgentServer 最小版 `initialize`

**Files:**

- Modify: `packages/core/src/protocol/types.ts`（`Methods` 对象，`Run:` 那一行之前）
- Modify: `packages/core/src/protocol/server.ts`（`handleRequest` 的 `switch`，`case Methods.Run:` 之前；文件顶部导入）
- Create: `packages/core/src/protocol/server.initialize.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/core/src/protocol/server.initialize.test.ts`：

```ts
import { describe, expect, it } from "bun:test";
import { CONTRACTS } from "../contracts.js";
import { ChatSessionManager } from "./chat-session-manager.js";
import { AgentServer } from "./server.js";

function makeTransport() {
  const sent: any[] = [];
  let onMsg: (msg: unknown) => void = () => {};
  return {
    sent,
    deliver: (msg: unknown) => onMsg(msg),
    transport: {
      send: (m: unknown) => sent.push(m),
      onMessage: (cb: (msg: unknown) => void) => {
        onMsg = cb;
      },
      close: () => {},
    } as any,
  };
}

async function reply(sent: any[], id: number) {
  const deadline = Date.now() + 2_000;
  for (;;) {
    const found = sent.find((message) => message.id === id);
    if (found) return found;
    if (Date.now() > deadline) throw new Error(`no reply for ${id}`);
    await new Promise((done) => setTimeout(done, 5));
  }
}

describe("initialize", () => {
  it("returns the protocol version and the contract table without touching sessions", async () => {
    const chatManager = new ChatSessionManager({
      runtime: {} as never,
      engineFactory: () => {
        throw new Error("initialize must not create an engine");
      },
    });
    const t = makeTransport();
    new AgentServer({ transport: t.transport, chatManager });
    t.deliver({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    const response = await reply(t.sent, 1);
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ protocolVersion: "1", contracts: CONTRACTS });
  });
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/protocol/server.initialize.test.ts
```

Expected: FAIL。未知方法会被当作扩展查询，返回错误或不返回。

- [ ] **Step 3: 实现**

`packages/core/src/protocol/types.ts` 的 `Methods` 里，在 `Run: "agent/run",` 之前加：

```ts
  /** Handshake. Unprefixed on purpose: it is the Protocol v2 entry point (ch.16 §4.1). */
  Initialize: "initialize",
```

`packages/core/src/protocol/server.ts` 顶部导入区加：

```ts
import { CONTRACTS } from "../contracts.js";
```

`handleRequest` 的 `switch (req.method) {` 之后、`case Methods.Run:` 之前加：

```ts
      case Methods.Initialize:
        this.transport.send(
          createResponse(req.id, {
            protocolVersion: CONTRACTS.agentProtocol.preferred,
            contracts: CONTRACTS,
          }),
        );
        break;
```

- [ ] **Step 4: 运行，确认通过，并回归协议测试**

```bash
bun run --cwd packages/core build
node scripts/run-bun-test-shard.mjs --timeout 30000 \
  packages/core/src/protocol/server.initialize.test.ts \
  packages/core/src/protocol/server.query-session.test.ts \
  packages/core/src/protocol/server.require-existing.test.ts
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
npx prettier --write packages/core/src/protocol/types.ts packages/core/src/protocol/server.ts packages/core/src/protocol/server.initialize.test.ts
git add packages/core/src/protocol/types.ts packages/core/src/protocol/server.ts packages/core/src/protocol/server.initialize.test.ts
git commit -m "feat(core): add a minimal initialize handshake reporting CONTRACTS"
```

---

### Task 9: REPL 不再继承完整环境变量

**Files:**

- Modify: `packages/core/src/tool-system/builtin/repl.ts:11`（导入）、`:76`（`env`）
- Modify: `packages/core/src/tool-system/builtin/repl.test.ts`

- [ ] **Step 1: 写失败的测试**

在 `repl.test.ts` 的 `describe("REPL tool", () => {` 块末尾加：

```ts
test("does not inherit host secrets but keeps PATH and project env", async () => {
  const previous = process.env.CODESHELL_REPL_PROBE_TOKEN;
  process.env.CODESHELL_REPL_PROBE_TOKEN = "must-not-leak";
  try {
    const out = await replTool(
      {
        language: "javascript",
        code: "console.log(JSON.stringify({secret: process.env.CODESHELL_REPL_PROBE_TOKEN ?? null, path: Boolean(process.env.PATH), project: process.env.PROJECT_FLAG ?? null}))",
      },
      { shellEnv: { PROJECT_FLAG: "on" } } as any,
    );
    expect(JSON.parse(out)).toEqual({ secret: null, path: true, project: "on" });
  } finally {
    if (previous === undefined) delete process.env.CODESHELL_REPL_PROBE_TOKEN;
    else process.env.CODESHELL_REPL_PROBE_TOKEN = previous;
  }
});
```

- [ ] **Step 2: 运行，确认失败**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/tool-system/builtin/repl.test.ts
```

Expected: 新测试 FAIL，`secret` 为 `"must-not-leak"`，`project` 为 `null`。

- [ ] **Step 3: 实现**

`repl.ts` 导入区加：

```ts
import { buildSandboxEnv, mergeShellEnv } from "../../runtime/spawn-common.js";
```

第 76 行：

```ts
    env: { ...process.env },
```

改为：

```ts
    // Same allowlist as a sandboxed Bash: host secrets stay out, the user's
    // explicit project env (localEnvironment.env) is layered on top.
    env: mergeShellEnv(buildSandboxEnv(), ctx?.shellEnv),
```

- [ ] **Step 4: 运行，确认通过**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/tool-system/builtin/repl.test.ts
```

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
npx prettier --write packages/core/src/tool-system/builtin/repl.ts packages/core/src/tool-system/builtin/repl.test.ts
git add packages/core/src/tool-system/builtin/repl.ts packages/core/src/tool-system/builtin/repl.test.ts
git commit -F - <<'EOF'
fix(core): stop the REPL tool from inheriting the full host environment

REPL now uses the sandboxed-Bash allowlist plus the project's explicit
localEnvironment.env. Scripts that relied on an ambient API key must set
it in project settings env instead.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 10: 删除没人用的 Panel 进程审批存储

**Files:**

- Delete: `packages/desktop/src/main/panel-app-process-approval-store.ts`
- Delete: `packages/desktop/src/main/panel-app-process-approval-store.test.ts`
- Modify: `packages/desktop/src/main/panel-app-process-consent.test.ts:9`、`:42`、`:56`

生产代码没有任何地方引用这个存储。consent 测试把它作为 VM 上下文里的一个全局名传进去，但被求值的 `panel-app-bridge.ts` 源码并不读这个名字。

- [ ] **Step 1: 确认生产代码零引用**

```bash
grep -rn "panel-app-process-approval-store\|PanelAppProcessApprovalStore\|processApprovalStore" packages --include='*.ts' --include='*.tsx' | grep -v node_modules | grep -v dist/
```

Expected: 只出现在上面列出的三个文件里。如果出现在其他文件，停下来，不要删。

- [ ] **Step 2: 修改 consent 测试**

删掉第 9 行：

```ts
import { PanelAppProcessApprovalStore } from "./panel-app-process-approval-store.js";
```

删掉第 42 行（它只被第 56 行使用）：

```ts
const file = join(root, "approvals.json");
```

删掉第 56 行：

```ts
      processApprovalStore: new PanelAppProcessApprovalStore(file),
```

- [ ] **Step 3: 删除文件**

```bash
git rm packages/desktop/src/main/panel-app-process-approval-store.ts packages/desktop/src/main/panel-app-process-approval-store.test.ts
```

- [ ] **Step 4: 运行 consent 测试和 desktop 类型检查**

```bash
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/main/panel-app-process-consent.test.ts
bun run typecheck:workspaces
```

Expected: 测试通过；typecheck 0 错误。

- [ ] **Step 5: 提交**

```bash
npx prettier --write packages/desktop/src/main/panel-app-process-consent.test.ts
git add packages/desktop/src/main/panel-app-process-consent.test.ts
git commit -m "chore(desktop): remove the unreferenced Panel process approval store"
```

---

### Task 11: 更新第 16 章并整体验证

**Files:**

- Modify: `docs/architecture/16-platform-consolidation.md`

- [ ] **Step 1: 文档对齐实际做法**

- §5.2 第一条改为："REPL 改用 core 已有的 `buildSandboxEnv` 白名单加项目 `localEnvironment.env`，与沙箱化 Bash 一致；`panels/process-service.ts` 的 `safeProcessEnv` 在 S1 并入 ExecutionService 时统一。"
- §7.1 第一条改为："server 与 Desktop main 的版本常量改为引用 `CONTRACTS`；渲染进程共享的 `PANEL_APP_API_VERSION` 和 chat 包的 `DESKTOP_CONTROL_PROTOCOL_VERSION` 受 ESLint 浏览器安全规则和包依赖限制保留字面量，由 Desktop main 的漂移测试保证与 `CONTRACTS` 一致。"
- §9 的 S0 行"内容"列：把"沙箱 report-only"移到 S1，并在 1.1 后注明"分发逻辑先放在 server/serve，S1 随 packages/host 迁移"。

- [ ] **Step 2: 全量验证**

```bash
bun run typecheck
bun run lint
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/protocol packages/core/src/contracts.test.ts packages/core/src/tool-system/builtin/repl.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/server/src/serve packages/server/src/remote-relay packages/server/src/project-runtime
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/desktop/src/main/contract-versions.test.ts packages/desktop/src/main/panel-app-process-consent.test.ts packages/desktop/src/main/im-gateway-control-server.test.ts
```

Expected: 全部 0 错误、0 失败。任何失败都要贴出原始输出，不要声称完成。

- [ ] **Step 3: 提交并开 PR**

```bash
npx prettier --write docs/architecture/16-platform-consolidation.md
git add docs/architecture/16-platform-consolidation.md
git commit -m "docs: align chapter 16 S0 with the implemented approach"
git push -u origin claude/host/s0-quick-fixes
gh pr create --base main --title "feat: platform consolidation S0 quick fixes" --body-file <PR 说明文件>
```

PR 说明列出：serve 不再挂起的三种回环和 `desktop/*` 请求、`CONTRACTS` 与 `/health`、`initialize`、REPL 环境变量的行为变化（需要在项目 env 里配置 API key）、删除的文件，以及本计划"范围决定"表里没做的两项。末尾加 `🤖 Generated with [Claude Code](https://claude.com/claude-code)`。

---

## 自检记录

- **覆盖：** 第 16 章 S0 的七项，五项有对应 Task（1.0 → T1；1.1 → T4–T6；contracts → T2、T3、T7；删除存储 → T10；REPL → T9；initialize → T8），两项在"范围决定"里说明了不做的原因。
- **命名一致：** `unsupportedLoopbackCapability`、`unsupportedLoopbackAnswer`、`isHostAuthorityRequest`、`unsupportedHostRequestResponse` 在 Task 5 定义，Task 6 使用，拼写一致；`CONTRACTS.agentProtocol.preferred` 在 Task 2 定义，Task 8 使用。
- **已知风险：** Task 9 改变 REPL 行为，依赖宿主环境变量里 API key 的脚本会失效，PR 里必须写明。Task 6 的拦截在 hub 模式下排在 automation worker 之后，自动化运行里的回环仍按 automation worker 原有逻辑处理。
