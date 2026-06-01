# 聊天标题 LLM 自动生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 第一轮问答结束后,用后台模型(auxModel)异步生成一句话标题,经 stream 事件回传 renderer,写入侧边栏 `SessionSummary.title`,替换掉现在的「首条消息前 60 字截断」。

**Architecture:** core engine 在 `run()` 收尾段(与 `runMemoryPipeline` 同款 fire-and-forget)判断是否第一轮;若是,复用已 resolve 的 `auxSummaryClient` 调一次轻量 LLM 生成短标题,通过新增的 `session_title` stream 事件发出。renderer 的 onStream 复用现有 `session_started` 的 bucket 解析模式,拿到后用 `renameSessionLocal` 写回 localStorage,触发侧边栏重渲染。全程 best-effort,失败静默回退。

**Tech Stack:** TypeScript, bun test(`import from "bun:test"`),monorepo(packages/core + packages/desktop,desktop 独立构建)。

**Git:** 直接在 main 上提交,不开 feature 分支(用户偏好)。

---

## File Structure

| 文件 | 职责 | 改动 |
|---|---|---|
| `packages/core/src/types.ts` | StreamEvent 类型 | 加 `session_title` 变体 |
| `packages/core/src/engine/engine.ts` | run() 收尾 + 标题生成方法 | 新增 `generateSessionTitle()`,在 1440 行附近 fire-and-forget 调用 |
| `packages/core/src/engine/engine.session-title.test.ts` | 标题生成单测 | 新建 |
| `packages/desktop/src/renderer/App.tsx` | onStream 处理 | 加 `session_title` case |

---

## Task 1: 新增 `session_title` StreamEvent 类型

**Files:**
- Modify: `packages/core/src/types.ts:245`(StreamEvent union,`session_started` 那一行后面插)

- [ ] **Step 1: 加类型变体**

在 `packages/core/src/types.ts` 中,`StreamEvent` union 里 `session_started` 行之后插入:

```ts
  | { type: "session_started"; sessionId: string; promptTokens: number }
  // Emitted once, fire-and-forget, after the FIRST turn of a session
  // completes: an LLM-generated one-line title for the sidebar. Best-effort
  // — absent on failure / when aux model unavailable.
  | { type: "session_title"; sessionId: string; title: string }
```

- [ ] **Step 2: typecheck**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bunx tsc --noEmit -p packages/core/tsconfig.json`
Expected: PASS(没有引用 session_title 的地方,纯加类型不会破坏现有代码)

- [ ] **Step 3: Commit**

```bash
cd "/Users/admin/Documents/个人学习/代码学习/codeshell"
git add packages/core/src/types.ts
git commit -m "feat(core): add session_title StreamEvent variant"
```

---

## Task 2: core 端 `generateSessionTitle` 方法 + 触发(TDD)

**Files:**
- Create: `packages/core/src/engine/engine.session-title.test.ts`
- Modify: `packages/core/src/engine/engine.ts`(新增 private 方法 `generateSessionTitle`;在 run() 1440 行附近调用)

`generateSessionTitle` 设计成**纯、可单测**的静态/独立函数,避免单测要构造整个 Engine。把"调 LLM + 判第一轮 + 发事件"的核心逻辑抽成一个不依赖 `this` 的导出函数 `buildSessionTitle`,Engine 方法只做接线。

- [ ] **Step 1: 写失败测试**

Create `packages/core/src/engine/engine.session-title.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { buildSessionTitle } from "./session-title.js";
import type { LLMClientBase } from "../llm/client-base.js";

function fakeClient(text: string, opts?: { throws?: boolean }): LLMClientBase {
  return {
    provider: "fake",
    model: "fake",
    createMessage: async () => {
      if (opts?.throws) throw new Error("boom");
      return {
        text,
        toolCalls: [],
        stopReason: "end_turn",
        usage: { promptTokens: 1, completionTokens: 1 },
      };
    },
    getUsage: () => ({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalTokens: 0,
    }),
  } as unknown as LLMClientBase;
}

describe("buildSessionTitle", () => {
  it("returns a trimmed one-line title from the LLM", async () => {
    const title = await buildSessionTitle(
      fakeClient("  修复登录超时问题  \n"),
      "帮我看看登录为什么会超时",
      "登录超时通常是因为...",
    );
    expect(title).toBe("修复登录超时问题");
  });

  it("strips surrounding quotes the model sometimes adds", async () => {
    const title = await buildSessionTitle(
      fakeClient('"配置热切换设计"'),
      "q",
      "a",
    );
    expect(title).toBe("配置热切换设计");
  });

  it("returns null when the LLM throws (best-effort)", async () => {
    const title = await buildSessionTitle(
      fakeClient("x", { throws: true }),
      "q",
      "a",
    );
    expect(title).toBeNull();
  });

  it("returns null when the model yields empty text", async () => {
    const title = await buildSessionTitle(fakeClient("   "), "q", "a");
    expect(title).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun test packages/core/src/engine/engine.session-title.test.ts`
Expected: FAIL —— `Cannot find module './session-title.js'`

- [ ] **Step 3: 实现 `buildSessionTitle`**

Create `packages/core/src/engine/session-title.ts`:

```ts
/**
 * Session title generation — best-effort, one-line LLM title for the sidebar.
 *
 * Pure function (no Engine `this`) so it's trivially unit-testable. The Engine
 * resolves the aux client and wiring; this only does the LLM call + cleanup.
 */
import type { LLMClientBase } from "../llm/client-base.js";

const SYSTEM_PROMPT =
  "You generate a very short title (≤6 words, no quotes, no trailing punctuation) " +
  "summarizing a chat, in the same language as the user's message.";

/** Strip wrapping quotes/whitespace the model sometimes adds. */
function clean(raw: string): string {
  return raw
    .trim()
    .replace(/^["'「『]+/, "")
    .replace(/["'」』]+$/, "")
    .trim();
}

/**
 * Ask the aux client for a one-line title from the first user message + first
 * assistant reply. Returns the cleaned title, or null on any failure / empty
 * output (caller treats null as "keep existing title").
 */
export async function buildSessionTitle(
  client: LLMClientBase,
  firstUserText: string,
  firstAssistantText: string,
): Promise<string | null> {
  try {
    const prompt =
      `User: ${firstUserText.slice(0, 2000)}\n\n` +
      `Assistant: ${firstAssistantText.slice(0, 2000)}\n\n` +
      `Title:`;
    const resp = await client.createMessage({
      systemPrompt: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }],
      tools: [],
      maxTokens: 64,
      // Auxiliary call — flip thinking off where supported (DeepSeek V4),
      // ignored elsewhere. Same rationale as the summarize path.
      thinking: "disabled",
    });
    const title = clean(resp.text ?? "");
    return title.length > 0 ? title : null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun test packages/core/src/engine/engine.session-title.test.ts`
Expected: PASS(4 tests)

- [ ] **Step 5: Commit**

```bash
cd "/Users/admin/Documents/个人学习/代码学习/codeshell"
git add packages/core/src/engine/session-title.ts packages/core/src/engine/engine.session-title.test.ts
git commit -m "feat(core): buildSessionTitle — best-effort one-line LLM title"
```

---

## Task 3: 在 engine.run() 收尾段接线触发

**Files:**
- Modify: `packages/core/src/engine/engine.ts`(import + 1440 行附近 fire-and-forget 调用)

run() 在 turnLoop 跑完后已有一行 `void this.runMemoryPipeline(...)`(约 1440 行)。在它旁边加标题生成,仅当这是第一轮(transcript 里 user 消息 == 1)且有 onStream 时触发。`result.text` 是助手回复;首条 user 文本从 messages 取。

- [ ] **Step 1: import**

`packages/core/src/engine/engine.ts` 顶部 import 区(与其他 `./` import 同处)加:

```ts
import { buildSessionTitle } from "./session-title.js";
```

- [ ] **Step 2: 在 runMemoryPipeline 调用旁加触发**

找到这一行(约 engine.ts:1440):

```ts
    void this.runMemoryPipeline(session.transcript, session.state.sessionId, cwd, llmClient);
```

在它**下面**插入:

```ts
    // Fire-and-forget session title generation — only after the FIRST turn.
    // Reuses the already-resolved auxSummaryClient (aux model, cheap). Best-
    // effort: failures never touch the run result. The renderer writes the
    // title into the sidebar on receipt of the session_title stream event.
    {
      const userMsgCount = session.transcript
        .getEvents("message")
        .filter((e) => (e.data as { role?: string }).role === "user").length;
      const onStream = options?.onStream;
      if (userMsgCount === 1 && onStream && result.text) {
        const firstUser = messages.find((m) => m.role === "user");
        const firstUserText =
          typeof firstUser?.content === "string"
            ? firstUser.content
            : JSON.stringify(firstUser?.content ?? "");
        void buildSessionTitle(auxSummaryClient, firstUserText, result.text).then(
          (title) => {
            if (title) {
              onStream({
                type: "session_title",
                sessionId: session.state.sessionId,
                title,
              });
            }
          },
        );
      }
    }
```

> 注:`auxSummaryClient`、`messages`、`result`、`session`、`options` 在该作用域内均已存在(`auxSummaryClient` 定义于约 1239 行,`result` 来自 `turnLoop.run(messages)`)。`getEvents` 接受可选 type 过滤;`getEvents("message")` 返回所有 message 事件,每个 `.data` 含 `role`。

- [ ] **Step 3: typecheck**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bunx tsc --noEmit -p packages/core/tsconfig.json`
Expected: PASS

- [ ] **Step 4: 跑全部 core 测试确认没回归**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun test packages/core/`
Expected: PASS(含 Task 2 新测试,无既有测试回归)

- [ ] **Step 5: Commit**

```bash
cd "/Users/admin/Documents/个人学习/代码学习/codeshell"
git add packages/core/src/engine/engine.ts
git commit -m "feat(core): trigger session title on first turn (fire-and-forget)"
```

---

## Task 4: renderer onStream 接收 `session_title` 并写回侧边栏

**Files:**
- Modify: `packages/desktop/src/renderer/App.tsx`(onStream 处理,`session_started` case 后)

复用 `session_started` 已有的 bucket 解析模式(用 `target` 拆 `repoKey::uiSessionId`),拿到 title 后调 `renameSessionLocal(repoId, uiSessionId, title)` 写回。`renameSessionLocal` 已在 `transcripts.ts:310` 导出。**不覆盖手动重命名**:仅当当前标题是自动值(占位符 `"新对话"` 或 60 字截断,即 ≠ 用户手改值)时写回。

- [ ] **Step 1: 确认 import**

确认 `App.tsx` 顶部已从 `./transcripts` import 了 `renameSessionLocal`;若没有则加入现有 transcripts import 列表。(`touchSession` 已被 import,通常同处。)

手动重命名守卫需要可靠信号:给 `SessionSummary` 加 `titleManual?: boolean` 标记,手动改名时置位,自动标题写回时检查并跳过。先做 Step 2a(加标记),再做 Step 2b(case 接收事件)。

- [ ] **Step 2a: 给 `renameSessionLocal` 加 `manual` 参数 + `titleManual` 字段**

1. `packages/desktop/src/renderer/transcripts.ts` 的 `SessionSummary` 接口(约 31-56 行)新增字段:
   ```ts
     /** True once the user manually renamed this session — blocks LLM auto-title overwrite. */
     titleManual?: boolean;
   ```
2. 同文件 `renameSessionLocal`(约 310 行)加第 4 个可选参数 `manual = false`,改为:
   ```ts
   export function renameSessionLocal(
     repoId: string | null,
     sessionId: string,
     title: string,
     manual = false,
   ): SessionIndex {
     const idx = loadSessionIndex(repoId);
     const next: SessionIndex = {
       ...idx,
       sessions: idx.sessions.map((s) =>
         s.id === sessionId
           ? {
               ...s,
               title: title.trim() || s.title,
               ...(manual ? { titleManual: true } : {}),
               updatedAt: Date.now(),
             }
           : s,
       ),
     };
     saveSessionIndex(repoId, next);
     return next;
   }
   ```
3. App.tsx 用户手动重命名入口 `handleRenameSession`(约 461 行)里那次 `renameSessionLocal(...)` 调用补传 `manual=true`(末尾加 `, true`)。

- [ ] **Step 2b: 加 session_title case(可靠守卫)**

在 `App.tsx` onStream 处理器里,现有 `if (event.type === "session_started") { ... }` 块**之后**插入:

```ts
      // session_title: LLM-generated sidebar title (first turn only).
      // Reuse the session_started bucket-parse pattern. Never clobber a
      // manual rename (titleManual flag set by handleRenameSession).
      if (event.type === "session_title") {
        const sep = target.indexOf("::");
        if (sep > 0) {
          const repoKey = target.slice(0, sep);
          const uiSessionId = target.slice(sep + 2);
          const repoId = repoKey === GLOBAL_KEY ? null : repoKey;
          if (uiSessionId && uiSessionId !== "_none_") {
            setSessionIndices((prev) => {
              const cur = prev[repoKey]?.sessions.find((s) => s.id === uiSessionId);
              if (!cur || cur.titleManual) return prev; // never clobber manual rename
              const next = renameSessionLocal(repoId, uiSessionId, event.title);
              return { ...prev, [repoKey]: next };
            });
          }
        }
      }
```

- [ ] **Step 3: desktop typecheck**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop" && bun run typecheck`
Expected: PASS
(若 desktop 无 `typecheck` script,用 `bunx tsc --noEmit -p packages/desktop/tsconfig.json`)

- [ ] **Step 4: Commit**

```bash
cd "/Users/admin/Documents/个人学习/代码学习/codeshell"
git add packages/desktop/src/renderer/App.tsx packages/desktop/src/renderer/transcripts.ts
git commit -m "feat(desktop): apply session_title to sidebar; guard manual renames"
```

---

## Task 5: rebuild core + 全量验证

**Files:** 无新增,验证步骤。

- [ ] **Step 1: rebuild core**(desktop dist 引用 core,需重建 — 见项目惯例)

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun run --filter '@cjhyy/code-shell-core' build`
Expected: 构建成功无错误

- [ ] **Step 2: 全量 core 测试**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bun test packages/core/`
Expected: 全 PASS

- [ ] **Step 3: 两侧 typecheck**

Run: `cd "/Users/admin/Documents/个人学习/代码学习/codeshell" && bunx tsc --noEmit -p packages/core/tsconfig.json && cd packages/desktop && bun run typecheck`
Expected: 均 PASS

- [ ] **Step 4: 提交计划文档自身(若未提交)**

```bash
cd "/Users/admin/Documents/个人学习/代码学习/codeshell"
git add docs/superpowers/plans/2026-06-01-llm-session-title.md
git commit -m "docs: 计划 — 聊天标题 LLM 自动生成"
```

---

## 手动验证(实现后人工确认)

1. 开新会话,发一条很长的 query;助手第一轮回复结束后,左侧侧边栏标题应在数秒内变成一句简短标题(≤6 词)。
2. 手动右键重命名某会话 → 再发一条消息 → 标题保持手改值,不被覆盖。
3. 关掉 auxModel 配置(或配一个无效 key)→ 标题生成静默失败,会话与回复完全正常,标题维持 60 字截断。

## Notes
- 不实现配置热切换(用户已搁置)。
- 不动 `~/.code-shell/desktop/session-titles.json`(SessionsView 另一套)。
- 全程直接在 main 提交,不开分支。
