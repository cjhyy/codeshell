# 全仓优化清扫(Web 闭环 + 桌面体验 + core 债)实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2026-07 新功能(sources / 数字人 / headless serve + web SPA)的体验缺口,并收口本轮模块拆分遗留的架构债,分三个 Phase 共 16 个任务落地。

**Architecture:** Phase 1 让 web 交付真正闭环(协议 DTO 下沉 core 破 web↔server 循环依赖、SPA 复用成熟的 streamReducer、build 链纳入 vite);Phase 2 补桌面体验(反馈/术语/组件规范);Phase 3 清 core 债(重复代码合一、安全校验单点、导出面收敛、巨石文件抽取)。每个任务独立可提交,行为保持不变的重构以现有测试为安全网。

**Tech Stack:** bun workspaces(不是 npm/yarn/pnpm)、bun test(不是 vitest/jest)、TypeScript、React 19.2.6(固定)、Ink(TUI)、Electron(desktop)、vite(web SPA)、shadcn/ui + Tailwind v4(desktop renderer)。

---

## 执行前须知(每个任务都适用)

- **包管理器是 bun**。构建 `bun run build`,测试 `bun test`,过滤测试 `bun test -- -t 'name'`。
- **desktop 有自己的 typecheck/build**:改了 `packages/desktop` 之后必须在 `packages/desktop` 目录里跑 `bun run typecheck`(根目录的检查不覆盖它)。根目录 `bun run typecheck` 本来就有存量报错,**不是干净门禁**,只需确认自己没有新增报错。
- **desktop renderer 规范**(packages/desktop/CLAUDE.md):禁止手写原生 `<select>`/`<button>`/modal,必须用 `@/components/ui` 组件;样式走 Tailwind 语义 token;renderer 不得运行时 import 任何 codeshell 包(type-only 可以)。
- **core 是 UI/领域无关的**:`packages/core` 禁止 import tui/desktop/electron。
- **i18n**:desktop renderer 的文案在 `packages/desktop/src/renderer/i18n/ns/*.ts`,每个文件有 `zh` 和 `en` 两个块,**加 key 必须两个块都加**。
- 提交风格:conventional commits(`feat(scope):` / `fix(scope):` / `refactor(scope):`),每个任务完成后单独提交。
- 明确不做(本计划的 non-goals,别顺手做):
  - **不把 mock adapter 移出生产注册**:desktop 的数据源目录 UI(DataSourceCatalogSection)允许用户创建 `kind: "mock"` 的源,移出会让这些源变成 "no adapter"。只做展示层可读化(Task 8)。
  - **不给 web SPA 加 i18n**(known gap,后续单独做)。
  - **不让 `packages/web/src` 运行时 import core**:该包的约定是零 core 运行时依赖(见 `packages/web/src/index.ts` 头注释),协议方法名在浏览器侧保留字符串字面量是有意的。

---

# Phase 1 — Web 交付闭环

## Task 1: mobile 协议 DTO 下沉 core,打破 web↔server 循环依赖

**背景:** `packages/web/package.json` 依赖 `@cjhyy/code-shell-server`(仅为 type-only import),`packages/server` 又运行时依赖 `@cjhyy/code-shell-web`(`serve/cli.ts:67` 用 `require.resolve("@cjhyy/code-shell-web/package.json")` 定位 SPA 产物)——构建图有环。根因是 mobile 线协议 DTO 物理上住在 server 包(`packages/server/src/mobile-remote/types.ts`,309 行,**纯类型无运行时代码**)。

**Files:**
- Create: `packages/core/src/protocol/mobile-remote-types.ts`
- Modify: `packages/server/src/mobile-remote/types.ts`(改为 re-export)
- Modify: `packages/core/src/index.ts`(追加导出)
- Modify: `packages/web/src/hooks/useRemoteSocket.ts:2`、`packages/web/src/hooks/useRemoteApp.ts:2-12`、`packages/web/src/lib/mobileAttachments.ts:1`
- Modify: `packages/web/package.json`、`packages/web/src/index.ts`(头注释)

**Steps:**

- [ ] **Step 1: 检查命名冲突。** core 的公共导出面可能已有同名类型(尤其 `PermissionMode`)。运行:

```bash
grep -rn "export type PermissionMode\|export interface PermissionMode" packages/core/src
grep -n "PermissionMode" packages/core/src/index.ts
```

若 core 已导出结构相同的 `PermissionMode`(`"default" | "acceptEdits" | "bypassPermissions"`),则新文件里**不要重复声明**,改为 `import type { PermissionMode } from "../types.js"`(按实际来源)并 re-export。其他名字(`TrustedDevice`、`MobileClientEvent` 等)同样先 grep 一遍 `packages/core/src/index.ts` 确认无冲突。

- [ ] **Step 2: 移动类型文件。** 把 `packages/server/src/mobile-remote/types.ts` 的**全部内容**原样移到 `packages/core/src/protocol/mobile-remote-types.ts`(文件头加一段注释说明来历):

```ts
/**
 * Mobile remote wire-protocol DTOs (pairing / rooms / attachments / CC rooms).
 * Moved here from @cjhyy/code-shell-server so that client packages (web) can
 * consume the protocol contract without depending on the server implementation
 * package — this file must stay pure types (no runtime code).
 */
```

- [ ] **Step 3: server 侧改为 re-export。** `packages/server/src/mobile-remote/types.ts` 全文替换为(名字以移动后的实际导出为准,逐个列全,共约 20 个):

```ts
// Wire-protocol DTOs live in core (protocol contract); server re-exports them
// so internal `./types.js` imports keep working unchanged.
export type {
  TrustedDevice,
  TrustedDevicePublic,
  PairingToken,
  ApprovalScope,
  ApprovalPathScope,
  PermissionMode,
  CcDiscoveredSession,
  CcHistoryMessage,
  CcApprovalDecision,
  MobilePermissionModeSnapshotEntry,
  MobileProjectMeta,
  MobileImageMime,
  MobileImageBase,
  MobileImageAttachment,
  MobileAttachmentSummary,
  MobileClientEvent,
  MobileServerEvent,
  RoomPublic,
  MobileSessionMeta,
} from "@cjhyy/code-shell-core";
```

若 `packages/server/package.json` 还没有 `"@cjhyy/code-shell-core": "workspace:*"` 依赖,加上。

- [ ] **Step 4: core 导出。** 在 `packages/core/src/index.ts` 追加(放在 protocol 相关导出附近):

```ts
export type * from "./protocol/mobile-remote-types.js";
```

- [ ] **Step 5: web 改 import。** 三个文件把 `from "@cjhyy/code-shell-server"` 改成 `from "@cjhyy/code-shell-core"`(都是 `import type`,保持 type-only):
  - `packages/web/src/hooks/useRemoteSocket.ts:2`
  - `packages/web/src/hooks/useRemoteApp.ts:2-12`
  - `packages/web/src/lib/mobileAttachments.ts:1`

- [ ] **Step 6: web package.json 换依赖。** `packages/web/package.json` 的 `dependencies` 里删掉 `"@cjhyy/code-shell-server": "workspace:*"`,加上 `"@cjhyy/code-shell-core": "workspace:*"`。同步更新 `packages/web/src/index.ts` 头注释第 6 行:`Protocol types come from @cjhyy/code-shell-core (type-only, erased).`

- [ ] **Step 7: 验证。**

```bash
bun install
bun test packages/web packages/server
cd packages/core && bun run build && cd ../..
grep -rn "code-shell-server" packages/web/src   # 期望:0 命中
```

期望:测试全绿,web 源码不再引用 server 包。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(protocol): move mobile remote DTOs into core, break web<->server dependency cycle"
```

---

## Task 2: `bun run build` 纳入 web SPA 构建

**背景:** 根 build 链对 web 只跑 `tsc`(逻辑层 `src/`→`dist/`),SPA 的 `vite build`(`app/`→`dist-app/`)没有任何链路调用,而 `dist-app/` 又被 gitignore——全新环境跑 `code-shell-serve` 永远命中 "No web app build found",退化成纯 WS 端点。TODO.md 大功能第 ④ 项已挂账。

**Files:**
- Modify: `packages/web/package.json:20`

**Steps:**

- [ ] **Step 1: 改 build 脚本。** `packages/web/package.json` 的 scripts:

```json
"build": "tsc -p tsconfig.json && vite build",
```

- [ ] **Step 2: 验证产物与 serve 解析。**

```bash
bun run build
ls packages/web/dist-app/index.html    # 期望:存在
```

再确认 `packages/server/src/serve/cli.ts` 的 `resolveWebAppRoot()` 拼的就是 `<web包根>/dist-app`(它经 `require.resolve("@cjhyy/code-shell-web/package.json")` 定位包根)。`packages/web/package.json` 的 `files` 数组已含 `"dist-app"`,发布链无需再动。

- [ ] **Step 3: Commit**

```bash
git add packages/web/package.json
git commit -m "build(web): include the SPA vite build in the package build script"
```

---

## Task 3: SPA 复用 streamReducer(删掉手写的第二套 reducer)

**背景:** `packages/web/app/chat.ts` 的 `foldStreamEvent` 是从零手写的简化 reducer,只处理 5 种事件——**没有 `tool_result` 分支**(工具卡片永远停在"调用中"),也没有 thinking/subagent/goal/attachments/session_title。同包 `packages/web/src/lib/streamReducer.ts`(665 行,带单测)是修复过乱序缓冲、光标残留、子 agent 隔离的成熟实现,且 `asStreamEvent`(streamReducer.ts:138)明确接受裸事件 `{type, …}`,SPA 可以直接喂。

**Files:**
- Rewrite: `packages/web/app/chat.ts`
- Modify: `packages/web/app/App.tsx`
- Modify: `packages/web/app/protocol.ts`(仅注释/类型对齐,见 Step 4)
- Test: `packages/web/app/*.test.ts`(先 `ls packages/web/app` 找到现有测试文件,同步改)

**Steps:**

- [ ] **Step 1: 读懂被复用方。** 通读 `packages/web/src/lib/streamReducer.ts` 的 `ChatState`/`ChatItem`/`reduceStream`/`initialChatState`/`appendUserMessage`(25-87、157-165、650-665 行)。关键差异:它的 `ChatItem` 是判别联合(`user`/`assistant`/`tool`/`subagent`/`system_error`),`run` 是 `RunState`("idle"/"running"/"waiting"/"completed"/"error")而不是布尔。

- [ ] **Step 2: 重写 `packages/web/app/chat.ts`** ——只保留"转写历史 → ChatState"的映射和标题推导,reducer 本体删除:

```ts
// packages/web/app/chat.ts
//
// Transcript replay + title helpers for the standalone SPA. Live stream
// folding is handled by the shared reducer in ../src/lib/streamReducer —
// do NOT reintroduce a local fold here.
import {
  initialChatState,
  type ChatItem,
  type ChatState,
} from "../src/lib/streamReducer.js";

export { initialChatState, type ChatItem, type ChatState };

/**
 * Best-effort mapping of a persisted transcript (session_detail) into chat
 * items. Transcript event shapes vary across event kinds; anything we don't
 * recognize is skipped rather than rendered wrong.
 */
export function chatFromTranscript(events: Array<Record<string, unknown>>): ChatState {
  const items: ChatItem[] = [];
  let seq = 0;
  for (const event of events) {
    const message = (event.message ?? event) as Record<string, unknown>;
    const role = message.role as string | undefined;
    if (role !== "user" && role !== "assistant") continue;
    const text = extractText(message.content);
    if (!text) continue;
    // Skip synthetic frames (system reminders ride user turns).
    if (role === "user" && text.startsWith("<system-reminder>")) continue;
    seq += 1;
    items.push(
      role === "user"
        ? { kind: "user", id: `h-${seq}`, text }
        : { kind: "assistant", id: `h-${seq}`, text, reasoning: "", done: true },
    );
  }
  return { ...initialChatState(), items, seq };
}

/** Session-rail title: reducer-pushed title, else first user line, else id. */
export function sessionTitle(state: ChatState | undefined, sessionId: string): string {
  if (state?.title) return state.title;
  const firstUser = state?.items.find((item) => item.kind === "user");
  if (firstUser && firstUser.kind === "user" && firstUser.text.trim()) {
    const line = firstUser.text.trim().split("\n")[0];
    return line.length > 32 ? `${line.slice(0, 32)}…` : line;
  }
  return sessionId.slice(0, 8);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) =>
        block && typeof block === "object" && (block as { type?: string }).type === "text"
          ? String((block as { text?: string }).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
```

注意:`chatFromTranscript` 返回值里带 `seq`,这样后续 `appendUserMessage`(它用 `state.seq + 1` 生成 id)不会跟历史项撞 id。

- [ ] **Step 3: 改 `App.tsx` 接线。** 用共享 reducer 替换本地 fold:

```tsx
import {
  reduceStream,
  appendUserMessage,
  initialChatState,
  type ChatState,
} from "../src/lib/streamReducer.js";
import { chatFromTranscript, sessionTitle } from "./chat.js";
```

- `React.useState<ChatViewState>(emptyChat)` → `React.useState<ChatState>(initialChatState())`;所有 `setChat(emptyChat)` → `setChat(initialChatState())`。
- 流事件折叠(原 App.tsx:64):`setChat((prev) => foldStreamEvent(prev, event))` → `setChat((prev) => reduceStream(prev, event))`(裸事件形态,`asStreamEvent` 认得)。
- 运行态:`chat.running` 全部换成派生值 `const running = chat.run === "running" || chat.run === "waiting";`。`serve/workerExit` 处理里的 `setChat((prev) => ({ ...prev, running: false }))` → `setChat((prev) => ({ ...prev, run: "idle" }))`。
- 发送(原 App.tsx:122):`appendUserMessage(prev, text)` 签名一致,直接用共享版。
- 会话列表标题(原 App.tsx:156):`{s.sessionId.slice(0, 8)}` → `{s.sessionId === activeId ? sessionTitle(chat, s.sessionId) : s.sessionId.slice(0, 8)}`(非激活会话没有本地 state,保持 id 前缀即可;激活会话显示真实标题)。

- [ ] **Step 4: 渲染判别联合。** 消息列表渲染(原 App.tsx:172-178)改为按 kind 分支:

```tsx
<div className="messages">
  {chat.goal ? <div className="banner goal">{chat.goal}</div> : null}
  {chat.items.map((item) => {
    switch (item.kind) {
      case "user":
        return <div key={item.id} className="msg user">{item.text}</div>;
      case "assistant":
        return (
          <div key={item.id} className="msg assistant">
            {item.text}
            {!item.done ? <span className="cursor">▍</span> : null}
          </div>
        );
      case "tool":
        return (
          <div key={item.id} className={`msg tool${item.error ? " tool-error" : ""}`}>
            <span className="tool-head">
              ⚙ {item.name} {item.done ? (item.error ? "✗" : "✓") : "…"}
            </span>
            {item.summary ? <span className="tool-summary"> {item.summary}</span> : null}
            {item.result ? (
              <details>
                <summary>结果</summary>
                <pre className="tool-result">{item.result}</pre>
              </details>
            ) : null}
          </div>
        );
      case "subagent":
        return (
          <div key={item.id} className="msg info">
            ↳ {item.label} — {item.status}
          </div>
        );
      case "system_error":
        return <div key={item.id} className="msg error">{item.text}</div>;
      default:
        return null;
    }
  })}
  …(审批卡片与空态保持原样)
</div>
```

在 SPA 的样式文件(`ls packages/web/app` 找到,`styles.css` 或内联于 `index.html`)给 `.msg.tool .tool-result`、`.msg.info`、`.banner.goal`、`.tool-error` 补最小样式(等宽、缩进、限高滚动即可,跟随现有配色变量)。

- [ ] **Step 5: 类型对齐(轻量)。** `packages/web/app/protocol.ts:9-31` 的三个本地镜像类型:先 `grep -n "SessionSummary\|ApprovalRequestPayload\|StreamEventPayload" packages/core/src/protocol/types.ts`。core 有导出同形类型的就 `import type` 替换本地声明;没有的保留本地声明,但把文件头注释改为明确说明"仅 X/Y 为本地镜像,原因:core 未导出该形状"。**不要**为此给 core 加新导出(SPA 的字面量协议面就这么大,保持自包含)。

- [ ] **Step 6: 更新/补测试。** `ls packages/web/app` 看现有测试(若 `chat.test.ts` 存在则改写)。测试至少覆盖:

```ts
import { describe, expect, test } from "bun:test";
import { reduceStream, initialChatState } from "../src/lib/streamReducer.js";
import { chatFromTranscript, sessionTitle } from "./chat.js";

describe("SPA chat state", () => {
  test("tool_use_start + tool_result renders a completed tool item", () => {
    let s = initialChatState();
    s = reduceStream(s, { type: "tool_use_start", toolCall: { id: "t1", name: "Bash" } });
    s = reduceStream(s, { type: "tool_result", toolCallId: "t1", result: "ok" });
    const tool = s.items.find((i) => i.kind === "tool");
    expect(tool && tool.kind === "tool" && tool.done).toBe(true);
  });

  test("transcript mapping keeps user/assistant text and seq continuity", () => {
    const s = chatFromTranscript([
      { message: { role: "user", content: "帮我修个 bug" } },
      { message: { role: "assistant", content: [{ type: "text", text: "好的" }] } },
    ]);
    expect(s.items.length).toBe(2);
    expect(s.seq).toBe(2);
    expect(sessionTitle(s, "abcdef123456")).toBe("帮我修个 bug");
  });

  test("sessionTitle falls back to id prefix", () => {
    expect(sessionTitle(undefined, "abcdef123456")).toBe("abcdef12");
  });
});
```

注意 `tool_result` 的事件字段名要以 `streamReducer.ts` 实际实现为准(先读 305-339 行确认是 `toolCallId` 还是别的),测试写实际字段。

- [ ] **Step 7: 验证。**

```bash
bun test packages/web
cd packages/web && bun run build && cd ../..
```

再做一次真环境 smoke:起 `code-shell-serve`(用法见 `packages/server/README.md`),浏览器里跑一个会调工具的任务,确认工具卡片能从 "…" 变成 "✓" 并可展开结果。

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(web): SPA reuses the shared stream reducer (tool results, subagents, goals, titles)"
```

---

## Task 4: SPA 体验修复(worker 崩溃语义、审批可读摘要)

**Files:**
- Modify: `packages/web/app/App.tsx`
- Modify: `packages/web/src/lib/riskClassify.ts`(补 ReadSource 案例,若已有通用兜底则跳过)

**Steps:**

- [ ] **Step 1: worker 退出横幅语义化。** serve host 的设计是 spawn-on-first-frame(下一条消息自动重启 worker),所以不该禁用发送,而是把状态讲清楚并及时清掉:
  - `serve/workerExit` 处理(App.tsx:81-85)文案改为:clean 退出 → `"agent worker 已退出,发送消息会自动重启"`;崩溃 → `"agent worker 崩溃,发送消息会自动重启"`。
  - 在流事件回调里,收到 `stream_request_start` 时 `setWorkerNote(null)`(worker 已经活了,横幅立刻消失)。

- [ ] **Step 2: 审批卡片人类可读摘要。** 先读 `packages/web/src/lib/riskClassify.ts` 的 `summarizeApproval` 签名与返回形状。在 SPA 的 `ApprovalCard`(App.tsx:213-252)里:

```tsx
import { summarizeApproval } from "../src/lib/riskClassify.js";
```

- 卡片主体先渲染 `summarizeApproval` 给出的摘要(Bash 显示命令、Edit/Write 显示文件路径等,以该函数实际能力为准)。
- 原始 JSON 从常驻 `<pre>` 降级为折叠项:`<details><summary>原始参数</summary><pre>…</pre></details>`。
- 若 `riskClassify.ts` 尚无 `ReadSource` 分支,补一个:摘要格式 `读取数据源 {args.source} / {args.scope} / {args.resource}`(该文件是 web/src 共享层,desktop 移动端同时受益)。照旁边已有 case 的写法与测试文件(若有 `riskClassify.test.ts`)补一条测试。

- [ ] **Step 3: 侧栏显示当前 workspace。** serve host 是单 cwd 的(`headless-server.ts:106` `fallbackCwd: () => opts.cwd`),但 SPA 界面上完全看不到自己在哪个目录工作。`SessionSummary` 已带 `cwd` 字段(`app/protocol.ts:9-16`):在会话列表 rail-head 下方渲染一行只读路径——取激活会话的 cwd,没有激活会话时取列表第一项的 cwd,都没有则不渲染:

```tsx
const workspaceCwd =
  sessions.find((s) => s.sessionId === activeId)?.cwd ?? sessions[0]?.cwd ?? null;
…
{workspaceCwd ? <div className="rail-cwd" title={workspaceCwd}>{workspaceCwd}</div> : null}
```

样式:`.rail-cwd` 单行截断(`text-overflow: ellipsis`)、muted 前景色。

- [ ] **Step 4: 验证 + Commit**

```bash
bun test packages/web
cd packages/web && bun run build && cd ../..
git add -A
git commit -m "fix(web): honest worker-exit banner, readable approval summaries, workspace path in the SPA"
```

---

## Task 5: server 静态托管 MIME 收敛

**背景:** `packages/server/src/serve/headless-server.ts:70-81` 的 `CONTENT_TYPES` 与 `packages/server/src/mobile-remote/mobile-static.ts:24-28` 的 MIME 表重复。两个 host(pairing host / headless serve)的装配差异是合理的,只合并静态文件原语,不合并 host。

**Files:**
- Create: `packages/server/src/static-files.ts`
- Modify: `packages/server/src/serve/headless-server.ts`、`packages/server/src/mobile-remote/mobile-static.ts`

**Steps:**

- [ ] **Step 1: 建共享模块。** 两处 MIME 表取并集:

```ts
// packages/server/src/static-files.ts
//
// Shared static-file primitives for the two HTTP hosts (pairing host's
// /mobile static root and the headless serve SPA root). Keep this file free
// of host wiring — MIME map + helpers only.
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
  ".woff2": "font/woff2",
};

export function contentTypeFor(extname: string): string {
  return CONTENT_TYPES[extname.toLowerCase()] ?? "application/octet-stream";
}
```

先核对 `mobile-static.ts` 的表里是否有上面没有的扩展名(如 `.woff`、`.webp`),有则并入。

- [ ] **Step 2: 两处替换。** `headless-server.ts` 删除本地 `CONTENT_TYPES`,静态响应处改用 `contentTypeFor(extname(filePath))`;`mobile-static.ts` 同样替换本地表。**不要**动两个 host 各自的路由/门禁逻辑。

- [ ] **Step 3: 验证 + Commit**

```bash
bun test packages/server
git add -A
git commit -m "refactor(server): share the static-file MIME table between the two hosts"
```

---

# Phase 2 — 桌面体验补齐

> 本 Phase 每个任务完成后都要:`cd packages/desktop && bun run typecheck`。涉及 i18n 的,zh/en 两个块都改。

## Task 6: 数据源操作反馈 + 删除确认 + 加载态收敛

**Files:**
- Modify: `packages/desktop/src/renderer/project-config/DataSourcesSection.tsx`
- Modify: `packages/desktop/src/renderer/i18n/ns/project-config.ts`(zh 块约 :9 起、en 块约 :57 起)

**Steps:**

- [ ] **Step 1: 引入 toast。** `import { useToast } from "../ui/ToastProvider";`(用法:`toast({ message: "…" })` / `toast({ message: "…", variant: "error" })`)。组件内 `const toast = useToast();`

- [ ] **Step 2: `act()` 增加成功提示。** 签名改为:

```tsx
const act = async (
  operation: () => Promise<unknown>,
  opts?: { clearSelection?: boolean; successMessage?: string },
) => {
  setBusy(true);
  setError(null);
  try {
    await operation();
    await refresh();
    if (opts?.clearSelection) {
      scopeRequest.current += 1;
      setSelectedSourceId("");
      setScopes([]);
      setSelectedScopes(new Set());
    }
    if (opts?.successMessage) toast({ message: opts.successMessage });
  } catch (caught) {
    setError(errorText(caught));
  } finally {
    setBusy(false);
  }
};
```

四个调用点分别传:上传 → `t("projectConfig.dataSources.uploadDone")`;删除上传 → `deleteUploadDone`;绑定 → `bindDone`;解绑 → `unbindDone`。原 `act(fn, true)` 调用改为 `act(fn, { clearSelection: true, successMessage: … })`。

- [ ] **Step 3: 删除上传加确认。** 仿照 `credentials/DataSourceCatalogSection.tsx:83` 的既有模式:

```tsx
onClick={() => {
  if (!window.confirm(t("projectConfig.dataSources.deleteUploadConfirm", { name: upload.name })))
    return;
  void act(() => window.codeshell.deleteUpload(cwd, upload.name), {
    successMessage: t("projectConfig.dataSources.deleteUploadDone"),
  });
}}
```

- [ ] **Step 4: 加载态收敛。** 现状是 error/loading/空态可叠加渲染(DataSourcesSection.tsx:133-136 + 各空态)。改为:`loading === true` 时整个 section 主体只渲染 loading 一行,`return` 早退(标题保留);loading 结束后才渲染上传/已绑定/绑定表单三块。error 显示在标题下,与 loading 互斥。

- [ ] **Step 5: i18n 新 key(zh/en 都加)。** `projectConfig.dataSources` 下新增:`uploadDone`(已上传)、`deleteUploadDone`(已删除)、`deleteUploadConfirm`(确定删除 {name}?该文件将从项目 uploads 目录移除)、`bindDone`(已绑定数据源)、`unbindDone`(已解绑)。

- [ ] **Step 6: 验证 + Commit**

```bash
cd packages/desktop && bun run typecheck && cd ../..
git add -A
git commit -m "feat(desktop): success toasts, delete confirm and coherent loading state for data sources"
```

---

## Task 7: 数据源 UI 规范化(SimpleSelect / kind 可读标签 / readPolicy 可选 / 内置徽标)

**Files:**
- Modify: `packages/desktop/src/renderer/project-config/DataSourcesSection.tsx`
- Modify: `packages/desktop/src/renderer/credentials/DataSourceCatalogSection.tsx`
- Modify: `packages/desktop/src/renderer/i18n/ns/project-config.ts`、对应 `ext.link.*` 所在的 ns 文件(grep `sourcesKind` 定位)

**Steps:**

- [ ] **Step 1: kind 可读标签 helper。** 在 `DataSourcesSection.tsx` 加(`DataSourceCatalogSection` 同样用一份,可放共享位置或各自内联):

```tsx
function kindLabel(t: TFunction, kind: string): string {
  if (kind === "mock") return t("projectConfig.dataSources.kindMock");
  if (kind === "mcp-resource") return t("projectConfig.dataSources.kindMcpResource");
  if (kind === "local-files") return t("projectConfig.dataSources.kindLocalFiles");
  return kind;
}
```

i18n:`kindMock` = `演示数据 (mock)` / `Demo data (mock)`;`kindMcpResource` = `MCP 资源` / `MCP resources`;`kindLocalFiles` = `本地上传` / `Local uploads`。已绑定列表的 `<Badge variant="secondary">{item.kind}</Badge>`(:208)改为 `{kindLabel(t, item.kind)}`。

- [ ] **Step 2: 绑定下拉换 SimpleSelect。** 替换 `DataSourcesSection.tsx:259-270` 的原生 `<select>`(违反 desktop/CLAUDE.md):

```tsx
import { SimpleSelect } from "@/components/ui/simple-select";

<SimpleSelect
  size="sm"
  value={selectedSourceId}
  disabled={busy}
  placeholder={t("projectConfig.dataSources.sourcePlaceholder")}
  ariaLabel={t("projectConfig.dataSources.sourceLabel")}
  onChange={(value) => void selectSource(value)}
  options={available.map((source) => ({
    value: source.id,
    label: source.label,
    description: kindLabel(t, source.kind),
  }))}
/>
```

- [ ] **Step 3: catalog 的 kind 下拉同样换 SimpleSelect。** `DataSourceCatalogSection.tsx:109-118` 的原生 `<select>` 改为 SimpleSelect,options 用 Step 1 的可读标签(value 仍是 `mock` / `mcp-resource`);`:175` 附近直接渲染 `source.kind` 的 Badge 一并换 `kindLabel`。原生 select 上的 `key={formVersion}` 重置技巧改为受控:把 `kind` state 作为 `value` 传入即可,重置时 `setKind("mock")`。

- [ ] **Step 4: readPolicy 可选。** 绑定表单新增状态 `const [readPolicy, setReadPolicy] = React.useState<"ask" | "deny">("ask");`,在 scope 复选和绑定按钮之间加一组 SimpleSelect(sm):

```tsx
<label className="block space-y-1 text-xs text-muted-foreground">
  <span>{t("projectConfig.dataSources.readPolicyLabel")}</span>
  <SimpleSelect
    size="sm"
    value={readPolicy}
    disabled={busy}
    onChange={(value) => setReadPolicy(value)}
    options={[
      {
        value: "ask",
        label: t("projectConfig.dataSources.readPolicyAsk"),
        description: t("projectConfig.dataSources.readPolicyAskDesc"),
      },
      {
        value: "deny",
        label: t("projectConfig.dataSources.readPolicyDeny"),
        description: t("projectConfig.dataSources.readPolicyDenyDesc"),
      },
    ]}
  />
</label>
```

绑定调用里 `readPolicy: "ask"`(:328)改为 `readPolicy`。绑定成功后把 `readPolicy` 重置回 `"ask"`。i18n 新 key:`readPolicyLabel`(读取策略)、`readPolicyAskDesc`(读取内容前逐次审批)、`readPolicyDenyDesc`(只暴露元数据,不允许读取内容)。

- [ ] **Step 5: 内置源徽标。** `:224` 对 `project-uploads` 隐藏解绑按钮的分支,补一个说明徽标,别让那一行光秃秃:

```tsx
{item.sourceId !== "project-uploads" ? (
  <Button …>{t("projectConfig.dataSources.unbind")}</Button>
) : (
  <Badge variant="outline">{t("projectConfig.dataSources.builtinBadge")}</Badge>
)}
```

i18n:`builtinBadge` = `内置` / `Built-in`。

- [ ] **Step 6: 验证 + Commit**

```bash
cd packages/desktop && bun run typecheck && cd ../..
git add -A
git commit -m "feat(desktop): SimpleSelect + readable kinds + readPolicy picker in data-source UI"
```

---

## Task 8: 数字人术语统一 + 广场就近反馈

**背景:** 同一个 `activateProfile` 动作,设置页叫"激活/关闭/当前"(`i18n/ns/settings.ts` profiles 块,约 :142-152),广场叫"设为项目默认/取消项目默认/项目默认"(`i18n/ns/digital-humans.ts`),广场还有语义不同的"使用"(临时选中)。统一采用**广场话术**(它更准确:激活的本质就是设为该项目默认数字人)。

**Files:**
- Modify: `packages/desktop/src/renderer/i18n/ns/settings.ts`(zh/en 的 `profiles` 块)
- Modify: `packages/desktop/src/renderer/i18n/ns/digital-humans.ts`(zh/en)
- Modify: `packages/desktop/src/renderer/digital_humans/DigitalHumansView.tsx`(路径以 grep 为准:`grep -rn "DigitalHumansView" packages/desktop/src/renderer --include="*.tsx" -l`)

**Steps:**

- [ ] **Step 1: settings 术语对齐。** `settings.ts` profiles 块:`activate` → `设为项目默认` / `Set as project default`;`deactivate` → `取消项目默认` / `Clear project default`;`activeBadge` → `项目默认` / `Project default`。subtitle 里的"激活一个数字同事"相应微调("给这个 Workspace 设一个默认数字同事…")。ProfileSection.tsx 引用的是 key,不用改代码。

- [ ] **Step 2: 广场解释"使用 vs 设为默认"。** `digital-humans.ts` zh 块给 `use` 补 hint key:`useHint: "本次会话临时使用"`、`setProjectDefaultHint: "此项目的新会话默认由 TA 接手"`(en 对应翻译)。在 DigitalHumansView 卡片操作区把这两句渲染为按钮下的 `text-xs text-muted-foreground` 说明(或按钮 `title` + 选中卡片详情区文字,以现有布局阻力最小为准,但**必须有可见文字**,不能只有 hover title)。

- [ ] **Step 3: 禁用原因可见化。** DigitalHumansView.tsx:370-380,"设为项目默认"在无 `activeProjectPath` 时 disabled 且只有 title 提示。改为:禁用时在按钮旁渲染可见的 `<p className="text-xs text-muted-foreground">{t("digitalHumans.pickProject")}</p>`(key 已存在)。同样处理 :213-220 "创建团队"按钮(成员 < 2 禁用时可见提示,复用现有空态文案 key)。

- [ ] **Step 4: 安装/失败就近反馈。** DigitalHumansView 目前错误集中在顶部横幅(:139-143)。改为:
  - `import { useToast } from "../ui/ToastProvider";`(相对路径按实际目录层级调整)。
  - 安装成功:`toast({ message: t("digitalHumans.installDone", { name }) })`,新 key `installDone` = `已添加 {name}` / `Added {name}`。
  - 安装/激活失败:`toast({ message: t("digitalHumans.actionFailed", { name, message }), variant: "error" })`,新 key `actionFailed` = `{name} 操作失败:{message}`。顶部全局横幅仅保留列表加载失败这类页面级错误。

- [ ] **Step 5: 验证 + Commit**

```bash
cd packages/desktop && bun run typecheck && cd ../..
git add -A
git commit -m "feat(desktop): unify digital-human activation wording and add per-card feedback"
```

---

## Task 9: TopBar 数字人指示器脱离 git 依赖

**背景:** `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx:429` 在非 git 仓库时整组件 `return null`,连带隐藏数字人徽标;徽标(:444-451)还嵌在 worktree 切换按钮里,点它打开的是分支菜单,误导。

**Files:**
- Modify: `packages/desktop/src/renderer/topbar/WorkspaceIndicator.tsx`
- Test: `packages/desktop/src/renderer/topbar/WorkspaceIndicator.test.tsx`
- Modify: TopBar i18n ns(grep `topbar.workspace` 定位文件)

**Steps:**

- [ ] **Step 1: 徽标独立成元素。** 把 :444-451 的 `<span data-active-profile …>` 从 PopoverTrigger 按钮**里面移出来**,做成组件级变量:

```tsx
const profileBadge = activeProfileLabel ? (
  <span
    data-active-profile="true"
    title={t("topbar.workspace.activeProfileTitle", { name: activeProfileLabel })}
    className="no-drag ml-1 inline-flex h-7 max-w-28 items-center truncate rounded-sm bg-secondary px-1.5 text-xs text-secondary-foreground"
  >
    {activeProfileLabel}
  </span>
) : null;
```

i18n 新 key `activeProfileTitle` = `当前数字人:{name}(在设置 › 数字人中切换)` / `Active digital human: {name} (switch in Settings › Digital humans)`。

- [ ] **Step 2: 渲染顺序调整。** 非 git 早退(:426-429)改为仍显示徽标:

```tsx
if (!canLoad) return null;
if (isGitRepo !== true) return profileBadge;
```

git 分支正常路径的 return 改为并排:`<TooltipProvider …><Popover …>…</Popover>{profileBadge}</TooltipProvider>`(徽标放在 Popover 外、按钮后面,布局上仍在同一行)。

- [ ] **Step 3: 更新测试。** `WorkspaceIndicator.test.tsx` 里针对 `data-active-profile` 的断言:补一条"非 git 仓库时徽标仍渲染"(mock `isGitRepo` 为 false 的现有测试路径上断言 `data-active-profile` 存在);确认徽标不再位于 trigger button 内部(可断言 `button` 元素内无 `data-active-profile`)。跑 `bun test -- -t 'WorkspaceIndicator'` 修到全绿。

- [ ] **Step 4: 验证 + Commit**

```bash
bun test packages/desktop/src/renderer/topbar
cd packages/desktop && bun run typecheck && cd ../..
git add -A
git commit -m "fix(desktop): show the active digital-human badge outside the git worktree switcher"
```

---

## Task 10: ReadSource 审批卡片可读化(desktop 渲染端)

**背景:** ReadSource 审批时用户看到的是 `{source, scope, resource}` 三个内部 id(`packages/core/src/tool-system/builtin/sources.ts:109-122`),难以判断。web 侧已在 Task 4 通过 `riskClassify.summarizeApproval` 处理;本任务补 desktop 主渲染端。

**Files:**
- Modify: desktop renderer 的审批卡片组件(定位:`grep -rn "approvalRequest\|ApprovalRequest" packages/desktop/src/renderer --include="*.tsx" -l`,找到渲染工具审批参数的组件)

**Steps:**

- [ ] **Step 1: 定位并读懂现有审批渲染。** 弄清参数当前如何展示(JSON / 分字段),以及是否已有 per-tool 摘要机制(如果 desktop 复用了 web 的 `summarizeApproval`,那 Task 4 的 ReadSource 分支已生效,本任务只需验证后跳过并在 commit 里注明)。

- [ ] **Step 2: 加 ReadSource 分支。** 在参数摘要处对 `toolName === "ReadSource"` 特判,渲染一句话:`读取数据源 {args.source} · 范围 {args.scope} · 资源 {args.resource}`(i18n key 放入审批相关 ns,zh/en 都加)。原始参数保持原有展示方式作为补充。

- [ ] **Step 3: 验证 + Commit**

```bash
cd packages/desktop && bun run typecheck && cd ../..
git add -A
git commit -m "feat(desktop): human-readable ReadSource approval summary"
```

---

# Phase 3 — core 架构债

## Task 11: `truncateUtf8` 四份实现合一

**背景:** 同一套 UTF-8 边界回退截断在 4 个文件各写一遍:`tool-system/builtin/sources.ts:55`(string)、`sources/adapters/mock.ts:11`(string)、`sources/adapters/mcp-resource.ts:27`(string)、`sources/adapters/local-files.ts:83`(Buffer)。

**Files:**
- Create: `packages/core/src/sources/truncate-utf8.ts`
- Create: `packages/core/src/sources/truncate-utf8.test.ts`
- Modify: 上述 4 个文件

**Steps:**

- [ ] **Step 1: 写测试(先失败)。**

```ts
// packages/core/src/sources/truncate-utf8.test.ts
import { describe, expect, test } from "bun:test";
import { truncateUtf8Bytes, truncateUtf8Text } from "./truncate-utf8.js";

describe("truncateUtf8", () => {
  test("returns text unchanged when under the limit", () => {
    expect(truncateUtf8Text("hello", 10)).toEqual({ text: "hello", truncated: false });
  });

  test("never splits a multibyte character", () => {
    // "你" is 3 bytes in UTF-8; a 4-byte budget fits only one whole char.
    const { text, truncated } = truncateUtf8Text("你好", 4);
    expect(text).toBe("你");
    expect(truncated).toBe(true);
  });

  test("buffer variant matches text variant on the same input", () => {
    const buf = Buffer.from("héllo wörld", "utf8");
    const viaBytes = truncateUtf8Bytes(buf, 7);
    const viaText = truncateUtf8Text("héllo wörld", 7);
    expect(viaBytes).toEqual(viaText);
  });

  test("zero budget yields empty text, truncated", () => {
    expect(truncateUtf8Text("abc", 0)).toEqual({ text: "", truncated: true });
  });
});
```

Run: `bun test packages/core/src/sources/truncate-utf8.test.ts` → 期望 FAIL(模块不存在)。

- [ ] **Step 2: 实现。**

```ts
// packages/core/src/sources/truncate-utf8.ts
//
// Single home for UTF-8-safe byte truncation used by the sources tool layer
// and every connector adapter. Backs off to the previous character boundary
// so a multibyte character is never split.
export interface TruncatedText {
  text: string;
  truncated: boolean;
}

export function truncateUtf8Bytes(buffer: Buffer, maxBytes: number): TruncatedText {
  const limit = Math.max(0, Math.min(Math.trunc(maxBytes), buffer.byteLength));
  if (buffer.byteLength <= limit) {
    return { text: buffer.toString("utf8"), truncated: false };
  }
  let end = limit;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString("utf8"), truncated: true };
}

export function truncateUtf8Text(text: string, maxBytes: number): TruncatedText {
  return truncateUtf8Bytes(Buffer.from(text, "utf8"), maxBytes);
}
```

- [ ] **Step 3: 替换四处调用。** 逐个文件删掉本地 `truncateUtf8`,改 import 共享版。注意各处原返回形状略有差异(local-files 的 Buffer 版原来只返回 string)——以共享版 `{text, truncated}` 为准调整调用点;`tool-system/builtin/sources.ts:173` 的边界二次截断**保留**(那是有意的防御,见其 :171-172 注释),只是换成共享函数。

- [ ] **Step 4: 验证 + Commit**

```bash
bun test packages/core/src/sources packages/core/src/tool-system
git add -A
git commit -m "refactor(sources): single UTF-8-safe truncation helper for tool layer and adapters"
```

---

## Task 12: uploads 路径校验单点化(安全)

**背景:** 同一套"多轮 decode + 拒绝穿越 + 限制在 uploads 目录内"的防逃逸规则写了两份:core 读路径(`packages/core/src/sources/adapters/local-files.ts:28-81`)与 desktop 写路径(`packages/desktop/src/main/sources-service.ts:62-90` 的 `uploadTarget`)。两处靠人工同步,一处放宽即成漏洞。

**Files:**
- Modify: `packages/core/src/sources/adapters/local-files.ts`(新增导出 `resolveUploadTarget`)
- Modify: `packages/desktop/src/main/sources-service.ts`(删本地 `uploadTarget`,改调 core)
- Test: `packages/core/src/sources/adapters/local-files.test.ts`(追加用例)

**Steps:**

- [ ] **Step 1: 先写测试(追加到现有 local-files 测试文件)。**

```ts
import { resolveUploadTarget } from "./local-files.js";

describe("resolveUploadTarget", () => {
  test("resolves a plain basename inside the uploads dir", () => {
    const target = resolveUploadTarget("/tmp/proj", "notes.md");
    expect(target.endsWith("/uploads/notes.md")).toBe(true);
  });

  for (const bad of [
    "../escape.md",
    "a/b.md",
    "a\\b.md",
    ".hidden",
    "%2e%2e%2fescape.md",
    "nul\0l.md",
    "",
  ]) {
    test(`rejects ${JSON.stringify(bad)}`, () => {
      expect(() => resolveUploadTarget("/tmp/proj", bad)).toThrow(/invalid upload name/);
    });
  }
});
```

路径断言按 `uploadsDir(cwd)` 的真实布局调整(先读该函数)。Run → FAIL。

- [ ] **Step 2: 实现。** 把 desktop `uploadTarget` 的逻辑**原样搬**进 `local-files.ts` 导出(规则一字不改,这是安全等价迁移):

```ts
/**
 * Validate an upload file name and resolve its absolute target path inside
 * uploadsDir(cwd). Single source of truth for the write-side rule — the
 * read-side (resolveInsideUploads) must stay at least as strict.
 */
export function resolveUploadTarget(cwd: string, name: string): string {
  let decoded = name;
  try {
    for (let pass = 0; pass < 3; pass += 1) {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    }
  } catch {
    throw new Error(`invalid upload name: ${name}`);
  }
  if (
    !name ||
    name !== decoded ||
    name.startsWith(".") ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    basename(name) !== name
  ) {
    throw new Error(`invalid upload name: ${name}`);
  }
  const root = resolve(uploadsDir(cwd));
  const target = resolve(root, name);
  if (dirname(target) !== root) throw new Error(`invalid upload name: ${name}`);
  return target;
}
```

(`basename`/`resolve`/`dirname` 从 `node:path` 引,文件顶部 import 里补齐。)

- [ ] **Step 3: desktop 改调。** `sources-service.ts` 删除本地 `uploadTarget`,`import { resolveUploadTarget } from "@cjhyy/code-shell-core";`(Task 13 若已把它挪到 `/internal`,则从 `/internal` 引;两个任务谁先做都行,后做的那个负责对齐),`uploadFiles`/`deleteUpload` 调用点改名。

- [ ] **Step 4: 补 binding 单测(顺手补上评审发现的覆盖缺口)。** `packages/core/src/sources/binding.ts` 的 `bindSource`/`unbindSource`(:19-32)没有直接单测(只被 resolve.test.ts 间接经过)。新建 `packages/core/src/sources/binding.test.ts`,参照 `resolve.test.ts` 现成的 SettingsManager fixture 写法,覆盖:同一 sourceId 重复 bind 不产生重复条目(去重)、unbind 后 `listBindings` 不再包含该源、bind 写入的 scopes/readPolicy 能原样读回。

- [ ] **Step 5: 验证 + Commit**

```bash
bun test packages/core/src/sources
cd packages/desktop && bun run typecheck && cd ../..
git add -A
git commit -m "refactor(sources): single-source the uploads path-escape validation in core"
```

---

## Task 13: sources/profile 运行时导出迁 `/internal`

**背景:** sources 的 catalog/binding/resolve 与 profile 的 store/activation 目前从公共 `.` 入口导出(`packages/core/src/index.ts:139-142, 352-362`),但唯一消费方是 desktop main(`sources-service.ts`、`profiles-service.ts`)。按 CODESHELL.md 的入口契约,host-only 面应走 `/internal`,避免还在演进的预留缝(`resolve.ts` 的 `sessionProfile` 缝、`requiredSources` 预留)被外部锁死为稳定 SDK。

**原则:类型与 zod schema 留在 `.`,运行时函数迁 `/internal`。** 特别注意:
- `SourceDefinition`/`WorkspaceSourceBinding` schema 被 `settings/schema.ts:6` 引用,且 renderer 有 type-only import(如 `DataSourcesSection.tsx:2-7` 引 `EffectiveSourceAccess` 等)——**这些 type 导出必须留在 `.`**。
- desktop renderer 的 type-only import 不受影响(eslint 允许),只有 main 进程的运行时 import 要改路径。

**Files:**
- Modify: `packages/core/src/index.ts`、`packages/core/src/index.internal.ts`
- Modify: `packages/desktop/src/main/sources-service.ts`、`packages/desktop/src/main/profiles-service.ts`(及 grep 到的其他 main 侧消费点)

**Steps:**

- [ ] **Step 1: 盘点消费面。**

```bash
grep -rn "from \"@cjhyy/code-shell-core\"" packages/desktop/src/main packages/tui/src | grep -iE "source|profile|capabilit" 
```

列出所有运行时 import 的符号清单;renderer 里的同名 import 确认全部是 `import type`。

- [ ] **Step 2: 移动导出。** `packages/core/src/index.ts`:sources/profile/capability-control 三块导出改为**只导出类型与 schema**(`export type { … }` + zod schema 常量);运行时函数(catalog store 的增删改查、`bindSource`/`unbindSource`/`listBindings`、`resolveEffectiveSourceAccess`、`defaultCredentialStatus`、profile 的 store/activation/resolve 函数、Task 12 的 `resolveUploadTarget` 等)整体挪到 `packages/core/src/index.internal.ts`(加一段分组注释 `── Sources / WorkspaceProfile host surface (desktop main) ──`)。

- [ ] **Step 3: desktop main 改路径。** Step 1 清单里的运行时 import 全部 `from "@cjhyy/code-shell-core/internal"`。

- [ ] **Step 4: 验证。**

```bash
cd packages/core && bun run build && cd ../..
bun test packages/core
cd packages/desktop && bun run typecheck && cd ../..
bun run lint
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(core): move sources/profile host runtime surface to the /internal entry"
```

---

## Task 14: desktop main 协议方法名改用 core 常量

**背景:** core 已集中声明方法名常量(`packages/core/src/protocol/types.ts:495-508` 的 `Methods`),但 desktop main 用裸字符串(如 `mobile-remote-orchestrator.ts:345` 的 `"agent/streamEvent"`)。**只改 desktop main**——`packages/web/src` 与 SPA 保持字面量(该包约定零 core 运行时依赖,见执行前须知)。

**Steps:**

- [ ] **Step 1: 定位与替换。**

```bash
grep -rn '"agent/streamEvent"\|"agent/approvalRequest"\|"agent/approvalResolved"\|"agent/runAccepted"\|"agent/status"' packages/desktop/src/main
```

每处改为 `Methods.StreamEvent` 等(`import { Methods } from "@cjhyy/code-shell-core";`;若该文件已有 core import 则并入)。

- [ ] **Step 2: 验证 + Commit**

```bash
cd packages/desktop && bun run typecheck && cd ../..
git add -A
git commit -m "refactor(desktop): use core Methods constants for protocol method names in main"
```

---

## Task 15: mobile-remote-orchestrator 按域拆分

**背景:** `packages/desktop/src/main/mobile-remote-orchestrator.ts` 共 1013 行,是合规的胶水(零传输原语,该留 desktop),但单文件里 `handleMobileClientEvent`(约 :432-735,300 行大 switch)、`handleRoomEvent`(约 :766-894)、`handleCcRoomEvent`(约 :920 起)三个巨型方法堆在一起。**纯机械拆分,行为零变化。**

**Files:**
- Create: `packages/desktop/src/main/mobile-remote/handle-client-event.ts`
- Create: `packages/desktop/src/main/mobile-remote/handle-room-event.ts`
- Create: `packages/desktop/src/main/mobile-remote/handle-cc-room-event.ts`
- Modify: `packages/desktop/src/main/mobile-remote-orchestrator.ts`

**Steps:**

- [ ] **Step 1: 定义上下文接口。** 通读三个方法,归纳它们用到的 orchestrator 成员(bridge、window/webContents、settings、rooms、日志等),在 `handle-client-event.ts` 里声明一个 `OrchestratorCtx` 接口(三个模块共用,放第一个文件里导出即可)。字段名与 orchestrator 现有成员一一对应。

- [ ] **Step 2: 逐个搬函数。** 每个 `handleXxxEvent` 改写为模块级纯函数 `export function handleXxx(ctx: OrchestratorCtx, event: …): …`,**函数体逐行原样搬**(包括注释),仅把 `this.foo` 替换为 `ctx.foo`。orchestrator 里原方法体改成一行委托:`return handleClientEvent(this.ctx(), event);`(orchestrator 加一个私有 `ctx()` 组装方法)。

- [ ] **Step 3: 验证。** 这是纯搬运,门禁是编译 + 既有测试:

```bash
cd packages/desktop && bun run typecheck && cd ../..
bun test packages/desktop
```

若 desktop 有 mobile-remote 相关测试(grep `mobile-remote` `packages/desktop/**/*.test.*`)必须全绿。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(desktop): split mobile-remote orchestrator event handlers by domain"
```

---

## Task 16: engine.ts run 启动组装抽取(最谨慎的一步,放最后)

**背景:** `packages/core/src/engine/engine.ts`(4142 行,全仓最大)里,本轮新增的 profile/sources 接线缝在 run 启动路径上:workspace-profile 解析(约 :1361-1372)与 `PromptComposer` 构造(约 :1952-1986,含 `profileMainInstruction`/`profileMemoryDir`/`buildSourcesContextSummary` 注入)。把这两段抽成可单测的纯函数,是消化巨石的第一刀。**行为保持不变;只做提取,不改语义。**

**约束:**
- 保持 `new Engine(` 构造面不变——改完必须过 `bun run lint:engine-bypass`。
- 现有测试是安全网:`packages/core/src/engine/engine.workspace-profile-session.test.ts` 等 engine 测试必须全绿。
- 注释随代码搬走(包括 `:1954-1955` 关于 `profile` 变量名被占用的中文注释)。

**Files:**
- Create: `packages/core/src/engine/run-setup.ts`
- Create: `packages/core/src/engine/run-setup.test.ts`
- Modify: `packages/core/src/engine/engine.ts`

**Steps:**

- [ ] **Step 1: 抽 workspace-profile 解析。** 在 `run-setup.ts` 建:

```ts
import {
  resolveActiveWorkspaceProfile,
  profileOverridesFromDefinition,
} from "../profile/resolve.js";   // import 路径以 engine.ts 现有 import 为准
import type { SettingsManager } from "../settings/manager.js";

export interface RunProfileState {
  workspaceProfile: ReturnType<typeof resolveActiveWorkspaceProfile>;
  sessionProfileOverrides: ReturnType<typeof profileOverridesFromDefinition> | undefined;
}

/** Resolve the digital-human profile bound to this run (session pin wins). */
export function resolveRunProfileState(args: {
  sessionWorkspaceProfile: string | undefined;
  cwd: string;
  settings: SettingsManager;
}): RunProfileState {
  const { sessionWorkspaceProfile, cwd, settings } = args;
  const workspaceProfile = resolveActiveWorkspaceProfile({
    ...(sessionWorkspaceProfile ? { sessionProfile: sessionWorkspaceProfile } : {}),
    cwd,
    settings,
  });
  if (sessionWorkspaceProfile && !workspaceProfile) {
    throw new Error(`Workspace profile "${sessionWorkspaceProfile}" is unavailable`);
  }
  const sessionProfileOverrides =
    sessionWorkspaceProfile && workspaceProfile
      ? profileOverridesFromDefinition(workspaceProfile)
      : undefined;
  return { workspaceProfile, sessionProfileOverrides };
}
```

engine.ts :1361-1372 改为一次调用并解构。类型名/返回类型以 engine.ts 实际 import 与用法为准微调(先读那两段的真实上下文)。

- [ ] **Step 2: 抽 PromptComposer 配置组装。** 把 :1957-1986 的 `new PromptComposer({ … })` 参数对象组装抽为 `buildPromptComposerConfig(deps): PromptComposerConfig`,`deps` 是显式接口(cwd、model、preset、config 若干字段、workspaceProfile、disabledSkills/Plugins、capability seams、settings getter 等——以实际引用为准逐个列出,**不要**把整个 `this` 传进去)。engine.ts 调用点变成:

```ts
const promptComposer = new PromptComposer(
  buildPromptComposerConfig({ /* 显式字段 */ }),
);
```

- [ ] **Step 3: 补单测。** `run-setup.test.ts` 至少覆盖:
  - session 指定的 profile 不存在时 `resolveRunProfileState` 抛 `Workspace profile "…" is unavailable`;
  - 无 session profile 时不抛且 overrides 为 undefined;
  - `buildPromptComposerConfig` 在给定 workspaceProfile(带 `portableMemory: true`)时产出 `profileMainInstruction` 与 `profileMemoryDir`,不带时两者为 undefined。
  写法参考 `engine.workspace-profile-session.test.ts` 里现成的 profile fixture 构造方式。

- [ ] **Step 4: 验证。**

```bash
bun test packages/core/src/engine
bun run lint:engine-bypass
bun run lint
```

期望:engine 测试全绿,engine-bypass 守卫通过。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(engine): extract run-startup profile/prompt assembly into run-setup"
```

---

# 收尾:全量验收

- [ ] **Step 1: 全量验证。**

```bash
bun install
bun run build          # 应产出 packages/web/dist-app
bun test
bun run lint
bun run lint:engine-bypass
cd packages/desktop && bun run typecheck && bun run build && cd ../..
```

- [ ] **Step 2: 端到端 smoke。** 按 `packages/server/README.md` 起 `code-shell-serve`,浏览器验证:passcode 门禁 → 会话列表(有可读标题)→ 新建会话跑一个带工具调用的任务 → 工具卡片显示完成态与结果 → 触发一次审批看到可读摘要 → kill worker 进程后横幅文案正确、再发消息自动重启。

- [ ] **Step 3: 更新 TODO.md。** "服务端部署 + Web Client"条目:剩余阶段 ④(build 链)标记完成;"web UI 打磨"补记已完成的 transcript 渲染增强部分(attachment、多 workspace 切换仍是遗留)。本计划完成项按 TODO.md 顶部规则从待办中删除/更新。

- [ ] **Step 4: 提交收尾。**

```bash
git add TODO.md
git commit -m "docs(todo): record optimization sweep completion (web closure + desktop UX + core debt)"
```
