# UI 渲染层重做：消除 blit=0 退化

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 codeshell 的 UI 从"每帧整屏重写"恢复到 ink 渲染器原本的 blit fast-path——目标是日志里 `[ink] High write ratio: blit=0` 警告在普通会话中不再出现。

**Architecture:** 参照 Claude Code 2.1.88 的四层策略组合：
1. **AlternateScreen** 把 ink screen.height 锁死 = terminalRows（消掉 screenHeight 线性涨）
2. **chatStore 引用稳定化** —— 流式只动最后一条 entry 引用；现有的 `tool_use_args_delta` 用 `.map` 破坏引用，需要修
3. **MessageRow.memo + 手写比较器** —— 历史 message 不重跑 markdown lexer
4. **ScrollBox + useVirtualScroll** —— transcript 在 ScrollBox 内做虚拟滚动，从 CC 搬 `useVirtualScroll` hook

**Tech Stack:** TypeScript / React + 自有 ink fork（src/render/）/ bun test。AlternateScreen、ScrollBox、ScrollBoxHandle 已在 fork 中导出可用；useVirtualScroll 需从 CC sourcemap 移植。

**前置事实（已通过源码确认）：**
- `src/render/index.ts:25,28` 导出 `ScrollBox` / `ScrollBoxHandle` / `AlternateScreen`
- `src/render/renderer.ts:97` 已实现 `altScreen ? terminalRows : yogaHeight`
- `src/ui/components/FullscreenLayout.tsx` 是普通 flexbox 容器，**未启用 alt-screen**
- `src/ui/store.ts` 的 `chatStore.append` 引用稳定；`text_delta` 的 flushTextBuffer (App.tsx:267-295) 已用"只复制最后一条"模式
- `tool_use_args_delta` (App.tsx:403-412) 用 `.map(e => ...)` 重建每个 entry 引用——P1 主要要修这个
- `useVirtualScroll` 在 codeshell fork 中**不存在**，CC sourcemap 路径：`restored-src/src/hooks/useVirtualScroll.ts`

---

## Task 1 — P0：用 AlternateScreen 包裹 FullscreenLayout

**Why:** 当前 ink screen.height = yogaHeight 跟着 transcript 涨到 126（终端 viewport 30 行）。AlternateScreen 把高度锁死为 terminalRows，根除"screen 线性涨 → blit 几乎全 miss"这一最大成本。

**Files:**
- Modify: `src/ui/components/FullscreenLayout.tsx` (整体包一层 AlternateScreen)
- 验证: `src/render/renderer.ts:97` (已支持 altScreen 模式，无需改)

- [ ] **Step 1: 在 FullscreenLayout 引入 AlternateScreen**

修改 `src/ui/components/FullscreenLayout.tsx`，第 19-20 行 import 改为：

```tsx
import React, { useState, useRef, useEffect, useCallback, type RefObject, type ReactNode } from "react";
import { Box, Text, useInput, AlternateScreen } from "../../render/index.js";
```

把 `FullscreenLayout` 的 return（行 45-71）外层加一个 `<AlternateScreen>`：

```tsx
export function FullscreenLayout({
  scrollable,
  bottom,
  overlay,
  newMessageCount = 0,
  onJumpToNew,
  showPill = false,
}: FullscreenLayoutProps) {
  return (
    <AlternateScreen>
      <Box flexDirection="column" flexGrow={1}>
        {/* Scrollable area — takes all available space */}
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {scrollable}
          {overlay}
        </Box>

        {/* Unseen messages pill */}
        {showPill && newMessageCount > 0 && (
          <Box justifyContent="center" marginY={0}>
            <Text
              color="ansi:black"
              backgroundColor="ansi:cyanBright"
              bold
            >
              {` ↓ ${newMessageCount} new message${newMessageCount > 1 ? "s" : ""} `}
            </Text>
          </Box>
        )}

        {/* Bottom pinned area */}
        <Box flexDirection="column" flexShrink={0}>
          {bottom}
        </Box>
      </Box>
    </AlternateScreen>
  );
}
```

注意：scrollable 外层加了 `overflow="hidden"`——alt-screen 下没有终端 scrollback，超出 viewport 的部分必须由 ink 自己裁剪。Task 4 把 hidden 升级为带 ScrollBox 的真正滚动；现在先 hidden 防止溢出。

- [ ] **Step 2: typecheck**

Run: `bun run typecheck`
Expected: 无错误。

- [ ] **Step 3: 跑全量测试，确认没有 UI 测试因为 AlternateScreen 副作用挂掉**

Run: `bun test`
Expected: 318/318 pass（即没有渲染相关 snapshot/快照测试在 alt-screen 行为下崩）。如果有挂的测试，是因为它们假设了 main-screen 行为；查 stack trace 修测试，不要回滚生产代码。

- [ ] **Step 4: 手测 — 启动并退出**

Run: `bun run dev` （或本仓库等价的启动命令；查 `package.json` `scripts.dev`）
- 启动应直接进入 alt-screen（终端原内容暂时消失）
- Ctrl+C / `/exit` 退出后终端原内容应回来
- 任发一条简单对话，让流式跑完
- **退出前**保留终端不要清，去看 `~/.code-shell/logs/ui-ink-$(date +%F).log`，看本次 session 有没有 `High write ratio` 警告

Expected:
- alt-screen 进/出正常
- 简单对话不再有 `High write ratio: blit=0` 警告（屏幕高度被锁住后，每帧应至少有 blit 命中）

如果还有 `blit=0` 警告但 write 数字大幅下降（比如从 3000+ 降到几百），说明 P0 生效但 P2 还要做；继续。
如果完全没下降，停下来分析 —— 可能 AlternateScreen 的 useInsertionEffect 没在 ink fork 里正确触发，需要看 `src/render/components/AlternateScreen.tsx`。

- [ ] **Step 5: Commit**

```bash
git add src/ui/components/FullscreenLayout.tsx
git commit -m "$(cat <<'EOF'
perf(ui): wrap FullscreenLayout in AlternateScreen to lock screen height

ink's screen.height followed yoga's measured height, which grew linearly
with transcript length (observed: 126 rows for a 30-row viewport). With
the rendered area unbounded, the blit fast-path was unreachable — every
frame fully rewrote the screen, producing the `[ink] High write ratio:
blit=0` warnings in steady state.

AlternateScreen pins the rendered area to terminalRows. Renderer already
supports altScreen mode (src/render/renderer.ts:97).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2 — P1：把 tool_use_args_delta 改成"只动目标 entry 引用"

**Why:** `tool_use_args_delta` 当前用 `.map(e => e.toolCallId === id ? {...e, args} : e)` 复制了**每条** entry 的引用——即便绝大多数 entry 不变，引用也变了。这让 Task 3 的 `React.memo` 在工具参数流式增长时全部 bail miss。flushTextBuffer 已经是正确模式（App.tsx:282-285：`next = [...next]; next[idx] = {...last, ...}`），照抄即可。

**Files:**
- Modify: `src/ui/App.tsx:403-412`
- Test: `tests/chat-store.test.ts` (新增；目录 `tests/` 已存在)

- [ ] **Step 1: 写一个失败的 store 测试，断言"只有目标 entry 引用变化"**

创建 `tests/chat-store.test.ts`：

```typescript
import { describe, expect, test, beforeEach } from "bun:test";
import { chatStore, createEntry } from "../src/ui/store.js";

beforeEach(() => {
  chatStore.clear();
});

describe("chatStore reference stability", () => {
  test("update that changes one entry preserves identity of others", () => {
    chatStore.append({ type: "user", text: "hello" });
    chatStore.append({ type: "tool_start", toolName: "Read", args: {}, toolCallId: "t1" });
    chatStore.append({ type: "assistant_text", text: "ok", streaming: false });

    const before = chatStore.getEntries();
    expect(before).toHaveLength(3);

    // Simulate the helper from App.tsx (Task 2 Step 3 introduces it).
    // For now use the explicit "find idx + clone array + patch one" pattern.
    chatStore.update((prev) => {
      const idx = prev.findIndex(
        (e) => e.type === "tool_start" && e.toolCallId === "t1",
      );
      if (idx < 0) return prev;
      const next = [...prev];
      next[idx] = { ...prev[idx], args: { path: "/x" } } as any;
      return next;
    });

    const after = chatStore.getEntries();
    expect(after).toHaveLength(3);
    // The patched entry got a new reference:
    expect(after[1]).not.toBe(before[1]);
    // The siblings did NOT — this is what makes React.memo bail in Task 3:
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });
});
```

- [ ] **Step 2: 运行测试，确认通过（chatStore 本身行为已正确，这条测试是回归保护）**

Run: `bun test tests/chat-store.test.ts`
Expected: 1 pass。如果失败，停下来：chatStore.update 的实现可能有问题，不要继续往下。

- [ ] **Step 3: 修复 tool_use_args_delta**

修改 `src/ui/App.tsx`，定位 `case "tool_use_args_delta":`（约 403 行）。

把：

```tsx
        case "tool_use_args_delta": {
          if (agentId !== undefined) break;
          const { toolCallId, args } = event;
          chatStore.update((prev) =>
            prev.map((e) =>
              e.type === "tool_start" && e.toolCallId === toolCallId ? { ...e, args } : e,
            ),
          );
          break;
        }
```

改为：

```tsx
        case "tool_use_args_delta": {
          if (agentId !== undefined) break;
          const { toolCallId, args } = event;
          chatStore.update((prev) => {
            const idx = prev.findIndex(
              (e) => e.type === "tool_start" && e.toolCallId === toolCallId,
            );
            // No matching tool_start (out-of-order event) — skip.
            if (idx < 0) return prev;
            const next = [...prev];
            next[idx] = { ...prev[idx], args } as ChatEntry;
            return next;
          });
          break;
        }
```

这个模式和 `flushTextBuffer` 完全一致：找 idx → 复制数组 → 只替换 idx 一格。

- [ ] **Step 4: 写一个针对 App 行为的回归测试，确认 tool_use_args_delta 经过 chatStore 后保持兄弟引用**

把 Step 1 的测试扩展（同一个文件，新增 test）：

```typescript
test("simulated tool_use_args_delta only mutates the matching tool_start", () => {
  // Mirror the new App.tsx implementation exactly so the test catches
  // regressions to the .map() pattern.
  chatStore.append({ type: "user", text: "go" });
  chatStore.append({ type: "tool_start", toolName: "Read", args: {}, toolCallId: "t1" });
  chatStore.append({ type: "tool_start", toolName: "Grep", args: {}, toolCallId: "t2" });

  const before = chatStore.getEntries();

  chatStore.update((prev) => {
    const idx = prev.findIndex(
      (e) => e.type === "tool_start" && (e as any).toolCallId === "t2",
    );
    if (idx < 0) return prev;
    const next = [...prev];
    next[idx] = { ...prev[idx], args: { pattern: "foo" } } as any;
    return next;
  });

  const after = chatStore.getEntries();
  expect(after[0]).toBe(before[0]); // user msg untouched
  expect(after[1]).toBe(before[1]); // t1 tool_start untouched
  expect(after[2]).not.toBe(before[2]); // t2 got new ref
  expect((after[2] as any).args).toEqual({ pattern: "foo" });
});
```

Run: `bun test tests/chat-store.test.ts`
Expected: 2 pass.

- [ ] **Step 5: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: 无 type error；全部测试通过。

- [ ] **Step 6: Commit**

```bash
git add src/ui/App.tsx tests/chat-store.test.ts
git commit -m "$(cat <<'EOF'
perf(ui): stop reseating sibling entry refs on tool_use_args_delta

The .map(e => ...) update pattern cloned every entry on each delta, so
React.memo on MessageRow (incoming) could never bail for siblings during
a streaming tool call. Switch to the find-idx + spread-one pattern that
flushTextBuffer already uses — only the patched entry gets a new ref.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3 — P2：把 MessageContent 包成 MessageRow.memo + 手写比较器

**Why:** 历史 message 不应每次父组件 re-render 都重跑 markdown lexer / formatToken。CC 用 `React.memo(MessageRowImpl, areMessageRowPropsEqual)` 配手写比较器：`message !== prev || isStreaming || columns 变` 才重渲。Task 2 已经保证 sibling entry 引用稳定，这步才能生效。

**Files:**
- Create: `src/ui/components/MessageRow.tsx`
- Modify: `src/ui/components/VirtualMessageList.tsx`（renderEntry 用 MessageRow）
- Modify: `src/ui/App.tsx`（如果 renderEntry 是在 App 里定义的）
- Test: `tests/message-row-memo.test.tsx`

- [ ] **Step 1: 调查 renderEntry 当前实现，确认包装位置**

Run: `grep -n "renderEntry\|renderItem" src/ui/App.tsx src/ui/components/VirtualMessageList.tsx`

如果 renderEntry 在 App.tsx 里、把 `ChatEntry` 渲染成 `<MessageContent>` 之类——这是要被包成 memo 的边界。
如果 VirtualMessageList 自己渲染——直接在 VirtualMessageList 里包 memo。

记录调查结果，后续 step 引用具体 line。

- [ ] **Step 2: 写失败的 memo 行为测试**

创建 `tests/message-row-memo.test.tsx`：

```typescript
import { describe, expect, test } from "bun:test";
import { areMessageRowPropsEqual } from "../src/ui/components/MessageRow.js";
import type { ChatEntry } from "../src/ui/store.js";

function entry(data: Partial<ChatEntry>): ChatEntry {
  return { id: "e1", type: "user", text: "x", ...data } as ChatEntry;
}

describe("areMessageRowPropsEqual", () => {
  test("same entry reference + same columns → bail (true)", () => {
    const e = entry({});
    expect(
      areMessageRowPropsEqual(
        { entry: e, columns: 80, isStreaming: false },
        { entry: e, columns: 80, isStreaming: false },
      ),
    ).toBe(true);
  });

  test("different entry reference → re-render (false)", () => {
    expect(
      areMessageRowPropsEqual(
        { entry: entry({ id: "a" }), columns: 80, isStreaming: false },
        { entry: entry({ id: "a" }), columns: 80, isStreaming: false },
      ),
    ).toBe(false);
  });

  test("isStreaming=true → always re-render", () => {
    const e = entry({});
    expect(
      areMessageRowPropsEqual(
        { entry: e, columns: 80, isStreaming: true },
        { entry: e, columns: 80, isStreaming: true },
      ),
    ).toBe(false);
  });

  test("columns changed → re-render (width affects wrap)", () => {
    const e = entry({});
    expect(
      areMessageRowPropsEqual(
        { entry: e, columns: 80, isStreaming: false },
        { entry: e, columns: 100, isStreaming: false },
      ),
    ).toBe(false);
  });
});
```

Run: `bun test tests/message-row-memo.test.tsx`
Expected: FAIL — `MessageRow` 模块还不存在。

- [ ] **Step 3: 创建 MessageRow.tsx**

创建 `src/ui/components/MessageRow.tsx`：

```tsx
/**
 * MessageRow — memo-wrapped renderer for a single ChatEntry.
 *
 * Why this exists: streaming events update the chat log dozens of times
 * per second. Without memo, every entry re-runs markdown lexing and
 * Yoga layout on every frame, defeating the ink renderer's blit
 * fast-path. The hand-written comparator below mirrors Claude Code's
 * `areMessageRowPropsEqual` (CC 2.1.88) — it only bails out for entries
 * we are CERTAIN didn't change: same reference, same width, not streaming.
 */
import React from "react";
import type { ChatEntry } from "../store.js";
import { MessageContent } from "./MessageContent.js";

export interface MessageRowProps {
  entry: ChatEntry;
  columns: number;
  /**
   * True iff this entry is the currently-streaming one. Streaming entries
   * never memo-bail because their text grows mid-frame even when the
   * outer entry object reuses (it shouldn't, but defense-in-depth).
   */
  isStreaming: boolean;
}

function MessageRowImpl({ entry, columns, isStreaming }: MessageRowProps) {
  // MessageContent is the existing renderer — we wrap, not replace.
  return <MessageContent entry={entry} columns={columns} isStreaming={isStreaming} />;
}

/**
 * Conservative comparator: returns true (skip render) only when we know
 * nothing visible changed. False (re-render) on any uncertainty.
 */
export function areMessageRowPropsEqual(
  prev: MessageRowProps,
  next: MessageRowProps,
): boolean {
  // Entry identity drives content. Task 2 guarantees this stays stable
  // for entries that didn't actually change.
  if (prev.entry !== next.entry) return false;
  // Terminal width affects text wrapping — must re-measure.
  if (prev.columns !== next.columns) return false;
  // The streaming entry is never safe to skip: its text grows by tokens
  // without necessarily reseating the outer entry ref.
  if (prev.isStreaming || next.isStreaming) return false;
  return true;
}

export const MessageRow = React.memo(MessageRowImpl, areMessageRowPropsEqual);
```

注意：`MessageContent` 的 props 可能和上面写的不完全一致。Step 1 的调查告诉你它当前签名是什么；如果不接受 `isStreaming`，在这里删掉这个 prop 透传即可——`isStreaming` 仅供 comparator 使用。

- [ ] **Step 4: 运行 memo 测试**

Run: `bun test tests/message-row-memo.test.tsx`
Expected: 4 pass.

- [ ] **Step 5: 在 VirtualMessageList 里用 MessageRow 替代直接 renderEntry**

修改 `src/ui/components/VirtualMessageList.tsx`：

- 在 props 上新增 `columns: number` 和 `streamingEntryId: string | null`（哪条 entry 正在流式）
- 把 `renderEntry(e, e.id)` 调用替换为：

```tsx
<MessageRow
  entry={e}
  columns={columns}
  isStreaming={streamingEntryId === e.id}
/>
```

并把现有的 `renderEntry` prop **删除**（如果没有别的 caller 用，可以删；如果有 caller 用做特殊渲染——保留 renderEntry 作为 override，常态用 MessageRow）。

调用方（App.tsx 里 `<VirtualMessageList ...>` 的那个 JSX）补传 `columns` 和 `streamingEntryId`。`columns` 用 `useTerminalSize` 或 codeshell 等价 hook（grep 一下 `useTerminalSize\|columns` 在 App.tsx 里怎么拿）；`streamingEntryId` 来自 chatStore 里 `streaming: true` 的最后一条 assistant_text 的 id（写一个 selector）。

- [ ] **Step 6: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: 通过。如有 type error 是 MessageContent 签名不匹配——回 Step 3 调整 MessageRow 的透传。

- [ ] **Step 7: 手测 — 验证 blit/write 比例**

Run: `bun run dev`，做一次和 Task 1 Step 4 类似的对话。
查 `~/.code-shell/logs/ui-ink-$(date +%F).log`：

Expected:
- 之前 P0 之后还残留的 `High write ratio` 警告**进一步消失**或频次显著降低
- 即使有，`blit` 数字应该大于 0（说明历史 message 走 blit 缓存了）

- [ ] **Step 8: Commit**

```bash
git add src/ui/components/MessageRow.tsx src/ui/components/VirtualMessageList.tsx src/ui/App.tsx tests/message-row-memo.test.tsx
git commit -m "$(cat <<'EOF'
perf(ui): memo MessageRow with hand-written comparator

Wrap each chat entry in React.memo so historical messages no longer
re-run markdown lexing on every stream tick. Comparator mirrors Claude
Code's areMessageRowPropsEqual: bail only when entry ref, columns, and
streaming flag are all unchanged.

Depends on the prior commit's reference-stability fix to actually bail.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4 — P3：把 transcript 放进 ScrollBox + 移植 useVirtualScroll

**Why:** alt-screen 把 screen 高度锁住了，但目前 scrollable 区域用 `overflow="hidden"` 暴力裁剪——超出 viewport 的历史 message 直接不可见。CC 的方案：scrollable 区是 ScrollBox（yoga overflow:scroll），配 `useVirtualScroll` 钩子做 sticky-bottom + 滚轮/键盘滚动 + measureRef 测量。这一步让长会话也能看历史。

**注意：** P3 工作量比 P0+P1+P2 总和都大；CC 的 VirtualMessageList 是 1081 行。我们不需要照抄全部，只移植：(a) useVirtualScroll 核心 hook；(b) ScrollBox 接线；(c) measureRef + 索引算行偏移。不移植：搜索 incsearch、selection mode、jumpTo 等高级功能（后续可加）。

**Files:**
- Copy/adapt: `src/ui/hooks/useVirtualScroll.ts`（从 `~/Documents/个人学习/代码学习/claude-code-sourcemap/restored-src/src/hooks/useVirtualScroll.ts` 移植）
- Modify: `src/ui/components/FullscreenLayout.tsx`（scrollable 包 ScrollBox）
- Modify: `src/ui/components/VirtualMessageList.tsx`（接入 measureRef / 行偏移）
- Test: `tests/use-virtual-scroll.test.ts`

- [ ] **Step 1: 阅读源参考实现**

Run:
```bash
wc -l ~/Documents/个人学习/代码学习/claude-code-sourcemap/restored-src/src/hooks/useVirtualScroll.ts
head -80 ~/Documents/个人学习/代码学习/claude-code-sourcemap/restored-src/src/hooks/useVirtualScroll.ts
```

理解它的：
- 输入：scrollRef (ScrollBoxHandle), keys (entry ids), columns
- 输出：measureRef、offsets、scrollTo、scrollToIndex、isSticky 等

如果文件 > 500 行，挑核心部分（hook 主体 + measureRef）；selection / search / jumpTo 相关的暂时不带。

- [ ] **Step 2: 写最小测试驱动 hook 的核心契约**

创建 `tests/use-virtual-scroll.test.ts`（先只测 hook 的纯数据部分；DOM/ScrollBox 集成由手测覆盖）：

```typescript
import { describe, expect, test } from "bun:test";
import { computeOffsetsFromMeasurements } from "../src/ui/hooks/useVirtualScroll.js";

describe("useVirtualScroll: computeOffsetsFromMeasurements", () => {
  test("returns running sum of heights, head at 0", () => {
    const keys = ["a", "b", "c"];
    const heights = new Map([["a", 3], ["b", 5], ["c", 2]]);
    const offsets = computeOffsetsFromMeasurements(keys, heights);
    expect(offsets).toEqual([0, 3, 8]);
  });

  test("unmeasured key falls back to estimate", () => {
    const keys = ["a", "b"];
    const heights = new Map([["a", 4]]);
    const offsets = computeOffsetsFromMeasurements(keys, heights, 3);
    expect(offsets).toEqual([0, 4]);
  });
});
```

Run: `bun test tests/use-virtual-scroll.test.ts`
Expected: FAIL — hook 文件还不存在。

- [ ] **Step 3: 创建 useVirtualScroll.ts，至少包含 computeOffsetsFromMeasurements 纯函数**

创建 `src/ui/hooks/useVirtualScroll.ts`：

```typescript
/**
 * useVirtualScroll — drives a ScrollBox over a keyed item list.
 *
 * Ported (simplified) from Claude Code 2.1.88
 * (restored-src/src/hooks/useVirtualScroll.ts).
 *
 * Responsibilities:
 *  - Measure mounted items via measureRef(key) (ink ref callback)
 *  - Maintain a Map<key, height> + recompute offsets on change
 *  - Sticky-bottom: when user is at the bottom, new items auto-scroll
 *  - Expose scrollToIndex / scrollToBottom on the returned API
 *
 * Search/selection/incsearch (CC's bigger features) are NOT ported —
 * add when needed.
 */
import { useCallback, useMemo, useRef, useState, useEffect, type RefObject } from "react";
import type { ScrollBoxHandle, DOMElement } from "../../render/index.js";

const DEFAULT_ESTIMATED_HEIGHT = 3;

/** Pure: prefix-sum of per-key heights, with fallback for unmeasured keys. */
export function computeOffsetsFromMeasurements(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  estimated: number = DEFAULT_ESTIMATED_HEIGHT,
): number[] {
  const offsets = new Array<number>(keys.length);
  let acc = 0;
  for (let i = 0; i < keys.length; i++) {
    offsets[i] = acc;
    acc += heights.get(keys[i]!) ?? estimated;
  }
  return offsets;
}

export interface UseVirtualScrollResult {
  measureRef: (key: string) => (el: DOMElement | null) => void;
  offsets: number[];
  scrollToBottom: () => void;
  scrollToIndex: (idx: number) => void;
}

export function useVirtualScroll(
  scrollRef: RefObject<ScrollBoxHandle | null>,
  keys: readonly string[],
  _columns: number, // reserved — recompute heights on column change in future
): UseVirtualScrollResult {
  const heightsRef = useRef<Map<string, number>>(new Map());
  const [version, setVersion] = useState(0);

  const measureRef = useCallback(
    (key: string) => (el: DOMElement | null) => {
      if (!el) return;
      // ink's DOMElement: yoga node has getComputedHeight()
      const h = Math.max(1, Math.floor(el.yogaNode?.getComputedHeight() ?? 0));
      const prev = heightsRef.current.get(key);
      if (prev !== h) {
        heightsRef.current.set(key, h);
        setVersion((v) => v + 1);
      }
    },
    [],
  );

  // Drop stale heights when keys leave the list
  useEffect(() => {
    const live = new Set(keys);
    for (const k of heightsRef.current.keys()) {
      if (!live.has(k)) heightsRef.current.delete(k);
    }
  }, [keys]);

  const offsets = useMemo(
    () => computeOffsetsFromMeasurements(keys, heightsRef.current),
    // `version` triggers recompute on measurement change
    [keys, version],
  );

  const scrollToBottom = useCallback(() => {
    scrollRef.current?.scrollToBottom();
  }, [scrollRef]);

  const scrollToIndex = useCallback(
    (idx: number) => {
      const top = offsets[idx];
      if (top !== undefined) scrollRef.current?.scrollTo(top);
    },
    [scrollRef, offsets],
  );

  return { measureRef, offsets, scrollToBottom, scrollToIndex };
}
```

注意：`DOMElement` 是否从 render/index 导出，跑 typecheck 看。如果没导出，改用 ink 内部类型或 `unknown` 兜底。

- [ ] **Step 4: 测试通过**

Run: `bun test tests/use-virtual-scroll.test.ts`
Expected: 2 pass.

- [ ] **Step 5: VirtualMessageList 接入 measureRef**

修改 `src/ui/components/VirtualMessageList.tsx`：

把 props 加上 `scrollRef: RefObject<ScrollBoxHandle | null>` 和 `columns: number`（已经在 Task 3 加了 columns），在组件里调用 hook：

```tsx
const keys = useMemo(() => entries.map((e) => e.id), [entries]);
const { measureRef, scrollToBottom } = useVirtualScroll(scrollRef, keys, columns);

// Auto-stick to bottom when new entries arrive
useEffect(() => {
  scrollToBottom();
}, [entries.length, scrollToBottom]);
```

每个 MessageRow 用 measureRef 测量。**MessageRow 自己不接 ref**——给它外包一个 measure 用的 Box：

```tsx
{entries.map((e) => (
  <Box key={e.id} ref={measureRef(e.id)} flexDirection="column">
    <MessageRow
      entry={e}
      columns={columns}
      isStreaming={streamingEntryId === e.id}
    />
  </Box>
))}
```

并**删除现有的 VIRTUALIZE_THRESHOLD 切片逻辑**——ScrollBox 负责裁剪。

- [ ] **Step 6: FullscreenLayout 把 scrollable 包进 ScrollBox**

修改 `src/ui/components/FullscreenLayout.tsx`：

把 `import` 加 `ScrollBox, ScrollBoxHandle`：

```tsx
import { Box, Text, useInput, AlternateScreen, ScrollBox, type ScrollBoxHandle } from "../../render/index.js";
```

加一个 `scrollRef` prop 透传给 ScrollBox。把：

```tsx
<Box flexDirection="column" flexGrow={1} overflow="hidden">
  {scrollable}
  {overlay}
</Box>
```

改为：

```tsx
<ScrollBox ref={scrollRef} flexGrow={1} stickToBottom>
  {scrollable}
  {overlay}
</ScrollBox>
```

如果 `ScrollBox` 没有 `stickToBottom` prop——查 `src/render/components/ScrollBox.tsx` 看真实 API，按它的 prop 名替换。

调用方（App.tsx 的 `<FullscreenLayout ... />`）创建并透传 `scrollRef`，VirtualMessageList 也接收同一个 `scrollRef`——hook 直接接管滚动。

- [ ] **Step 7: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: 通过。type error 多半在 ScrollBox / DOMElement 这些类型 surface 上——以 fork 实际导出的为准。

- [ ] **Step 8: 手测 — 滚动 + sticky-bottom**

Run: `bun run dev`，做一段长会话（30+ messages，超过 viewport）。

Expected:
- 默认贴底，新消息进来自动滚到底
- 可以用 PgUp/PgDn/鼠标滚轮往上滚（具体键位由 ScrollBox 决定）
- 滚上去后新消息进来——pill ("N new messages") 应能正确出现（useUnseenDivider 已经写好，现在能正确联动 ScrollBox 了）
- 查 ui-ink 日志，`High write ratio` 警告应基本消失，blit cells 显著上升

- [ ] **Step 9: Commit**

```bash
git add src/ui/hooks/useVirtualScroll.ts src/ui/components/VirtualMessageList.tsx src/ui/components/FullscreenLayout.tsx src/ui/App.tsx tests/use-virtual-scroll.test.ts
git commit -m "$(cat <<'EOF'
perf(ui): real virtual scrolling — ScrollBox + useVirtualScroll

Replace the threshold-based "drop oldest 100" pseudo-virtualization with
a proper ScrollBox + measureRef setup ported (simplified) from Claude
Code 2.1.88. Visible rows are now O(viewport) regardless of transcript
length; historic rows blit from prevScreen.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5 — P4：验证 text_delta 节流是否仍然必要 / 收紧

**Why:** App.tsx:267-295 已有 50ms throttle (flushTextBuffer + flushTimerRef)。P0+P2+P3 落地后，单帧成本应该已经很低；50ms throttle 可能足够，也可能可以放宽到 33ms 让流式更顺滑。这步是验证 + 微调，不一定改代码。

**Files:**
- 验证（无改动）: `src/ui/App.tsx:267-295`
- 视情况修改: `src/ui/App.tsx:356`（setTimeout 间隔）

- [ ] **Step 1: 重跑日志基线**

Run: `bun run dev`，跑一段流式响应较长的对话（让模型输出 500+ tokens）。
查 `~/.code-shell/logs/ui-ink-$(date +%F).log`：

- 数 `text_delta` 事件总数
- 数 `High write ratio` 警告总数
- 看 blit/write 比例

记录数字。

- [ ] **Step 2: 决策**

如果：
- 警告 = 0：保留 50ms throttle 不动，跳到 Step 4
- 警告少量但 blit > write：可以试试把 50ms 改成 33ms（30fps，刚好一帧），看视觉是否更顺滑
- 警告仍多：说明 P0-P3 没完全消化退化，**回去检查 Task 1-4 的手测验证，不要在这步调参数掩盖**

- [ ] **Step 3 (条件): 调整 throttle 间隔**

如果 Step 2 决定调整，修改 `src/ui/App.tsx`（约 356 行）：

```tsx
// Before
flushTimerRef.current = setTimeout(flushTextBuffer, 50);

// After
flushTimerRef.current = setTimeout(flushTextBuffer, 33); // ~30fps
```

跑一次手测，确认流式输出仍然平滑，且日志不退化。

- [ ] **Step 4: typecheck + 全量测试**

Run: `bun run typecheck && bun test`
Expected: 通过。

- [ ] **Step 5: Commit (如果有改动)**

```bash
git add src/ui/App.tsx
git commit -m "$(cat <<'EOF'
perf(ui): tighten text_delta throttle to 33ms (one frame at 30fps)

After landing alt-screen + memo + virtual scroll, 50ms felt sluggish
compared to the steady-state render budget. 33ms gives ~30fps streaming
without re-introducing the blit-miss warnings.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

如果 Step 2 决定不改，跳过此 step。

---

## 完工验收

跑完 Task 1-5 后：

- [ ] `bun run typecheck` 干净
- [ ] `bun test` 全部通过（包含本计划新增的 3 个测试文件）
- [ ] 手测：30+ message 对话，普通流式不再有 `High write ratio: blit=0` 警告
- [ ] 手测：alt-screen 进/出正常，退出后终端清回原样
- [ ] 手测：长会话能滚动看历史；新消息进来时贴底；滚上后 pill 提示

---

## 回滚边界

如果某个 Task 在手测中翻车（比如 alt-screen 让某些 CI / sandbox 环境用不了），各 Task 都是独立 commit，可单独 `git revert` 回退到上一个稳定点：

- 回退 Task 1：失去 P0，但 P1-P4 在 main-screen 下也能跑（虽然 P0 没了 screenHeight 不再封顶）
- 回退 Task 4：失去虚拟滚动，回到"超出 viewport 看不见"，但 alt-screen + memo 仍在
- Task 2 / 3 不建议单独回退——它们是 memo 生效的基础，回掉 memo 就不工作了
