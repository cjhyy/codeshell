# 设计:手机/平板遥控 UI 重构为独立 React 应用(复用 shadcn,桌面端体验对齐)

- 日期:2026-06-10
- 状态:Draft(用户已授权按推荐方案自主推进)
- 范围:把现有内联在 `mobile-ui.ts` 里的 690 行模板字符串(CSS+HTML+vanilla JS),重构成 `packages/desktop/src/mobile/` 下的一套真正的 React 应用;复用 desktop 的 shadcn 组件;补齐与桌面端的能力/可见性对齐(控制现有 session、提问、权限审批、房间);把校验/连接/消息归约等手机端逻辑分层进 repo,可单测。
- 非范围:公网 relay 协议改动(隧道现状不动)、原生 App、手机端文件编辑器、完整 diff review、PTY 真 TUI。沿用 `2026-06-06`、`2026-06-07` 两份设计的全部安全不变量与房间模型。

---

## 0. 一句话

现在手机 UI 是 `mobileRemoteHtml()` 返回的一坨字符串,由 `remote-host-manager.ts` 在 `GET /mobile` 直接吐出。本设计把它换成一个**独立 vite 构建的 React 应用**(`src/mobile/`),复用 desktop 的 shadcn/Tailwind 组件,构建产物落 `out/mobile/`,由 remote host 作静态资源服务;同时把手机端逻辑分层为 `lib/`(校验、设备密钥、持久化)、`hooks/`(WS 连接/重连/消息归约)、`components/`(纯展示),并补齐桌面端已有、手机端缺失的能力。

---

## 1. 现状盘点(为什么要重构)

### 1.1 服务方式
- `mobile-ui.ts:1` `mobileRemoteHtml(): string` 返回完整 HTML(内联 `<style>` + `<script>`)。
- `remote-host-manager.ts:118-120` `GET /mobile` → `res.end(mobileRemoteHtml())`。
- 隧道模式在每个路由前加 passcode gate(`access-passcode.ts`),WS 升级同样过 gate。

### 1.2 数据通路(关键:对齐基础已就位)
- **出站**:`index.ts:609` `bridge.subscribeOutbound((line) => mobileRemote.broadcastRaw(line))` —— 手机收到的是**与桌面 renderer 完全相同的 worker→renderer JSON-RPC 行**。
- **入站**:`handleMobileClientEvent`(`index.ts:260`)把手机事件转成**与 renderer preload `rpc()` 完全相同的 worker 消息**(`agent/run`、`agent/approve`、`agent/cancel`),不存在第二套 run loop。core 的权限引擎、goal、快照原样适用。

**结论:`内容能在桌面端看到、也能在手机端操作` 在传输层已成立。** 手机看到的是同一份流,手机的动作进同一条 run 路径。真正的缺口是:**手机 UI 只解析了这份流的一个子集**,且无法枚举/进入桌面端真实 session。

### 1.3 手机端逻辑现状(都内联在字符串)
- 设备密钥生成 / deviceId / 配对 token(`mobile-ui.ts:521-537`)。
- WS 连接 + 重连(`:539-562`)。
- 消息归约 / 渲染(`handle()` `:444-519`,DOM 直接拼)。
- 审批卡状态(`approvalCard` `:417-442`)。
- 房间列表/进出(`:592-666`)。

### 1.4 协议
- `types.ts` 已定义 `MobileClientEvent` / `MobileServerEvent` / `RoomPublic`,但**只在 main 用**。

---

## 2. 与桌面端的能力对齐缺口(本次要补)

桌面 renderer 消费完整 `agent/streamEvent` + RPC 面;手机 `handle()` 只解析约 6 个子类型。逐项缺口:

| 维度 | 桌面端有 | 手机端现状 | 本次目标 |
|---|---|---|---|
| **会话列表** | 侧边栏真实 session(repos/sessionIndex) | 只会 mint `mobile-*` id,**看不到桌面会话** | 拉真实 session 列表,可进入并 replay 历史 |
| **会话标题** | LLM 一句话标题 | 无 | 列表显示 title(复用 `SessionState.title`) |
| **历史回放** | 重开 session replay transcript | 无(只看实时流) | 进入 session 拉 transcript 回放 |
| **流事件** | text/reasoning/tool start+**end**/summary/turn_summary/goal/subagent task/timestamps/stopped | 仅 text_delta/tool_start/tool_summary/turn_complete/error | 补 reasoning、tool_end(结果)、turn_summary、goal、subagent 行、时间戳、被打断标记 |
| **子代理** | 子代理卡片(按 agentId 隔离) | 无 | 子代理状态行(只读) |
| **权限审批** | 路径作用域规则、options-only/自由输入、风险分级 | 只 approve/reject + 粗 risk | 对齐:展示工具/命令/路径,approve/reject,风险醒目;路径规则记忆后置 |
| **权限模式** | 切 default/acceptEdits/bypass | 无 | 手机可查看+切换当前 run 的 permissionMode |
| **模型** | 切模型 | 无 | 手机可查看+切换模型(后置,优先级低) |
| **房间** | (桌面无房间;房间本就是手机特性) | 协议全、UI 简陋 | UI 重做:房间列表/cwd/权限 badge/进出/历史/实时流 |
| **运行控制** | stop | 有 | 保留 |

优先级:**P0 = 会话列表+历史回放+完整流事件+审批对齐+房间 UI**;**P1 = 权限模式切换+子代理行+时间戳**;**P2 = 模型切换+路径规则记忆**。

---

## 3. 目标架构

### 3.1 目录结构(新增 `src/mobile/`)

```
packages/desktop/src/mobile/
  index.html                 # vite entry
  main.tsx                   # React 挂载
  App.tsx                    # 顶层:连接态机 → 路由(配对/聊天/房间/设置)
  lib/
    deviceCredential.ts      # 设备密钥生成、deviceId、secretHash —— 可单测
    pairing.ts               # 配对 token 解析/校验 —— 可单测
    storage.ts               # localStorage 封装(cs.deviceId / cs.deviceSecret)
    streamReducer.ts         # JSON-RPC 流 → 视图状态(messages/turns/tools/goal)—— 可单测
    riskClassify.ts          # 审批风险分级/摘要提取 —— 可单测(从内联 ks[] 提取规则化)
  hooks/
    useRemoteSocket.ts       # WS 连接/重连/心跳/鉴权握手;吐 typed 事件
    useSessions.ts           # 会话列表 + 选中 + 历史
    useRooms.ts              # 房间列表/进出/历史/实时
    useApprovals.ts          # 待审批队列
  components/
    ConnectionGate.tsx       # 配对/认证/错误态
    ChatView.tsx             # 消息流 + 输入 + 停止
    MessageStream.tsx        # 复用 streamReducer 的产物渲染
    ApprovalCard.tsx
    ToolCard.tsx
    SubagentRow.tsx
    SessionList.tsx
    RoomList.tsx / RoomView.tsx
    StatusBar.tsx
  styles.css                 # @import tailwind;(其余走组件)
```

### 3.2 组件复用(决策:mobile 从 renderer 路径引)
- mobile vite 配置加别名 `@ui → ../renderer/components/ui`、`@lib → ../renderer/lib`(cn() 等)。
- 零改动 desktop。接受 mobile 依赖 renderer 目录结构的轻耦合。
- shadcn 组件本就是无 Node 依赖的纯 React+Tailwind,浏览器环境直接可用。

### 3.3 协议共享(决策:手机从 main types.ts 直引)
- mobile vite 加别名 `@protocol → ../main/mobile-remote/types.ts`,**只引 type**(`import type`),不进 bundle。
- 一处定义两端用;协议漂移编译期即报。

### 3.4 构建/服务(决策:独立 vite 构建 + 静态服务)
- 新增 `vite.mobile.config.ts`:`root: src/mobile`,`outDir: out/mobile`,`base: "./"`,React+Tailwind 插件,上述别名。
- `package.json` 加 `build:mobile`(`vite build -c vite.mobile.config.ts`);`scripts/build.ts`、`scripts/dev.ts` 串入。
- `remote-host-manager.ts`:`GET /mobile`(及 `/mobile/*` 静态资源)改为从 `out/mobile/` 读文件服务(替代 `mobileRemoteHtml()`);保留 passcode gate 在前。隧道与 LAN 路径一致。
- **dev 体验**:dev 时 main 把 `/mobile/*` 反代到 mobile vite dev server(端口固定,如 5373),拿 HMR;prod 读静态。(这是服务细节,不是运行时挂 dev server 的常驻方案。)

### 3.5 旧文件去向
- `mobile-ui.ts` 删除(或留一个抛错的 stub 一个迭代后删)。其 CSS 设计语言(precision dark console)作为参考,新 UI 用 shadcn + Tailwind dark 复刻气质,不照搬 hex。

---

## 4. 主进程侧补的协议(支撑能力对齐)

为补齐 §2 缺口,`types.ts` + `index.ts` 扩展(房间已全):

手机 → main 新增:
- `session.list` — 拉真实会话列表。
- `session.history { sessionId, sinceSeq? }` — 拉某会话 transcript(回放)。
- `permission.setMode { sessionId?, mode }` — 切权限模式(复用 core setPermissionMode)。
- `model.set { model }`(P2)。

main → 手机新增:
- `session.list.ok { sessions: { id, title, cwd, lastActiveAt }[] }`。
- `session.history.ok { sessionId, events[] }`(transcript 转成与实时流同构的事件,复用 streamReducer)。
- `permission.mode { sessionId?, mode }`。

实现要点:`session.list` 复用 disk-authoritative 会话源(同 `sessions-service`/`listDiskSessions`,经 existsSync(cwd) 过滤);`session.history` 把磁盘 transcript 转成 `agent/streamEvent` 同构事件,让手机一套 reducer 同时吃实时与回放(沿用 disk 权威源不变量)。

---

## 5. 安全/不变量(全部沿用,不放松)

沿用 `2026-06-06` §12 与 `2026-06-07` §10 的全部不变量:
- Remote host 默认关闭;只绑 LAN(或隧道 loopback);不做公网 relay 暴露 0.0.0.0。
- 配对 token 一次性 10 分钟;trusted device 可 revoke;未认证不可订阅/发送。
- 手机 approval 等同桌面;所有工具仍走 core permission engine,remote host 只是 transport+UI。
- 房间 dangerous(bypassPermissions)只在 trusted cwd 自动生效,否则需高风险审批 + 标红 + 审计。
- 新增 `session.history`/`session.list`:**仍受 WS 鉴权**;只读;手机能看的就是 broadcastRaw 本就发的同一份流的回放,不新增可见性面。

**新构建产物的注入安全**:`out/mobile/` 静态服务只服务自有构建文件(白名单 index.html + assets),不做任意路径读取(防目录遍历,沿用 `beta1` 修过的路径遍历教训)。

---

## 6. 测试策略

- **lib 单测**(纯函数,最大价值):`deviceCredential` 密钥格式/幂等;`pairing` token 解析;`riskClassify` 摘要/分级;`streamReducer` 喂录制的 JSON-RPC 行 → 断言视图状态(text 合并、tool start/end 配对、turn 收口、goal、被打断)。
- **协议编译期**:mobile 引 `@protocol` 的 type,改协议漏改一端即 tsc 报错。
- **构建冒烟**:`build:mobile` 产物存在;`remote-host-manager` 服务 index.html + assets;404 路径不泄漏。
- **真机冒烟**(手动,沿用 beta-smoke):扫码配对 → 看到真实会话列表 → 进一个桌面会话看回放 → 发任务看实时流 → 收 Edit/Bash 审批并批准 → 进房间常驻 Claude Code 协作。
- desktop 自有 `tsc --noEmit` + `build:renderer` 不覆盖 mobile;**mobile 改完单独跑 `tsc`(mobile tsconfig)+ `build:mobile`**。

---

## 7. 分阶段实现

**Phase 0 — 脚手架(可独立验证)**
- `src/mobile/` 骨架 + `vite.mobile.config.ts` + 别名 + `build:mobile` 串进 build/dev。
- `remote-host-manager` 从 `out/mobile/` 服务静态;`mobile-ui.ts` 暂留。
- 跑通:扫码 → React 壳子加载 → 配对 → 认证 → 能发一条消息看到实时流(行为不回退)。

**Phase 1 — 逻辑分层 + 流对齐(P0 核心)**
- 抽 `lib/`(deviceCredential/pairing/storage/streamReducer/riskClassify)+ 单测。
- `hooks/useRemoteSocket` + `streamReducer` 吃完整流事件(reasoning/tool_end/turn_summary/goal/被打断/时间戳)。
- `components/` 用 shadcn 复刻聊天流 + 审批卡 + 工具卡。

**Phase 2 — 会话对齐(P0)**
- 协议加 `session.list` / `session.history` + main 实现(disk 权威源 + 转同构事件)。
- `hooks/useSessions` + `SessionList` + 历史回放;手机能进桌面会话。

**Phase 3 — 房间 UI 重做(P0)**
- `useRooms` + `RoomList`/`RoomView`:cwd、权限 badge(dangerous 红)、进出、历史、实时。

**Phase 4 — 能力补全(P1/P2)**
- 权限模式切换 + 子代理状态行(P1);模型切换 + 路径规则记忆(P2)。
- 删 `mobile-ui.ts`。

**Phase 5 — 打磨**
- 平板两栏布局(沿用现有 820px 断点意图);真机冒烟;性能(流批量渲染)。

---

## 8. 关键决策(已拍板)

1. 构建:**独立 vite 构建 + 静态服务**(`src/mobile` → `out/mobile`,remote host 服务)。
2. 组件复用:**mobile 从 renderer 路径引**(别名指 `../renderer/components/ui`,零改 desktop)。
3. 逻辑组织:**分层 hooks + lib + 协议共享**(lib 可单测)。
4. 协议:**手机从 main `types.ts` 直引**(`import type`)。
5. 房间:沿用 `2026-06-07` 房间模型(常驻 stream-json、disk 权威、per-room cwd/权限),UI 重做。
6. 在新 git worktree 中实施,隔离当前工作区。

---

## 9. 风险与权衡

- **renderer 路径耦合**:mobile 依赖 `../renderer/components/ui` 结构;若 desktop 重构组件目录,mobile 别名要跟。可接受(同一 repo、同次 CI tsc 兜底)。
- **浏览器 vs Electron 环境差异**:shadcn 组件无 Node 依赖,安全;但若个别组件偷用了 `window.codeShell`,mobile 不可用——抽用时只取纯展示组件,带宿主依赖的不复用。
- **transcript → 同构事件**的转换是新代码,易漏事件类型;用 streamReducer 单测 + 录制样本兜底。
- **包体**:mobile bundle 引 React+shadcn 比内联字符串大;局域网/隧道可接受,做 gzip + 拆 vendor chunk。
