# 手机/平板遥控 UI 重构为独立 React 应用 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `mobile-ui.ts` 里 690 行内联模板字符串重构成 `packages/desktop/src/mobile/` 下一套独立 vite 构建的 React 应用,复用 desktop 的 shadcn 组件,补齐与桌面端的能力/可见性对齐(真实会话列表+历史回放+完整流事件+审批+房间)。

**Architecture:** 独立 vite root(`src/mobile` → `out/mobile`),`remote-host-manager` 作静态服务;手机逻辑分层为 `lib/`(纯函数可单测)+ `hooks/`(WS/会话/房间状态)+ `components/`(shadcn 复用);协议类型从 `main/mobile-remote/types.ts` 直引(`import type`)。出站/入站通路已就位(`broadcastRaw` / `handleMobileClientEvent`),本计划主要补 UI 消费面与 `session.list`/`session.history` 协议。

**Tech Stack:** React 19 + Vite 6 + Tailwind v4 + shadcn/ui + ws(已有);TypeScript;bun test。

**约束(关键):**
- 子代理**绝不动 git**(commit 只由主 orchestrator 做)。改 core 必 `bun run build`(desktop worker 读 dist)——本计划基本不动 core。
- desktop 有自己的 `tsc --noEmit` 与 vite build;mobile 改完单独跑 mobile `tsc` + `build:mobile`。
- 所有命令在 worktree `/Users/admin/Documents/个人学习/代码学习/codeshell/.worktrees/mobile-ui-rebuild` 内的 `packages/desktop` 跑。
- 安全不变量沿用 spec §5,不放松。

---

## File Structure

新增(`packages/desktop/`):
- `vite.mobile.config.ts` — mobile 专用 vite 配置(root=src/mobile,out=out/mobile,别名 @ui/@rlib/@protocol)。
- `tsconfig.mobile.json` — mobile 子项目 tsc(browser lib,jsx)。
- `src/mobile/index.html`、`main.tsx`、`App.tsx`、`styles.css`。
- `src/mobile/lib/{deviceCredential,pairing,storage,riskClassify,streamReducer}.ts` + 各 `.test.ts`。
- `src/mobile/hooks/{useRemoteSocket,useSessions,useRooms,useApprovals}.ts`。
- `src/mobile/components/{ConnectionGate,ChatView,MessageStream,ApprovalCard,ToolCard,SubagentRow,SessionList,RoomList,RoomView,StatusBar}.tsx`。

修改:
- `packages/desktop/package.json` — 加 `build:mobile` script。
- `packages/desktop/scripts/build.ts` / `scripts/dev.ts` — 串入 mobile 构建 / dev 反代。
- `src/main/mobile-remote/remote-host-manager.ts` — `/mobile` 改静态服务。
- `src/main/mobile-remote/types.ts` — 加 `session.list`/`session.history`/`permission.setMode` 协议。
- `src/main/index.ts` — 实现新协议 handler。

删除(Phase 4):
- `src/main/mobile-remote/mobile-ui.ts`。

---

## Phase 0 — 脚手架(scaffold;先证明能跑)

### Task 0.1: mobile vite 配置 + tsconfig

**Files:**
- Create: `packages/desktop/vite.mobile.config.ts`
- Create: `packages/desktop/tsconfig.mobile.json`

- [ ] **Step 1: 写 vite.mobile.config.ts**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

/**
 * Mobile remote web app — a SECOND vite root, separate from the Electron
 * renderer (vite.config.ts). The phone loads this over HTTP/WS, NOT through
 * Electron preload, so it must be a self-contained browser bundle.
 *
 * It REUSES the renderer's shadcn components via the @ui alias (zero changes
 * to desktop) and shares the WS protocol types via @protocol (import type only,
 * never bundled).
 */
export default defineConfig({
  root: resolve(__dirname, "src/mobile"),
  base: "./",
  publicDir: false,
  server: { port: 5373, strictPort: true },
  build: {
    outDir: resolve(__dirname, "out/mobile"),
    emptyOutDir: true,
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@ui": resolve(__dirname, "src/renderer/components/ui"),
      "@rlib": resolve(__dirname, "src/renderer/lib"),
      "@protocol": resolve(__dirname, "src/main/mobile-remote/types.ts"),
      "@mobile": resolve(__dirname, "src/mobile"),
    },
  },
});
```

- [ ] **Step 2: 写 tsconfig.mobile.json**

复用 desktop tsconfig 的 compilerOptions,改 include 为 mobile + 别名 paths。先读现有 `packages/desktop/tsconfig.json` 取 compilerOptions,再写:

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": false,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": [],
    "baseUrl": ".",
    "paths": {
      "@ui/*": ["src/renderer/components/ui/*"],
      "@rlib/*": ["src/renderer/lib/*"],
      "@protocol": ["src/main/mobile-remote/types.ts"],
      "@mobile/*": ["src/mobile/*"]
    }
  },
  "include": ["src/mobile", "src/renderer/components/ui", "src/renderer/lib", "src/main/mobile-remote/types.ts"]
}
```

> 注:实际 compilerOptions 以读到的 `tsconfig.json` 为准;若 base tsconfig 已含 DOM lib/jsx 则不必重复。先 Read 再定稿。

- [ ] **Step 3: 校验配置语法**

Run: `cd packages/desktop && bunx tsc -p tsconfig.mobile.json --noEmit`
Expected: 报错是"找不到 src/mobile/*"(文件还没建),不是配置语法错。下一任务建文件后转绿。

### Task 0.2: mobile React 壳子(最小可加载)

**Files:**
- Create: `packages/desktop/src/mobile/index.html`
- Create: `packages/desktop/src/mobile/main.tsx`
- Create: `packages/desktop/src/mobile/App.tsx`
- Create: `packages/desktop/src/mobile/styles.css`

- [ ] **Step 1: index.html**

```html
<!doctype html>
<html lang="zh" class="dark">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#0a0c10" />
    <title>CodeShell Remote</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: styles.css**(Tailwind v4 入口,复刻 renderer 的 token 引入方式)

先读 `src/renderer` 下的 Tailwind 入口(grep `@import "tailwindcss"` 或 `index.css`)确认 token 定义位置,然后:

```css
@import "tailwindcss";
/* 复用 renderer 的 @theme inline token —— 若 renderer token 在独立文件,这里 @import 它;
   否则按 renderer 同样的 HSL 通道值 + @theme inline 复制 dark zinc token。
   以读到的 renderer 入口为准定稿。 */
```

- [ ] **Step 3: main.tsx**

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("app")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

- [ ] **Step 4: App.tsx**(占位,验证 shadcn 复用可编译)

```tsx
import { Button } from "@ui/button";

export function App() {
  return (
    <div className="min-h-dvh bg-background text-foreground grid place-items-center">
      <div className="flex flex-col items-center gap-3">
        <h1 className="text-lg font-semibold">CodeShell Remote</h1>
        <Button>脚手架就绪</Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: tsc 转绿**

Run: `cd packages/desktop && bunx tsc -p tsconfig.mobile.json --noEmit`
Expected: 0 errors(shadcn Button 经 @ui 别名解析通过)。

- [ ] **Step 6: build:mobile 通**

先在 package.json 加 script(见 Task 0.3),再:
Run: `cd packages/desktop && bun run build:mobile`
Expected: 产出 `out/mobile/index.html` + assets。

- [ ] **Step 7: Commit**(orchestrator 执行)

```bash
git add packages/desktop/vite.mobile.config.ts packages/desktop/tsconfig.mobile.json packages/desktop/src/mobile
git commit -m "feat(mobile-remote): React 手机应用脚手架(独立 vite root + shadcn 复用)"
```

### Task 0.3: build/dev 串入 + remote host 静态服务

**Files:**
- Modify: `packages/desktop/package.json`
- Modify: `packages/desktop/scripts/build.ts`
- Modify: `packages/desktop/scripts/dev.ts`
- Modify: `packages/desktop/src/main/mobile-remote/remote-host-manager.ts`

- [ ] **Step 1: package.json 加 script**

在 scripts 加:`"build:mobile": "vite build -c vite.mobile.config.ts"`,并让 `build` 串上它(读现有 `scripts/build.ts` 决定是在 build.ts 内调还是 package.json `build` 串)。

- [ ] **Step 2: build.ts 串 mobile**

读 `scripts/build.ts`,在它构建 renderer 之后加一段构建 mobile(同样 vite build,配 `-c vite.mobile.config.ts`),产物到 `out/mobile`。

- [ ] **Step 3: remote-host-manager 静态服务**

读 `remote-host-manager.ts:114-130`。把 `/mobile` 分支从 `res.end(mobileRemoteHtml())` 改为从 `out/mobile/` 读静态文件服务:
- `GET /mobile` 或 `/mobile/` → 服务 `out/mobile/index.html`。
- `GET /mobile/assets/*` 等 → 服务对应文件,**白名单 + 防目录遍历**(resolve 后必须仍在 out/mobile 内,否则 404)。
- content-type 按扩展名(.html/.js/.css/.svg/.woff2)。
- 找不到文件 → 404。
- passcode gate 仍在最前(不动)。

实现用 `node:fs`/`node:path`,产物路径相对 `app.getAppPath()` 或 `__dirname` 解析到打包后的 `out/mobile`(dev 走 dev server,见 Step 4)。先保留 `import { mobileRemoteHtml }` 不删(Phase 4 删),但 `/mobile` 不再调它。

- [ ] **Step 4: dev.ts 反代(dev HMR)**

读 `scripts/dev.ts`。dev 模式下起 mobile vite dev server(端口 5373),并让 remote host 的 `/mobile/*` 在 dev 反代到 `http://localhost:5373`(或 dev.ts 里直接告诉 remote host 用 dev base url)。prod 读静态。实现以读到的 dev.ts 结构为准,选最小侵入接法。

- [ ] **Step 5: 验证(手动冒烟,记录命令)**

Run: `cd packages/desktop && bun run build` 全量构建无错;`out/mobile/index.html` 存在。
真机/浏览器冒烟在 Phase 1 末统一做(此时还没接 WS)。

- [ ] **Step 6: Commit**(orchestrator)

```bash
git add -A
git commit -m "feat(mobile-remote): build/dev 串入 mobile + remote host 静态服务 /mobile"
```

---

## Phase 1 — 逻辑分层 + 流对齐(P0 核心)

> 每个 lib 是纯函数,先写失败测试再实现(TDD)。测试用 `bun test`,放 `src/mobile/lib/*.test.ts`。

### Task 1.1: lib/deviceCredential.ts(设备密钥/幂等)

**Files:**
- Create: `packages/desktop/src/mobile/lib/deviceCredential.ts`
- Test: `packages/desktop/src/mobile/lib/deviceCredential.test.ts`

参考现状 `mobile-ui.ts:521-537`(getSecret/getDeviceId/getDeviceName)。把"生成 32 字节 hex secret、派生 secretHash、读写 deviceId/secret"提成纯函数 + 注入 storage。

- [ ] **Step 1: 失败测试**

```ts
import { test, expect } from "bun:test";
import { generateSecret, secretHash } from "./deviceCredential";

test("generateSecret 产出 64 位 hex", () => {
  const s = generateSecret(() => new Uint8Array(32).fill(0xab));
  expect(s).toBe("ab".repeat(32));
  expect(s).toMatch(/^[0-9a-f]{64}$/);
});

test("secretHash 对同一 secret 稳定、对不同 secret 不同", async () => {
  const a = await secretHash("deadbeef");
  const b = await secretHash("deadbeef");
  const c = await secretHash("feedface");
  expect(a).toBe(b);
  expect(a).not.toBe(c);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/desktop && bun test src/mobile/lib/deviceCredential.test.ts`
Expected: FAIL(模块不存在)。

- [ ] **Step 3: 实现**

```ts
/** 设备凭证:随机 secret + SHA-256 hash。与 main 的 trusted-device-store 对齐
 *  (后者按 secretHash get-or-create,见 [[project_beta1_feedback_batch_fixes]])。 */
export function generateSecret(
  randomBytes: (n: number) => Uint8Array = (n) =>
    crypto.getRandomValues(new Uint8Array(n)),
): string {
  const b = randomBytes(32);
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

export async function secretHash(secret: string): Promise<string> {
  const data = new TextEncoder().encode(secret);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
```

> 校验:main 侧 `secretHash` 怎么算的?Read `trusted-device-store.ts` 确认两端 hash 算法一致(同为 SHA-256(secret) hex)。若 main 用别的(如直接存 secret 或加盐),这里必须对齐 main,否则 auth 失败。**实现前先 Read main 侧。**

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/desktop && bun test src/mobile/lib/deviceCredential.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**(orchestrator)

```bash
git add packages/desktop/src/mobile/lib/deviceCredential.ts packages/desktop/src/mobile/lib/deviceCredential.test.ts
git commit -m "feat(mobile-remote): lib/deviceCredential(设备密钥+hash,对齐 trusted-device-store)"
```

### Task 1.2: lib/storage.ts + lib/pairing.ts

**Files:**
- Create: `packages/desktop/src/mobile/lib/storage.ts`
- Create: `packages/desktop/src/mobile/lib/pairing.ts`
- Test: `packages/desktop/src/mobile/lib/pairing.test.ts`

- [ ] **Step 1: storage.ts**(localStorage 薄封装,key 沿用 `cs.*`)

```ts
const K = { deviceId: "cs.deviceId", deviceSecret: "cs.deviceSecret", deviceName: "cs.deviceName" } as const;
export const deviceStore = {
  getId: () => localStorage.getItem(K.deviceId) ?? "",
  setId: (v: string) => localStorage.setItem(K.deviceId, v),
  clearId: () => localStorage.removeItem(K.deviceId),
  getSecret: () => localStorage.getItem(K.deviceSecret) ?? "",
  setSecret: (v: string) => localStorage.setItem(K.deviceSecret, v),
  getName: () => localStorage.getItem(K.deviceName) ?? "",
  setName: (v: string) => localStorage.setItem(K.deviceName, v),
};
```

- [ ] **Step 2: pairing.test.ts(失败)**

```ts
import { test, expect } from "bun:test";
import { parsePairingToken } from "./pairing";

test("从 URL search 取出 pairing token", () => {
  expect(parsePairingToken("?pairing=abc123")).toBe("abc123");
  expect(parsePairingToken("?foo=1&pairing=xyz")).toBe("xyz");
  expect(parsePairingToken("?foo=1")).toBeNull();
  expect(parsePairingToken("")).toBeNull();
});
```

- [ ] **Step 3: 跑确认失败** → `bun test src/mobile/lib/pairing.test.ts` → FAIL。

- [ ] **Step 4: pairing.ts**

```ts
export function parsePairingToken(search: string): string | null {
  return new URLSearchParams(search).get("pairing");
}
```

- [ ] **Step 5: 跑确认通过** → PASS。

- [ ] **Step 6: Commit**(orchestrator)

```bash
git add packages/desktop/src/mobile/lib/storage.ts packages/desktop/src/mobile/lib/pairing.ts packages/desktop/src/mobile/lib/pairing.test.ts
git commit -m "feat(mobile-remote): lib/storage + lib/pairing"
```

### Task 1.3: lib/riskClassify.ts(审批摘要/分级)

**Files:**
- Create: `packages/desktop/src/mobile/lib/riskClassify.ts`
- Test: `packages/desktop/src/mobile/lib/riskClassify.test.ts`

把 `mobile-ui.ts:506-517` 内联的 `ks=['command','file_path',...]` 摘要提取 + risk 兜底规则化。

- [ ] **Step 1: 失败测试**

```ts
import { test, expect } from "bun:test";
import { summarizeApproval } from "./riskClassify";

test("按优先级从 args 提摘要", () => {
  expect(summarizeApproval({ command: "rm -rf x" }).summary).toBe("rm -rf x");
  expect(summarizeApproval({ file_path: "/a/b" }).summary).toBe("/a/b");
  expect(summarizeApproval({ url: "http://x" }).summary).toBe("http://x");
});

test("无已知字段 → JSON 兜底", () => {
  expect(summarizeApproval({ weird: 1 }).summary).toBe('{"weird":1}');
});

test("risk 兜底 medium,显式 high 保留", () => {
  expect(summarizeApproval({}, "high").risk).toBe("high");
  expect(summarizeApproval({}).risk).toBe("medium");
});
```

- [ ] **Step 2: 跑确认失败** → FAIL。

- [ ] **Step 3: 实现**

```ts
export type Risk = "low" | "medium" | "high";
const KEYS = ["command", "file_path", "path", "url", "pattern", "query"] as const;

export function summarizeApproval(
  args: Record<string, unknown> | undefined,
  risk?: string,
): { summary: string; risk: Risk } {
  let summary = "";
  for (const k of KEYS) {
    const v = args?.[k];
    if (typeof v === "string") { summary = v; break; }
  }
  if (!summary) summary = JSON.stringify(args ?? {});
  const r: Risk = risk === "low" || risk === "high" ? risk : "medium";
  return { summary, risk: r };
}
```

- [ ] **Step 4: 跑确认通过** → PASS。
- [ ] **Step 5: Commit**(orchestrator):`feat(mobile-remote): lib/riskClassify(审批摘要+分级规则化)`

### Task 1.4: lib/streamReducer.ts(JSON-RPC 流 → 视图状态)

**Files:**
- Create: `packages/desktop/src/mobile/lib/streamReducer.ts`
- Test: `packages/desktop/src/mobile/lib/streamReducer.test.ts`

这是对齐桌面端的核心。先 Read 桌面 renderer 的流消费(`src/renderer/messages/`、`MessageStream.tsx`、preload 的 `agent/streamEvent` 处理)确定**完整事件清单与字段**,再设计 reducer 状态。reducer 必须同时吃实时流与 `session.history` 回放(同构事件)。

状态形状(初稿,以读到的 renderer 类型为准修正):

```ts
export type ChatItem =
  | { kind: "user"; id: string; text: string; ts?: number }
  | { kind: "assistant"; id: string; text: string; reasoning?: string; done: boolean; ts?: number }
  | { kind: "tool"; id: string; name: string; args?: unknown; result?: string; error?: boolean; done: boolean }
  | { kind: "subagent"; id: string; agentId: string; label: string; status: string }
  | { kind: "turn_summary"; id: string; text: string }
  | { kind: "system_error"; id: string; text: string };

export interface ChatState {
  items: ChatItem[];
  run: "idle" | "running" | "waiting" | "completed" | "error";
  goal?: string;
  sessionId?: string;
}
```

事件覆盖(对齐 spec §2 缺口表):`text_delta`、`reasoning`/thinking delta、`assistant_message`、`tool_use_start`、`tool_use_end`/result、`tool_summary`、`turn_complete`(含 stopped reason)、`turn_summary`、`goal`、subagent `task_update`(按 agentId 隔离,见 [[project_subagent_card_stuck_working]]、[[project_subagent_task_update_isolation]] 提交 fbe6f68)、`error`、时间戳(createdAt/doneAt)。

- [ ] **Step 1: 失败测试**(喂录制的事件序列,断言状态)

```ts
import { test, expect } from "bun:test";
import { reduceStream, initialChatState } from "./streamReducer";

function feed(events: unknown[]) {
  return events.reduce((s, e) => reduceStream(s, e), initialChatState());
}

test("text_delta 合并到同一条 assistant", () => {
  const s = feed([
    { method: "agent/streamEvent", params: { event: { type: "text_delta", text: "你" } } },
    { method: "agent/streamEvent", params: { event: { type: "text_delta", text: "好" } } },
  ]);
  const last = s.items.at(-1);
  expect(last?.kind).toBe("assistant");
  expect((last as any).text).toBe("你好");
  expect(s.run).toBe("running");
});

test("tool start + end 配对到同一 item", () => {
  const s = feed([
    { method: "agent/streamEvent", params: { event: { type: "tool_use_start", toolCall: { id: "t1", toolName: "Read", args: { file_path: "x" } } } } },
    { method: "agent/streamEvent", params: { event: { type: "tool_use_end", toolCall: { id: "t1" }, result: "ok" } } },
  ]);
  const tool = s.items.find((i) => i.kind === "tool") as any;
  expect(tool.name).toBe("Read");
  expect(tool.done).toBe(true);
  expect(tool.result).toBe("ok");
});

test("turn_complete stopped → run idle 且不算 error", () => {
  const s = feed([
    { method: "agent/streamEvent", params: { event: { type: "turn_complete", reason: "stopped" } } },
  ]);
  expect(s.run).toBe("idle");
});

test("goal 事件更新 goal", () => {
  const s = feed([
    { method: "agent/streamEvent", params: { event: { type: "goal", goal: "重构 UI" } } },
  ]);
  expect(s.goal).toBe("重构 UI");
});
```

> 注:上述事件字段名(`tool_use_end`/`result`/`goal`)是**初稿**,实现前必须 Read renderer 真实字段对齐,测试随之修正。**字段以 core/renderer 真实流为准。**

- [ ] **Step 2: 跑确认失败** → FAIL。
- [ ] **Step 3: 实现 reduceStream**(纯函数,switch on event.type,不可变更新)。
- [ ] **Step 4: 跑确认通过** → PASS。
- [ ] **Step 5: Commit**(orchestrator):`feat(mobile-remote): lib/streamReducer(对齐桌面流事件,实时+回放同构)`

### Task 1.5: hooks/useRemoteSocket.ts(WS 连接/重连/握手)

**Files:**
- Create: `packages/desktop/src/mobile/hooks/useRemoteSocket.ts`

参考 `mobile-ui.ts:539-562`。封装:connect、auth 握手(有 deviceId → `auth.device`;有 pairing token → `pair.complete`)、重连退避、`send(event)`、onMessage 回调(吐 raw JSON 给上层喂 reducer)。引 `@protocol` 的 `MobileClientEvent`/`MobileServerEvent` 类型。

- [ ] **Step 1: 实现 hook**(无独立单测——副作用 hook;逻辑已在 lib 测过)。返回 `{ status, send, lastEvent, deviceName }`。
- [ ] **Step 2: tsc 转绿** → `bunx tsc -p tsconfig.mobile.json --noEmit` → 0 errors。
- [ ] **Step 3: Commit**(orchestrator):`feat(mobile-remote): hooks/useRemoteSocket(WS 握手+重连)`

### Task 1.6: components — ConnectionGate / ChatView / MessageStream / ApprovalCard / ToolCard

**Files:**
- Create: 上述 5 个 `.tsx` + 在 `App.tsx` 接成连接态机。

用 shadcn(`@ui/button`、`@ui/textarea`、`@ui/badge`、`@ui/card`、`@ui/scroll-area`)+ Tailwind dark token 复刻"precision dark console"气质(不照搬 hex)。MessageStream 渲染 streamReducer 的 `items`;ApprovalCard 用 riskClassify 的摘要+risk badge(high 红);ChatView 底部输入(Enter 发送、autosize)。

- [ ] **Step 1: 实现各组件 + App 接线**(App:未配对→ConnectionGate;已连→ChatView)。
- [ ] **Step 2: tsc 转绿** → 0 errors。
- [ ] **Step 3: build:mobile 通** → 产物存在。
- [ ] **Step 4: 真机/浏览器冒烟**(手动):桌面开遥控 → 扫码配对 → 发任务 → 看到实时流 + reasoning + tool 卡 + 收审批并批准。记录结果。
- [ ] **Step 5: Commit**(orchestrator):`feat(mobile-remote): React 聊天/审批 UI(shadcn 复用,流对齐)`

---

## Phase 2 — 会话对齐(P0):session.list + session.history

### Task 2.1: 协议扩展(types.ts)
加 `session.list`/`session.history`/`permission.setMode`(client)+ `session.list.ok`/`session.history.ok`/`permission.mode`(server)。**不动 core**,只改 desktop main 的 types。

### Task 2.2: main 实现 handler(index.ts)
- `session.list` → 复用 disk 权威会话源(Read `sessions-service`/`listDiskSessions`,经 existsSync(cwd) 过滤),broadcast `session.list.ok`(id/title/cwd/lastActiveAt)。
- `session.history` → 读磁盘 transcript,转成与 `agent/streamEvent` 同构事件,broadcast `session.history.ok`。
- `permission.setMode` → inject worker 消息(复用 core setPermissionMode 路径,对齐 renderer 怎么发的)。
- desktop 改完无 core 改动则无需 rebuild core;若 transcript 转换借了 core helper 则 `bun run build`。

### Task 2.3: hooks/useSessions + SessionList + 历史回放
手机进入桌面会话 → 拉 history → 喂同一 streamReducer 回放 → 接实时流。verify:手机能看到桌面正在跑的会话内容并接管操作。

---

## Phase 3 — 房间 UI 重做(P0)

### Task 3.1: hooks/useRooms
封装 `room.list`/`room.projects`/`room.create`/`room.open`/`room.close`/`room.send`/`room.history`(协议已全)。

### Task 3.2: RoomList / RoomView
房间列表(名/cwd/权限 badge:bypassPermissions 红)、新建(选 project)、进出、历史回放(复用 reducer)、实时流。沿用 2026-06-07 房间模型。verify:进房间与常驻 Claude Code 连续协作。

---

## Phase 4 — 能力补全(P1/P2) + 清理

### Task 4.1: 权限模式切换(P1)
StatusBar 显示当前 permissionMode,可切 default/acceptEdits/bypassPermissions(走 `permission.setMode`);bypass 需醒目确认(对齐 spec 安全)。

### Task 4.2: 子代理状态行(P1)
streamReducer 已产 subagent item;SubagentRow 只读渲染(按 agentId 隔离,见 fbe6f68)。

### Task 4.3: 模型切换 + 时间戳显示(P2)
模型切换协议 + UI;消息时间戳显示(reducer 已带 ts)。

### Task 4.4: 删 mobile-ui.ts
确认 `/mobile` 全走静态、无残留 import 后删 `mobile-ui.ts`,移除 remote-host-manager 的 import。
Run: `cd packages/desktop && bunx tsc --noEmit && bunx tsc -p tsconfig.mobile.json --noEmit`(两个都过)。

---

## Phase 5 — 打磨

### Task 5.1: 平板两栏布局
820px 断点:宽屏左 session/room 栏 + 右聊天(沿用现有意图)。

### Task 5.2: 真机冒烟 + 性能
完整真机走查(沿用 beta-smoke);流批量渲染(高频 text_delta 不卡)。

---

## Self-Review

- **Spec 覆盖**:spec §2 缺口表逐项落到 Phase 1(流事件)/Phase 2(会话列表+历史)/Phase 3(房间)/Phase 4(权限模式+子代理+模型)。§3 架构落 Phase 0。§4 协议落 Phase 2 Task 2.1/2.2。§5 安全:静态服务防遍历(0.3 Step 3)、鉴权不放松(2.2)。§6 测试:lib 单测(1.1–1.4)。✅
- **Placeholder**:Phase 0/1 为完整 bite-sized(含代码+命令+期望);Phase 2–5 为 task 级提纲——**有意为之**:它们依赖 Phase 0/1 读到的 renderer 真实字段与 dev.ts/build.ts 真实结构,在实施到那一步前细化,避免对未读结构臆造代码(违背 No-Placeholders 的精神是写假代码,而非分阶段细化)。执行 Phase 2 前须把 2.x 展开为 bite-sized。
- **类型一致**:`ChatState`/`ChatItem`(1.4)、`summarizeApproval`(1.3)、`MobileClientEvent`(@protocol)贯穿一致。
- **已知风险**:多处标注"实现前先 Read main/renderer 真实字段对齐"(secretHash 算法、streamReducer 事件字段、dev.ts/build.ts 结构)——这是对"零上下文 worker 别臆造"的显式护栏。
