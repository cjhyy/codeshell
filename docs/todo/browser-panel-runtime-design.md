# Browser Panel Runtime 设计（终极目标）

> 状态：草案，供评审。基线：origin/main @ 84fe9dbc3（2026-10-13）。
> 参考对象：本机 `/Applications/ChatGPT.app` 内置的 Codex Browser / Chrome 插件 26.1002.52244（Proprietary，仅借鉴设计，不复用代码）。

## 1. 一句话目标

把浏览器能力做成一个**独立发版的 Browser Panel 包**（UI + 受信 service + CLI + Skill）。CodeShell Host 只提供通用的**身份、授权、审批、生命周期和后端托管**。CodeShell 自身、Claude Code、Codex 等任何 Agent，都通过**同一套对象式 SDK / CLI** 操作内置浏览器、用户的 Chromium 浏览器（经扩展）、独立 Chromium 和服务端浏览器。四种后端遵循**同一份薄协议**。

衡量标准：

- 浏览器逻辑（定位、调试、下载、策略、文档）的迭代，不需要给 CodeShell 主仓开分支。
- 新增一种后端，只需要实现薄协议，不需要改 service。
- 外部 Agent 和 CodeShell 内置 Agent 能力一致，权限一致，审计一致。
- Agent 代码在任何形态下都拿不到 socket、token、cookie 或 CDP 原始通道，除非用户显式授权了 `cdp` 能力。

## 2. 参考：Codex 的实际实现（已核对安装包）

| 层 | Codex 实现 | 证据 |
|---|---|---|
| Agent 入口 | `node_repl`：Rust 编写（`node_repl@0.1.0`，基于 rmcp 1.5），是一个 MCP server，提供 `js`、`js_reset`、`js_add_node_module_dir`、`turn_ended` 四个工具 | `cua_node/bin/node_repl` |
| 执行隔离 | 不受信的 `kernel.js`（vm `SourceTextModule`，变量跨 cell 保留）和受信的 `trusted-worker.js` 是两个 Node 进程。受信服务必须位于 `NODE_REPL_TRUSTED_CODE_PATHS` 内，并导出 `handleRpc`。kernel 走 Codex CLI 的系统沙箱（Seatbelt / Landlock） | node_repl strings；`CODEX_CLI_PATH`、`--allow-unix-socket` |
| 特权桥 | 只有受信服务能用：`nativePipe`、`createElicitation`（MCP form elicitation）、`authenticatedFetch`、`emitImage`、`tmpDir`、`addTurnEndedHandler`、`addAfterSubmittedCodeHook` | 同上 |
| SDK | `browser-client.mjs`：`setup` 返回 `apiManifest` 和 `disabledMemberIds`，client 据此生成 Proxy 对象树；每次成员调用都转成一条 `execute` 命令 | `scripts/browser-client.mjs` |
| Service | `browser-service.mjs`（1.4MB），导出 `handleRpc`。Playwright 兼容层是**在页面级 CDP 上自研**的，不依赖 playwright-core | `scripts/browser-service.mjs` |
| 后端发现 | 扫描 `/tmp/codex-browser-use/*.sock`（Windows 是 `\\.\pipe\codex-browser-use*`），调 `getInfo` 匹配。消息是长度前缀 JSON 帧，有对端校验（`browser-use-peer-authorization.node`） | `app.asar` 主进程 |
| 内置浏览器后端 | Electron main 用 `webContents.debugger` 做薄后端：debugger 租约、子 target 会话、下载授权、visibility / viewport / management 宿主命令 | `app.asar` 主进程 |
| 多入口 | `browser` 和 `chrome` 两个插件，service 和 client **逐字节相同**，只是 Skill 和文档不同。`chrome` 另带 native host，注册 `com.openai.codexextension`，覆盖 Chrome / Edge / Brave / Opera / Vivaldi | `plugins/openai-bundled/plugins/*` |
| API 形态 | 核心 API 固定；能力分两级：`browser.capabilities`（management、viewport、visibility），`tab.capabilities`（cdp、pageAssets、webmcp、botDetection、browserAuth）。`tab.dev` 只有 `logs()` | `docs/api.json`、`docs/capabilities/*` |
| 文档 | `documents.json` 分 `included`、`model`、`lookup` 三种模式，按 browserTypes、apiMembers、capabilities 条件注入 | `docs/documents.json` |
| 生命周期 | Agent 新建的标签页在 turn 结束时关闭；`markDeliverable` / `markHandoff` 让标签页跨 turn 保留；用户自己的标签页要经 `openTabs` / `claimTab` 认领 | `docs/tab-cleanup-*.md` |
| 安全 | 错误码带决策来源（approval、guardian、enterprise、site_status、user_persisted_setting）；另有一份风险分级确认策略 | `browser-client.mjs`、`docs/confirmations.md` |

**借鉴的点：**

- 清单驱动的 SDK
- service 和后端分离，后端尽量薄
- 能力分两级
- 文档按条件注入
- turn 级清理加显式标记
- 受信代码和不受信代码分处两个进程
- 错误码带决策来源

**不照搬的点：**

- Agent 入口不强制用 MCP。
- 不自研 Playwright 兼容层，复用已在用的 Puppeteer。
- 不用 Rust 监管进程：CodeShell 的 Host 已经承担了这个角色。

## 3. CodeShell 现状（origin/main）

- **Host：** Desktop main 和 Server hub 是受信方，Panel 页面是 guest。已有：
  - Panel Host API：`availableMethods`、`capabilities`、resources、process、tasks、connection handoff
  - `nativeEntries`：`app/tools/*.mjs` 加 sha256，按环境变量白名单启动，路径通过句柄授予
  - 审批回环：`agent/approvalRequest` 和 `__panel_action__` 等
- **Panel 清单 schema v2：** `agent.tools`（最多 16 个，经 Host 桥执行）、`agent.skills`（最多 8 个，只读）。**没有 `cli` 字段。** package CLI 目前是约定俗成：Skill 通过 Bash 调用它，它直接写工作区，靠文件锁协议协调；Host 通过 `CODESHELL_WORKSPACE_WRITE_PROTOCOL=1` 声明支持，只是信号，不代表授权。
- **浏览器：**
  - Core 层：`BrowserBridge` 加上 `browser_navigate/observe/act/inspect` 四个工具。
  - Desktop main 层：`browser-runtime`（租约、分发、认领、Chrome 扩展授权）、`browser-driver`（`automation-host` 和策略）、`browser-library` 的 Puppeteer 驱动（Electron 和扩展共用）。
  - Chrome 扩展：走 TCP（127.0.0.1，带 token）加 native messaging 中转。
  - 已落地的分层：`BrowserProfile`、`BrowserWorkspace`、`SessionBrowserBinding`、`TabControlStore`（同一时刻只有一个写入者），以及写前重验（见 `docs/todo/browser-layers.html`）。
  - 调试采集已抽成 `browser-devtools` 模块，在 `codex/browser/devtools-module` 分支，尚未合并。
- **缺口：**
  - 没有持久执行环境。`REPL` 工具每次一次性执行，继承完整环境变量，不进沙箱。
  - 没有"给 Agent 代码用的受信服务"这一层。
  - 后端是固定的进程内实现，协议是高层动作。
  - turn 结束事件不会传给浏览器。
  - 系统沙箱只给 Bash 用。
  - CLI 不受 Host 审核，Host 也识别不出调用它的是谁。

## 4. 终极架构

```
┌──────────────────────────── Agent 入口（L0） ────────────────────────────┐
│ CodeShell 内置工具（browser_* 适配层）  │  codeshell-browser CLI  │  可选 MCP 外壳（js/turn_ended） │
└───────────────┬──────────────────────────┴───────────┬──────────────┴──────────────┬────────────────┘
                │ 进程内 SDK                            │ Host endpoint + 调用者 token │
┌───────────────▼──────────────────────────────────────▼─────────────────────────────▼────────────────┐
│ CodeShell Host（L2，通用能力，主仓）                                                                │
│  cliEntries 审核 · 调用者身份 · 授权/审批回环 · 生命周期转发 · 资源/临时目录 · 后端托管 · 沙箱启动  │
└───────────────┬──────────────────────────────────────────────────────────────────────────────────────┘
                │ handleRpc（setup / execute / events / turnEnded）
┌───────────────▼──────────────────────────────────────────────────────────────────────────────────────┐
│ Browser Panel 包（L1，独立仓库/版本）                                                                │
│  service: 会话与归属 · API 清单 · Puppeteer 引擎 · devtools · 策略/确认 · 文档注入 · exec kernel      │
│  ui: 标签页/站点权限/下载/历史/扩展状态      cli: codeshell-browser      skills: iab / chrome / dev  │
└───────────────┬──────────────────────────────────────────────────────────────────────────────────────┘
                │ 薄协议（socket 目录发现 · 长度前缀 JSON · 对端校验）
┌───────────────▼───────────────┬──────────────────────────┬────────────────────┬──────────────────────┐
│ iab：Desktop main             │ extension：native host    │ chromium：独立启动  │ remote：服务端浏览器  │
│ webContents.debugger 租约      │ chrome.debugger + 管理API │ CDP pipe/ws         │ （Phase 6）           │
└───────────────────────────────┴──────────────────────────┴────────────────────┴──────────────────────┘
```

### 4.1 各层职责边界

| 层 | 负责 | 不负责 |
|---|---|---|
| L0 入口 | 把 Agent 的调用转给 SDK；把输出整理成文本、文件路径或图片 | 任何浏览器逻辑或授权判断 |
| L1 Browser Panel | 浏览器领域里的所有逻辑：对象模型、定位器、事件、调试、下载、页面资源、WebMCP、策略、确认、文档 | 持有用户凭据；绕过 Host 授权 |
| L2 Host | 谁在调用、能否调用、何时清理、向用户提问、托管后端连接、进程审核与沙箱 | 浏览器语义（不懂 locator 或 tab 的业务含义） |
| L3 后端 | 标签页的创建 / 关闭 / 列表、CDP 通道、宿主专属能力 | 高层动作、Agent 策略 |

这正是 CODESHELL.md 里 Panel 归属规则的直接应用：领域逻辑放进 Panel，Host 只保留通用的权限和生命周期机制。

## 5. SDK 与 API

### 5.1 对象模型

```ts
const rt = await connect();                          // 进程内或经 Host endpoint
const browser = await rt.browsers.get("iab" | "chrome" | "edge" | "extension" | "chromium");
browser.capabilities.list();                          // 二级能力发现
const tab = await browser.tabs.new({ url, label: "app" });
await browser.tabs.list(); await browser.tabs.get(id); await browser.tabs.selected();
await browser.user.openTabs(); await browser.user.claimTab(id);   // 用户标签页，需认领

await tab.goto(url); await tab.back(); await tab.reload(); await tab.close();
await tab.screenshot({ fullPage, clip });
await tab.getByRole("button", { name: "Submit" }).click();        // Playwright 风格定位器（惰性选择器链）
await tab.evaluate(fn, arg);                                      // 隔离 world；只读模式见 §9
tab.on("dialog" | "download" | "filechooser" | "popup", handler);
await tab.waitForEvent("download").then(d => d.path);

await tab.dev.logs({ levels: ["error"] });
await tab.dev.network({ includeBody });                           // body 受站点授权
await tab.dev.trace(async () => { /* ... */ });                    // 性能 trace + insights
await tab.clipboard.readText(); await tab.clipboard.writeText(s);
await tab.markDeliverable(); await tab.markHandoff();             // 跨 turn 保留
await tab.requestManualHandoff(reason);                           // 交给用户操作（登录、验证码）

const cdp = await tab.capabilities.get("cdp");                    // 原始通道，需授权
const assets = await tab.capabilities.get("pageAssets");
const webmcp = await tab.capabilities.get("webmcp");
const viewport = await browser.capabilities.get("viewport");
const mgmt = await browser.capabilities.get("management");        // 窗口/分组/书签 + 审计轨迹
await browser.history({ from, to, queries });                     // 需审批
```

### 5.2 与现有分层的对应

| SDK 概念 | CodeShell 现有实体 |
|---|---|
| `browser`（某个后端加身份） | `SessionBrowserBinding` → `BrowserProfile`（登录态）+ `BrowserWorkspace` |
| `browser.tabs` | 当前会话的 `BrowserWorkspace` |
| 写操作 | 现有的写操作检查链：白名单 → 审批 → `TabControlStore` 写锁 → 写前重验 |
| `claimTab` / `markHandoff` | `built-in-handoff` 的认领和 TTL、`TabControlStore` 的锁移交 |
| 身份告知 | `BrowserIdentity`（在快照里说明"以谁的身份在操作"） |

### 5.3 清单是唯一事实源

`api/api.json` 定义接口、类型、能力、权限等级和对应的确认策略条目，由它生成：

- TS 类型和 client 清单
- 给 Agent 的 API 文档（与 `documents.json` 的条件注入配合）
- CLI 子命令和参数校验
- 旧版 `browser_*` 工具的 schema（兼容适配层）

`setup` 返回 `{ apiManifest, disabledMemberIds, capabilities }`。被禁用的成员要附带原因，比如后端不支持、策略禁止、尚未授权。

## 6. 后端薄协议（L3）

**发现：** `$CODESHELL_RUNTIME_DIR/browser/*.sock`（Windows 用命名管道前缀）。每个后端监听一个 socket。只有 Host 能连这些 socket，service 通过 Host 托管的连接访问后端。

**消息格式：** 长度前缀的 JSON 帧，分请求 / 响应 / 事件三类，单帧有大小上限。

**握手：** `getInfo` 返回 `{ type, family, instanceId, version, capabilities[], profile }`。

| 方法 | 说明 |
|---|---|
| `getTabs` / `createTab` / `closeTab` / `focusTab` | 只管理本后端里的标签页 |
| `attach(tabId)` / `detach` | 获取或释放 CDP 租约，支持子 target 会话 |
| `executeCdp(sessionId, method, params)` | 页面级 CDP；后端可配置命令黑名单 |
| 事件 `cdp.event` / `tab.created` / `tab.closed` / `download.*` | 统一的事件流 |
| `turnEnded(sessionId, turnId)` | 后端清理自己的临时资源 |
| 宿主专属（可选） | `visibility.get/set`、`viewport.set/reset`、`management.*`、`downloads.grant`、`history.query` |

**对端校验：**

- 至少检查同一 uid，并带 Host 下发的 token。
- macOS 上可以再校验对端进程的签名。
- Chrome 扩展现有的"TCP + token + native messaging 中转"保留作为传输方式，消息改用本协议。

**引擎：** service 给 Puppeteer 实现一个自定义 `ConnectionTransport`，底层走 `executeCdp` 加事件流。现在 Chrome 扩展已经在用 `ExtensionTransport.connectTab`，在只有页面级 CDP 的情况下跑 Puppeteer，所以四种后端都可以复用 `browser-library` 现有的驱动。

## 7. Host 通用能力（L2，主仓改动）

### 7.1 清单扩展（schema v3）

```jsonc
{
  "schemaVersion": 3,
  "nativeEntries": { "browser-service": { "entry": "app/tools/browser-service.mjs", "sha256": "…", "kind": "service" } },
  "cliEntries":    { "codeshell-browser": { "entry": "app/cli/codeshell-browser.mjs", "sha256": "…" } },
  "hostCapabilities": ["browser.backends", "approval", "lifecycle.turn", "resources.tmp"],
  "agent": { "skills": ["agent/skills/browser/SKILL.md", "agent/skills/chrome/SKILL.md"] }
}
```

- `kind: "service"`：这个 nativeEntry 是常驻的受信服务，导出 `handleRpc`，由 Host 拉起并监管。
- `cliEntries`：安装时在 `~/.code-shell/bin/` 生成 shim，启动时校验 sha256，在安装审核和设置页展示（复用 `panel-capability-visibility` 的界面）。
- `hostCapabilities`：Panel 声明需要哪些 Host 能力，用户审核时能看到。

### 7.2 调用者身份与 endpoint

- 内置 Agent 调用 Bash 或工具时，Host 注入：
  - `CODESHELL_HOST_ENDPOINT`
  - `CODESHELL_CALLER_TOKEN`：一次性，绑定 session、turn 和 Panel，有 TTL，用完回收
  - 机制和 Cookie Lease 一致：按任务、一次性、随调用注入
- 外部 Agent 或人工调用：首次走配对和审批，拿到绑定"项目 + 调用方"的长期凭据，用户可随时撤销。
- 授权、审计、标签页归属都按 **(调用者, session, Panel)** 记录。环境变量只是信号，token 才是授权，与 `CODESHELL_WORKSPACE_WRITE_PROTOCOL` 的原则一致。

### 7.3 给受信服务的特权桥

| 桥 | 实现 |
|---|---|
| `backends.connect(instanceId)` | Host 托管连接，只放行已登记的后端 |
| `approval.request({ risk, data, destination })` | 接到现有审批回环（新增 `__service_action__`）。没有 UI 时，退回 CLI 终端确认或预配置策略 |
| `lifecycle.onTurnEnded / onSessionEnded` | 转发 `on_turn_end`、`on_session_end`；外部 Agent 由 Stop hook 调用 `codeshell-browser turn-end` |
| `resources.tmpDir / emitArtifact` | 按任务分配临时目录；截图等写成文件后返回路径 |
| `audit.record` | 统一的审计流，设置页和管理能力共用 |

## 8. 执行形态与隔离

1. **默认用 CLI 命令模式：** 每次调用都是新进程，状态保存在 service 里（label 或句柄 ID）。适合所有只有 shell 的 Agent。
2. **exec 脚本模式（组合逻辑）：** `codeshell-browser exec --session S <<'JS' … JS`，脚本由 service 托管的**沙箱 kernel** 执行：
   - kernel 是独立子进程，环境变量走白名单，没有文件系统和网络权限
   - 只注入 SDK client，变量在同一 session 内跨调用保留
   - 复用 `tool-system/sandbox` 的 Seatbelt / bwrap
   - 对应 Codex 的 untrusted kernel；受信部分就是 service 本身
3. **进程内模式：** CodeShell 的内置工具直接调用 SDK，最少跳转。
4. **可选 MCP 外壳：** 只暴露 `js`、`js_reset`、`turn_ended`，转发到 exec 模式，给偏好 MCP 的 Agent 用。

| 实体 | 能接触到的东西 |
|---|---|
| Agent 代码（CLI 参数、exec 脚本） | SDK 对象；输出到临时目录 |
| CLI 进程 | caller token、Host endpoint |
| Browser service | 经 Host 托管的后端连接、审批桥、临时目录 |
| Host | 全部，包括 profile 和 cookie |
| 后端 | 自己的标签页和 CDP |

## 9. 安全模型

- **风险分级确认：** 采用一份确认策略文档，写进 `documents.json` 的 included 部分：
  - 必须交给用户亲自操作（改密码的最后一步、绕过安全拦截）
  - 执行时必须确认（删除、支付、对外发送、传输敏感数据、安装扩展）
  - 允许事先授权（登录、上传、权限弹窗）
  - 无需确认
  - service 侧对能识别的高风险动作强制拦截，不只依赖 Agent 自觉。
- **错误码带决策来源：** `approval` / `policy` / `site` / `user_setting` / `enterprise`，每个标明是否可重试，统一附上"不得绕过"的提示文字。
- **写操作检查链保持不变：** 白名单 → 审批 → TabControl 写锁 → 写前重验（browserId、tabId、origin、title）。外部浏览器的每次写操作都要审批。
- **`evaluate`：** 默认在隔离 world 执行，禁止动态 `import`。另设 `readonly: true` 选项，用 `Runtime.evaluate` 的 `throwOnSideEffect` 加超时。主 world 执行归入 `cdp` 级别的授权。
- **敏感数据：** 网络 body、cookie、存储默认脱敏，需要逐站授权；历史查询需要审批，且必须带时间范围。
- **页面内容一律视为不受信数据**（防提示注入），在文档和工具输出里明确标注。

## 10. 能力覆盖（对照差距清单）

| 能力 | 归属 | 实现方式 | 阶段 |
|---|---|---|---|
| 标签页生命周期 | service + 后端 | `tabs.new/close/list/get/selected`、标签、turn 清理、mark | P2 |
| 语义定位 / 只读求值 | service | Puppeteer 定位器加注入脚本；隔离 world 或 `throwOnSideEffect` | P2 |
| 弹窗 / 文件选择 / 下载 | service + 后端 | CDP 事件；`downloads.grant` 和最终路径 | P3 |
| 剪贴板 / 视口 / 可见性 | 后端宿主命令 + service | `clipboard`、`viewport`、`visibility` 能力 | P3 |
| 开发调试 | service（`browser-devtools`） | `tab.dev.*` 结构化接口，加 `cdp` 原始能力 | P3 |
| 页面资源 / 内容导出 | service | `pageAssets.list/bundle`、`content.export` | P4 |
| 浏览器管理 / 历史 | 扩展后端 + service | `management` 能力加审计；`history` 需审批 | P4 |
| 站点权限 / 清理数据 / 设置 | Panel UI + Host 授权 | 逐站策略，三档：询问 / 允许 / 拒绝 | P4 |
| 页面标注 / 样式调整 | Panel UI + service | 覆盖层、临时样式表、导出 diff | P5 |
| 外部浏览器覆盖 | 扩展后端 | native host 覆盖多款 Chromium 浏览器，加 `claimTab` | P4 |
| WebMCP | service | `webmcp.fetchTools/call`，需要确认，放在实验开关后 | P5 |
| 内置浏览器加载第三方扩展 | iab 后端 | 先做原型调研（`electron-chrome-extensions` 是 GPL-3，需评估许可） | 调研 |

## 11. 迁移与兼容

- `browser_navigate/observe/act/inspect` 和 `BrowserBridge` 保留，作为 SDK 之上的一层适配，旧会话和旧 Panel 行为不变。
- `browser-runtime` 的租约、分发、授权逐步迁成"Host 托管后端 + service 管理归属"，Desktop main 最终只保留 iab 后端和 UI。
- 迁移完成后，`packages/cdp` 只保留动作和键位映射，或并入 `browser-library`。
- `browser-devtools` 合并后作为 service 的子模块。
- Panel schema v2 继续可用，v3 新增字段全部是可选的。

## 12. 路线与验收

| 阶段 | 内容 | 验收 |
|---|---|---|
| P0 Host 底座 | schema v3 的 `cliEntries` 和 service 类 nativeEntry；Host endpoint 和 caller token；调用者身份进入授权；生命周期转发；审批桥 | 一个示例 Panel 的 CLI 被 CodeShell 内置 Agent 和 Claude Code 分别调用；token 过期或被撤销后调用被拒；turn 结束能收到通知 |
| P1 薄后端 | iab 后端实现薄协议（socket 目录、`getInfo`、tabs、`executeCdp`、事件），并接入 TabControl | 用协议测试套件直接驱动 iab 后端 |
| P2 Browser Panel MVP | service 加 Puppeteer transport；CLI 支持 tab、goto、find、click、fill、screenshot；turn 清理和 mark；旧工具改为适配层 | 现有浏览器 e2e 全部通过；Claude Code 通过 Skill 跑通本地页面测试 |
| P3 调试与事件 | `browser-devtools`、`cdp` 能力、弹窗、下载、剪贴板、viewport、exec 沙箱 kernel | 开着 DevTools 时自动化不中断；下载能拿到路径；exec 脚本访问不到 fs 和 token |
| P4 外部浏览器与管理 | 扩展后端改用薄协议；多浏览器 native host；`claimTab`、`management`、`history`；逐站权限 UI；chromium 后端 | Edge 和 Brave 能认领标签页并操作；审计轨迹可查 |
| P5 扩展能力 | pageAssets、内容导出、WebMCP、页面标注、样式调整；服务端浏览器（Phase 6） | 按能力分别验收 |

## 13. 待决策

1. **没有 Host 时 CLI 怎么办：**
   - 方案 A：CLI 必须连 Host，Server 或 headless 也算 Host。授权和审计集中，是推荐方案。
   - 方案 B：允许 CLI 自己拉起一个只带 chromium 后端的精简 service，用于 CI。
2. **service 的进程模型：** 每个项目一个常驻 service，还是每个 session 一个？倾向每个项目一个，内部按 session 隔离，和 `BrowserProfile` 按项目共享的做法一致。
3. **schema 版本：** 新开 v3，还是在 v2 上加可选字段？
4. **MCP 外壳是否随包发布，还是由用户按需启用？**
5. **对端校验做到哪一级：** 同 uid 加 token，还是再加签名校验？Linux 和 Windows 上怎么做？

## 14. 明确不做

- 不在 Host 里实现浏览器语义（定位器、调试解析、确认策略）。
- 不向 Agent 直接暴露后端 socket 或 profile 目录。
- 不自研 Playwright 兼容引擎，不引入 Rust 监管进程。
- 不复用 Codex 插件代码（许可证为 Proprietary）。
