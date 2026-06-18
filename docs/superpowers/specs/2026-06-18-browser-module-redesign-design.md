# Browser 模块重设计 — 设计稿

**日期**: 2026-06-18
**状态**: 待评审
**关联**: `docs/superpowers/specs/2026-06-17-browser-host-and-login-window-design.md`（前序：浏览器宿主 + 登录窗口）

## 1. 背景与动机

当前 browser 自动化能力可用，但有三个问题：

1. **工具暴露太多**：9 个平铺的 `browser_*` 工具（snapshot/navigate/click/type/scroll/read_content/extract_links/wait/press_enter）全部进 LLM 工具列表，挤占 system prompt 预算，且和其他工具混杂。
2. **动作覆盖窄**：缺 `select_option`（原生下拉）、通用 `press_key`、`hover`、`screenshot/vision`，遇到这些场景整类网站做不了。业界范本 browser-use 在 WebVoyager 上 89.1%，差距主要在动作宽度和 vision 兜底。
3. **CDP 动作层未独立**：动作实现散在 `packages/desktop/src/main/browser-driver/` 里，绑死 Electron。违背 "core 最小 harness、业务可整块拎出" 的架构铁律，也无法被无人值守/外部引擎复用。

此外，多 tab 能力：AI 当前**看不到也切不了** tab，只能驱动用户当前选中的 tab。

## 2. 目标

1. **工具收敛**：9 个 → 3 个语义工具（`browser_observe` / `browser_act` / `browser_navigate`）。
2. **动作补齐**：照 browser-use 的 CDP 序列补 `select_option` / `press_key`（取代 `press_enter`）/ `hover`；`screenshot/vision` 留接口、本轮不实现（单独一轮）。
3. **抽独立包**：CDP 动作层抽成 `@cjhyy/code-shell-cdp`，注入式 `CdpSender`、环境无关、任何 runtime 可用。
4. **全档多 tab**：`browser_*` 动作支持可选 `tabId`，AI 可 `list_tabs` / `switch_tab` / 直接对任意 tab 操作。

### 非目标（本轮不做，明确记录）

- **vision/screenshot 实现**：留接口（`browser_observe` 预留 `mode: "vision"`），实现单独一轮（要碰 renderer 画框）。
- **drag / 容器内滚动 / 右键双击**：低频，留待后续。
- **结构化 schema 抽取**（Stagehand `extract()` 风格）：`browser_observe` 的 read/extract 先保持现有纯文本/链接形态。

## 3. 现状边界（来自代码测绘）

### 3.1 core 侧（22 处 `browser_*` 字符串硬编码，爆炸半径）

- `packages/core/src/tool-system/browser-bridge.ts` — `BrowserBridge` 接口 + 纯函数（`flattenAxTree` / `cleanPageText` / `buildExtractLinksScript` / `renderElementList`）+ 类型（`BrowserSnapshot` / `BrowserResult` / `BrowserElement` / `BrowserContent` / `BrowserExtract` / `AXNode`）+ 常量（`INTERACTIVE_ROLES` / `VALUE_ROLES` / `CONTENT_CHAR_CAP` / `EXTRACT_LINK_CAP`）
- `packages/core/src/tool-system/builtin/browser-tools.ts` — 9 个工具 def + handler
- `packages/core/src/tool-system/builtin/index.ts` — 注册 + 元数据（permissionDefault/isReadOnly/isConcurrencySafe/timeoutMs）
- `packages/core/src/tool-system/context.ts` — `ToolContext.browser: BrowserBridge` 注入点
- `packages/core/src/context/compaction.ts:457,479` — `maskOldBrowserSnapshots()` 按字符串 `"browser_snapshot"` 认快照 ⚠️ **改名必同步，否则静默失效**
- `packages/core/src/context/mask-browser-snapshots.test.ts` — 对应测试
- `packages/core/src/preset/index.ts` — 工具名白名单（9 处）+ 权限规则（6 处）
- `packages/core/src/engine/engine.ts` — `setBrowserBridge()` + `buildToolContext()`
- `packages/core/src/protocol/server.ts` — `makeBrowserBridge()` RPC 适配器

### 3.2 desktop 侧（零工具名硬编码——协议层用 `__browser_action__` 抽象）

- `packages/desktop/src/main/browser-driver/cdp-driver.ts` — `CdpBrowserDriver implements BrowserBridge`，注入 `CdpSender` + `pageInfo`
- `electron-cdp.ts` — `webContents.debugger` → `CdpSender` 适配
- `automation-host.ts` — `driverForGuest(webContents)`：**按 webContents.id 缓存 driver**（`drivers: Map<number, CdpBrowserDriver>`），debugger 首用即 attach，guest destroyed 自动释放
- `active-guest.ts` — 追踪活跃 guest（新建即活跃 / focus 即活跃 / 关闭重选 `mostRecentLiveGuest()`）；导出 `activeGuest()`
- `intercept.ts` — `parseBrowserActionLine()` 协议解析
- `agent-bridge.ts:145` — readline 拦截 `__browser_action__`

### 3.3 多 tab 现状（关键：底层 90% 现成）

- 每 tab = 独立 webContents（`BrowserPanel.tsx` `key={activeId}` 强制每 tab 一个 guest 进程 + 独立历史 + 独立 refMap）
- `driverForGuest()` 本就按 webContents.id 取 driver——**driver 非单例，天然每 tab 一个**
- `active-guest.ts` 已追踪活跃 guest
- **唯一缺口**：AI 不知道有多个 tab，无法主动切（只有用户点 tab / Electron focus 事件能改 active）

## 4. 设计

### 4.1 三个语义工具

```
browser_observe  — 观察。snapshot（a11y 元素列表）/ read（正文）/ extract（链接图片）三合一，mode 参数分发
browser_act      — 交互。click / type / select / press_key / hover / scroll / wait / list_tabs / switch_tab，action 参数分发
browser_navigate — 导航。url（高频、语义独立，单列）
```

**为何 navigate 单列**：导航是高频且语义最独立的动作，单列让 LLM 最常用的两步（navigate → observe）路径清晰；也和 Stagehand 把 navigate 留在 Playwright 层同构。

#### `browser_observe`

```jsonc
{
  "mode": "snapshot" | "read" | "extract",   // 默认 snapshot
  "tabId": "string (可选，默认活跃 tab)"
}
```

- `snapshot` → 现 `browser_snapshot`（a11y 元素列表 + refs）。**vision 留位**：未来加 `mode: "vision"`，本轮 schema 不暴露。
- `read` → 现 `browser_read_content`
- `extract` → 现 `browser_extract_links`

权限：`allow`（只读）。

#### `browser_act`

```jsonc
{
  "action": "click" | "type" | "select" | "press_key" | "hover" | "scroll" | "wait" | "list_tabs" | "switch_tab",
  "ref": "string (click/type/select/hover/press_key 用)",
  "text": "string (type 用)",
  "value": "string (select 用)",
  "key": "string (press_key 用，如 Enter/Tab/Escape/ArrowDown/Control+a)",
  "direction": "up" | "down" (scroll 用),
  "amount": "number (scroll 用)",
  "timeout_ms": "number (wait 用)",
  "tabId": "string (switch_tab 用；其余动作可选，默认活跃 tab)"
}
```

权限分档（沿用现有规矩，按 action 在 handler 内分流）：
- `click` / `type` / `select` → 等价现有 `ask`（改了页面/表单状态，需批准）
- `press_key` → **见 4.5 取舍**
- `hover` / `scroll` / `wait` / `list_tabs` / `switch_tab` → `allow`

> 注意：现有权限系统按**工具名**做 permissionDefault。收敛成单个 `browser_act` 后，"click 要批准、scroll 不用" 无法靠工具级 permissionDefault 表达。**解决方案见 4.6**。

#### `browser_navigate`

```jsonc
{ "url": "string", "tabId": "string (可选)" }
```

权限：`allow`。

### 4.2 独立包 `@cjhyy/code-shell-cdp`

> 包名遵循 workspace 惯例 `@cjhyy/code-shell-*`（现有 `-core` / `-desktop` / `-tui`）。

```
packages/cdp/                                 （新 workspace 包，零运行时依赖）
  src/
    sender.ts        — export type CdpSender = (method, params?, sessionId?) => Promise<any>
                       （sessionId 可选维度：webview 线永不传；将来独立浏览器线 Target 域用）
    driver.ts        — CdpActionsDriver：当前 cdp-driver.ts 的动作实现，去掉对 core 的依赖
    keymap.ts        — key 名 → {code, windowsVirtualKeyCode, key, text?} + 修饰键位掩码
                       （翻译自 browser-use actor/utils.py）
    actions/         — click / type / select / pressKey / hover / scroll （纯 CDP 序列）
    types.ts         — 包自有的 BrowserResult / PageInfo（不依赖 core）
  package.json, tsconfig.json
```

**边界划分（什么进包、什么留 core）**：

| 留在 core | 进 `@cjhyy/code-shell-cdp` |
|---|---|
| `BrowserBridge` 接口（harness 契约） | `CdpActionsDriver`（动作执行） |
| a11y 感知纯函数（`flattenAxTree` 等） | `CdpSender` 接口 + keymap + actions |
| 工具定义 + 注册 + 权限 | 包自有 `BrowserResult` / `PageInfo` 类型 |
| `maskOldObservations`（compaction） | （不含工具定义、不含 agent loop、不含感知语义） |

**依赖方向（单向，无环）**：

```
desktop ──→ @cjhyy/code-shell-cdp   （动作执行 + 原始 CDP 取数）
desktop ──→ @cjhyy/code-shell-core  （感知纯函数 flattenAxTree + BrowserBridge 类型）
@cjhyy/code-shell-cdp  ──→ （无 workspace 依赖，零运行时依赖）
```

**包不依赖 core，core 不依赖包。** desktop 是唯一同时引用两者的胶水层。

**职责划分**：
- **包**负责：所有**动作**（click/type/select/press_key/hover/scroll）的 CDP 命令序列 + `snapshot()` 里"发 `Accessibility.getFullAXTree` 拿**原始** AX 树"这一步。包返回原始节点数组，不做语义展平。
- **desktop 胶水（`cdp-driver.ts`）** 负责：拿包返回的原始 AX 树 → 调 core 的 `flattenAxTree` 展平成 `BrowserElement[]` → 组装成 `BrowserSnapshot`。

这样 `flattenAxTree`（依赖 core 类型/常量）留在 core，包保持零依赖，互不反向引用。

### 4.3 从 browser-use 移植的 CDP 序列

| 动作 | browser-use 做法 | 本设计 |
|---|---|---|
| **select** | 点 option 子节点（依赖能拿到 option backendId） | **JS 设值 + 按需查 option**，见下方专节。 |
| **press_key** | 完整 key map + 修饰键位掩码（Alt=1/Ctrl=2/Meta=4/Shift=8）+ 组合键序列 | 翻译 `actor/utils.py` key map 进 `keymap.ts`；`pressKey(key, ref?)` 取代 `pressEnter`，Enter 只是其中一个 key。组合键如 `Control+a`：拆分→修饰键 keyDown→主键 keyDown→主键 keyUp→修饰键 keyUp。 |
| **hover** | scrollIntoView → 算 quad 中心 → `Input.dispatchMouseEvent type=mouseMoved` | 同。复用现有 `centerOf(ref)`，只发 mouseMoved（不 press）。 |
| **click（加固）** | scrollIntoView → quad 中心 → mouseMoved+Pressed+Released → 失败回退 JS `.click()` → 遮挡检测 | 现有已有三连+coords。**本轮加**：JS `.click()` 回退（geometry 失败时）。遮挡检测留待后续（非必须）。 |
| **type（保持）** | 逐字符 keyDown→char→keyUp | 现有用 `Input.insertText`，够用，**不改**。 |
| **scroll（保持）** | `Input.synthesizeScrollGesture` | 现有用 mouseWheel，够用，本轮**不改**（升级留后）。 |

#### select 专节：两种下拉，两条路

下拉框在网页里其实是**两种不同的东西**，`select_option` 动作**只为原生 `<select>` 而生**：

| | 原生 `<select>` | "假下拉"（`<div>`/`<li>` 仿的，如 Ant/shadcn/Material） |
|---|---|---|
| 本质 | 真 HTML 元素，浏览器画 option 菜单（OS 原生 UI） | 一堆 div，自己画样式 |
| option 在快照里？ | **否**——未展开时浏览器不渲染进 DOM/AX 树，CDP 拿不到稳定 backendId/盒子 | 展开后是真 `<div role="option">`，**自动出现在下次 `browser_observe(snapshot)`** |
| 选中方式 | `select_option`（本动作） | **不归本动作**：AI 走 `click` 展开 → `observe` → `click` 选项 |

所以 `select_option` 专门处理**原生 `<select>`**，假下拉用现成的 click 流程，无需本动作。

**`select_option(ref, value)` 内部逻辑（按需查 option）**：

1. **先 JS 设值选中**：`Runtime.callFunctionOn` 在 `<select>` 节点（ref→backendId，已有）上，遍历其 `options`，按 **value 精确匹配 → 失败再按可见文本匹配**，命中则设 `selectedIndex` 并 dispatch `input`+`change`（让页面 JS 框架感知）。
2. **选不中才查 option**：若无匹配，**一次性** `Runtime.callFunctionOn` 取该 `<select>` 的全部 option `{value, text}` 列表，作为错误详情返回给 AI（"未找到匹配项；可选：中国/美国/日本"），让 AI 重选。
3. **不污染快照**：option 列表只在 select 动作内部、选不中时按需查一次，**不塞进每次 `snapshot`**——避免每次快照对每个 select 多轮 DOM 往返、避免 option 多的下拉撑大快照。

> 为何不"塞进快照"：拿到 option 只为"让 AI 看见选项"，而选中无论如何都走 JS 设值；AI 多数时候按文本就能选（"选中国"→ `value:"中国"`），真选不中时按需查即可，ROI 远高于每次快照全量塞 option。

### 4.4 全档多 tab

**core 侧**：
- `BrowserBridge` 每个动作签名加可选 `tabId?: string`：`click(ref, tabId?)` / `type(ref, text, tabId?)` / ...
- 新增 `listTabs(): Promise<BrowserTab[]>`（`BrowserTab = {tabId, url, title, active}`）+ `switchTab(tabId): Promise<BrowserResult>`
- 这两个映射到 `browser_act` 的 `list_tabs` / `switch_tab` action

**desktop 侧**：
- `active-guest.ts` 加 `webContents.id → {url, title}` 反向映射 + `listGuests(): BrowserTab[]`
- `tabId` 定义为 **webContents.id 的字符串形式**（稳定、main 侧天然有）
- `automation-host.ts` 按 `tabId` 路由：`tabId` 给定 → 取对应 webContents 的 driver；未给 → `activeGuest()`（向后兼容）
- `switch_tab` → 让对应 webContents `focus()`（触发现有 focus 事件 → 更新 active）

**ref map 隔离**：每 webContents 一个 `CdpBrowserDriver` 实例、各自 refMap——**天然按 tab 隔离**，无需额外工作。但 core 侧 `maskOldObservations` 需按 **tabId + 工具名** 认快照（见 4.6），避免跨 tab 快照互相误 mask。

> **renderer ↔ tabId 一致性**：renderer 的 `Tab.id`（`tab-N-xxxxxx`）≠ webContents.id。AI 用的 `tabId` 是 webContents.id（main 权威）。`list_tabs` 返回的是 main 视角的 guest 列表，足够 AI 工作；不要求和 renderer 的 tab 顺序/id 对齐。

### 4.5 press_key 权限取舍

`press_key` 能按 Enter（提交表单，类似 click 的副作用）也能按方向键（无害）。两种处理：

- **方案 A（推荐）**：`press_key` 整体归 `allow`。理由：它不指定坐标点击，副作用面比 click 小；现有 `browser_press_enter` 就是 `allow`，保持一致。
- 方案 B：`press_key` 归 `ask`。更保守但打断体验。

**采用 A**。

### 4.6 收敛单工具后的权限粒度（关键难点）

现有权限按**工具名** keying。收敛成 `browser_act` 后，"click 要 ask、scroll 要 allow" 无法靠工具级 permissionDefault 表达。方案：

- **`browser_act` 工具级 permissionDefault = `ask`，但在 handler 内对 `allow` 档 action（hover/scroll/wait/list_tabs/switch_tab）短路放行**，只对 `click/type/select` 走批准流程。
- 复用现有路径策略 / session 权限缓存机制（`project_path_permission_system`）：批准 key 按 `browser_act:click` 这样的 **action 级** 复合键，而非裸工具名——和现有 "按操作非工具名 keying" 的安全修复（`project_permission_session_cache`）一致。
- desktop 侧 `__browser_action__` 拦截已按 action 派发，enforcement 点不变。

**compaction 同步**：`maskOldBrowserSnapshots` → 改名 `maskOldObservations`，识别逻辑从 `name === "browser_snapshot"` 改为 `name === "browser_observe" && args.mode === "snapshot"`（或在结果里带 marker）。按 tabId 分组 mask。**must-fix，否则 token 漏涨**。

## 5. 向后兼容

- **不保留旧 9 工具名**：直接替换。理由：工具名是 LLM-facing，旧 transcript 重放不依赖工具存在（replay 只读历史 tool_result，不重新执行）。preset 白名单 / 权限规则全量替换为 3 个新名。
- **`BrowserBridge` 接口破坏性变更**：删 `pressEnter`，加 `pressKey/selectOption/hover/listTabs/switchTab` + 全动作 `tabId?`。所有实现者（仅 `CdpBrowserDriver` + protocol RPC 适配器）同步改。
- **协议 `__browser_action__` payload** 扩展：加 `tabId`、新 action 枚举。

## 6. 测试策略

- **`@cjhyy/code-shell-cdp` 单测**：mock `CdpSender`，断言每个动作发出的 CDP 命令序列（method + params）。重点 `select`（JS 设值脚本）、`pressKey`（key map 映射 + 组合键序列）。
- **keymap 单测**：覆盖 Enter/Tab/Escape/方向键/F 键/组合键的 code/vk 映射。
- **compaction 单测**：更新 `mask-browser-snapshots.test.ts` → 新工具名 + 多 tab 分组 mask。
- **权限单测**：`browser_act` action 级分档（click→ask、scroll→allow）。
- **真机冒烟**（必须，按 memory 规矩"测新功能必在对应 worktree 跑 app"）：在 worktree 跑 desktop，真实页面验证 select 原生下拉、press_key Tab/Enter、hover 菜单、多 tab list/switch。

## 7. 改动落点清单

| # | 文件 | 改动 |
|---|---|---|
| 1 | `packages/cdp/`（新包 `@cjhyy/code-shell-cdp`） | sender/driver/keymap/actions/types |
| 2 | `packages/desktop/.../cdp-driver.ts` | 改为消费 `@cjhyy/code-shell-cdp`；snapshot 胶水留此（调 core flattenAxTree） |
| 3 | `packages/desktop/.../active-guest.ts` | 反向映射 + `listGuests()` |
| 4 | `packages/desktop/.../automation-host.ts` | 按 tabId 路由 |
| 5 | `packages/desktop/.../intercept.ts` + `agent-bridge.ts` | payload 加 tabId + 新 action |
| 6 | `packages/core/.../browser-bridge.ts` | 接口改：3 工具语义、全动作 tabId、新方法 |
| 7 | `packages/core/.../builtin/browser-tools.ts` | 3 个工具 handler（action/mode 分发） |
| 8 | `packages/core/.../builtin/index.ts` | 注册 3 工具 + action 级权限分流 |
| 9 | `packages/core/.../preset/index.ts` | 白名单 + 权限规则换 3 名 |
| 10 | `packages/core/.../context/compaction.ts` | `maskOldObservations` 改名 + 新识别逻辑 + 按 tab 分组 |
| 11 | `packages/core/.../protocol/server.ts` | `makeBrowserBridge` 适配新接口 |
| 12 | core/desktop 各 rebuild | core 改动后 desktop dist 依赖须 rebuild core |

## 8. 实施顺序（建议分阶段，每阶段可验证）

1. **抽包**：建 `@cjhyy/code-shell-cdp`，把现有动作平移进去（行为不变），desktop 改为消费它。先不加新动作。验证：现有 browser 工具行为不变。
2. **补动作**：包内加 `select` / `pressKey`（取代 pressEnter）/ `hover` + keymap。core 接口同步。验证：单测 + 真机。
3. **工具收敛**：9 → 3 语义工具，compaction 改名同步，preset 同步，action 级权限。验证：单测 + 真机。
4. **多 tab**：core 接口加 tabId + listTabs/switchTab，desktop 路由 + listGuests。验证：真机多 tab。

每阶段独立成 commit，便于回滚。
