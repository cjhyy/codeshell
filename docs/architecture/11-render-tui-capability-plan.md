# TUI Render 能力规划

> Generated on 2026-05-16 from the current repository tree.

This document focuses only on the terminal UI path: `src/render` and the TUI behavior it must support for CodeShell.

## Recommendation

`src/render` 不建议继续按“轻量 Ink 替代品”看待。它已经进入产品关键路径，应该定位为 **CodeShell 的产品级 TUI runtime**：

- 支撑长会话、流式输出、工具结果、审批、模型管理等高频终端交互。
- 负责 terminal-specific 的复杂问题：alt-screen、滚动、选择、复制、IME、键鼠输入、终端兼容、ANSI diff。
- 不负责 mac GUI、WebView、业务 dashboard 或跨端 UI 框架。

目标级别：

| Level | Meaning | Status |
|---|---|---|
| L1 Ink-compatible core | `Box` / `Text` / `render` / `useInput` / React reconciler / Yoga layout | 已具备 |
| L2 Product TUI runtime | alt-screen、ScrollBox、长列表虚拟滚动、选择复制、终端输入、性能优化 | 正在进入关键路径，需要稳定化 |
| L3 Terminal OS layer | API 契约、测试矩阵、devtools、性能预算、可访问性、组件原语治理 | 下一阶段重点 |

## Current Capabilities

The authoritative inventory of public exports lives in
[`src/render/README.md`](../../src/render/README.md). This document focuses on
the **roadmap and gaps** — not on listing every export.

For a snapshot of where the renderer currently lands on the L1/L2/L3 ladder, see
the Recommendation table above. For exact status (`supported` / `experimental`
/ `internal`) of any export, read the README.

## Required TUI Capabilities

| Capability | Required behavior | Target |
|---|---|---|
| Stable public API | 明确 supported / experimental / internal，UI 层只依赖 supported 或 explicit experimental | P0 |
| Fullscreen terminal shell | alt-screen 进出稳定，退出后恢复主屏，异常退出也清理 terminal mode | P0 |
| Long transcript rendering | 10k+ entries 不应线性拖慢常规输入、滚动、流式输出 | P0 |
| Scroll ergonomics | wheel、PgUp/PgDn、sticky bottom、jump-to-bottom、new message divider、resize 后位置稳定 | P0 |
| Input correctness | 普通键、ctrl/meta、kitty keyboard、modifyOtherKeys、bracketed paste、mouse drag/wheel/click 正确解析 | P0 |
| Selection and copy | 可选择 assistant/tool/user 文本，避开 `NoSelect` 区，tmux/SSH/local clipboard 路径可预期 | P1 |
| Render performance | streaming frame、spinner tick、resize、scroll、selection overlay 有固定预算和回归测试 | P1 |
| Component primitives | `Button`、`Link`、`RawAnsi`、`TextInput` 边界明确；通用 primitive 进 `render`，业务组件留在 `ui` | P1 |
| Accessibility | screen reader/native cursor 模式、颜色对比、复制路径、动态刷新节制有文档和手测清单 | P1 |
| Diagnostics | 能查看 layout tree、dirty nodes、frame timing、write/blit ratio、terminal capability detection | P2 |
| Terminal matrix | tmux、xterm.js、iTerm2、Ghostty、Windows Terminal、Apple Terminal 有支持等级和验收用例 | P2 |

## Current Gaps

| Priority | Gap | Evidence | Action |
|---|---|---|---|
| P0 | 文档和导出不同步 | [`src/render/index.ts`](../../src/render/index.ts) 导出 `ScrollBox`、`AlternateScreen`、`render`；[`src/render/README.md`](../../src/render/README.md) 仍把部分能力写成未支持或未使用 | 更新 README，建立 API status 表 |
| P0 | render 专项测试不足 | `tests/` 主要覆盖 session/model/run/tool，缺 screen/ANSI/input/scroll tests | 新增 `tests/render-screen.test.ts`、`tests/render-input.test.ts`、`tests/render-scroll.test.ts` |
| P0 | ScrollBox 已在 UI 关键路径，但验收不足 | `VirtualMessageList` 已使用 `ScrollBox` 和 `useVirtualScroll` | 做长 transcript、resize、wheel、PageUp/Down、sticky bottom 回归 |
| P0 | 终端兼容靠代码分支而不是产品矩阵 | `terminal.ts`、`termio/osc.ts` 有大量 terminal-specific 判断 | 写 `docs/architecture/render-terminal-matrix.md` 或纳入本文后续维护 |
| P1 | devtools 仍是 stub | [`src/render/devtools.ts`](../../src/render/devtools.ts) 目前 no-op | 做 CLI/debug overlay：frame timing + dirty tree + damage stats |
| P1 | Component boundary 模糊 | `Button`、`Link`、`RawAnsi` 存在但未从 public index 导出；输入框在 UI 层 | 定义 primitive ownership |
| P1 | 可访问性没有验收标准 | 代码已有 `CLAUDE_CODE_ACCESSIBILITY` 相关逻辑，但缺产品文档 | 写 accessibility checklist 并手测 |
| P2 | 更高级布局能力缺失 | 表格、overlay stack、portal、z-index、modal layering 没有完整语义 | 等产品场景明确后增量实现 |

## Test Plan

建议先补这些最小测试，不追求一次全覆盖：

| Test file | Focus |
|---|---|
| `tests/render-screen.test.ts` | `Box/Text` 基础布局、wide char、ANSI style、hyperlink、noSelect、soft-wrap |
| `tests/render-diff.test.ts` | frame diff、blit、damage、alt-screen height clamp、resize |
| `tests/render-input.test.ts` | keypress parser、paste、focus、mouse wheel、kitty/modifyOtherKeys fixtures |
| `tests/render-scroll.test.ts` | `ScrollBox` scrollTop/clamp/sticky/scrollToElement/subscribe |
| `tests/render-clipboard.test.ts` | OSC 52、tmux path、native fallback 的 sequence/branch 单测 |
| `tests/use-virtual-scroll.test.ts` | range calculation、height cache、resize scaling、sticky-bottom behavior |

## Performance Budgets

这些数字需要实测后落成 CI/bench 阈值；先作为目标口径：

| Scenario | Budget target |
|---|---|
| 10k transcript initial tail render | 只 mount viewport window + overscan，不 mount 全量 message |
| Streaming assistant text | 历史 rows 不重跑 markdown，不重绘整屏 |
| Spinner tick | 不触发 transcript 全树重排 |
| Wheel scroll | React update 和 Yoga layout 保持在可交互范围，避免 blank frame |
| Resize in tmux/xterm.js | viewport、height cache、scroll anchor 在 1-2 frame 内收敛 |

## Roadmap

1. P0 Contract：更新 `src/render/README.md`，定义 supported/experimental/internal；补最小 render tests。
2. P0 Scroll：把 `ScrollBox + useVirtualScroll` 的交互验收写入测试和手测清单。
3. P1 Perf：建立 render benchmark，记录 write/blit ratio、frame timing、dirty node count。
4. P1 Components：决定 `Button`、`Link`、`RawAnsi`、`TextInput` 是否进入 public renderer API。
5. P2 Devtools：实现 debug panel 或日志导出，让布局、diff、dirty、terminal capability 可视化。
6. P2 Matrix：维护 terminal compatibility matrix，并把高风险分支转成 fixture tests。

## Non-Goals

- 不在 `src/render` 内做 Electron、Tauri、SwiftUI 或 Web GUI。
- 不让 `src/render` 直接理解 RunManager、Arena、ModelManager 这些业务概念。
- 不急着发布成独立通用 TUI 框架；先服务 CodeShell 产品稳定性。

## Public component primitives (decision log)

### 2026-05-16 — Button / Link / RawAnsi promoted to supported

Reason: each has been stable in use by `src/ui/` and presents a thin,
purely-presentational API surface. No business binding.

### 2026-05-16 — TextInput stays in `src/ui/components/`

`TextInput` bundles:
- controlled value + cursor model,
- bracketed paste handling that interacts with the slash-command parser,
- history navigation (per-session, persisted),
- completion / autocomplete hooks.

Items 2–4 are CodeShell business logic, not generic renderer concerns.
Moving the whole component into `src/render/` would either drag this logic
into the generic layer (bad) or split into a partial primitive + a wrapper
(churn for little gain — there is no second consumer that would benefit).

Decision: `TextInput` remains a `src/ui/` component. If a future product
need calls for a primitive text input shared across two consumers, revisit
by extracting the controlled-value + cursor primitive into `src/render/`
and keeping the history / completion behavior in the wrapper.
