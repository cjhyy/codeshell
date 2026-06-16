# 凭证模块设计 (Credentials Module)

> 2026-06-16 · 主页面左侧新增「凭证」顶层页,统一管理三类凭证(Cookie / Permission Token / Link)。
> Cookie 子模块复用已就绪的 **Cookie Lease** 设计(`docs/browser-cookie-export-design-2026-06-14.md`);
> Token / Link 是新增的常驻凭证库。三类凭证被工具使用时**共用同一套授权 + 记忆机制**。

## 1. 目标与范围

主页面左侧导航新增一个顶层页「凭证」,分三个子模块 tab:

1. **Cookie** —— 用内置浏览器登陆目标站点后,把该域名登录态桥接给 CLI 工具(yt-dlp / curl / 小红书 CDP 等)。
   **不重存 cookie 值** —— 登录态本就常驻在 `persist:browser` 持久分区(登一次落磁盘、过期才重登),
   用时现抓生成临时 cookies.txt。完整设计见 §4.1 引用的 Cookie Lease 文档。
2. **Permission Token** —— 手动录入个人 permission token(如 Figma 个人 token),给 MCP 鉴权或工具使用。
3. **Link** —— 用户去各业务方注册 app 拿到的凭证(client id/secret 等),录入后供 MCP / 工具引用。

### 关键洞察:为什么 cookie 不存值,token/link 必须存

- **cookie 的源已常驻**:`persist:browser` 是 persistent 分区,cookie 写磁盘,关 app 重开仍在。
  把 cookie 值再复制一份进 `~/.code-shell` 几乎只增加泄漏风险(全站明文长期落盘),
  不换来真正便利(源已常驻,用时现抓即可),且那份副本还会过期、要跟分区同步。→ 临时 lease。
- **token/link 没有别的源**:线下注册拿到的字符串,不录进来就丢了。→ 必须常驻存储。

### 非目标 (YAGNI)

- 不做自动 OAuth 授权流程。Link 的"注册"是线下行为:用户自己去业务方注册拿到凭证,手动录入。
- 不做 cookie 值的常驻存储 / 自动刷新轮换(归 Cookie Lease 的过期检测,见其 §6)。
- 不做跨设备同步。token/link 只在本机两层存储。

## 2. 架构总览

```
┌─ core ───────────────────────────────────────────────┐
│  CredentialStore (新) —— 只存 token / link            │
│    全局 ~/.code-shell/credentials.json                 │
│    项目 <cwd>/.code-shell/credentials.json             │
│    双层合并(项目覆盖全局),脱敏存储                    │
│                                                         │
│  CredentialUseGate (新,统一授权/记忆层) —— 三类共用    │
│    任何凭证(cookie/token/link)被工具使用前过此门:    │
│      复用 InteractiveApprovalBackend 弹审批             │
│      支持「本会话记住」(内存档,关 app 忘,见 §5)      │
│                                                         │
│  消费通道:                                             │
│    ① 工具使用(默认) → CredentialUseGate 审批 → 注入   │
│         cookie: 触发 Cookie Lease,注 CODESHELL_COOKIE_FILE│
│         token/link: 解析值,注入该次调用 / env          │
│    ② MCP 鉴权 → MCP 配置存 credentialRef,连接时        │
│         resolveCredential → bearerToken / envHeaders    │
│         (token/link;cookie 不走 MCP)                   │
└─────────────────────────────────────────────────────────┘
         ↑ cookie 现抓(不存值)
┌─ desktop main ───────────────────────────────────────┐
│  Cookie Lease (已设计,见 browser-cookie-export 文档)  │
│    session.fromPartition("persist:browser")            │
│      .cookies.get({domain}) → 临时 Netscape cookies.txt│
│      → 注入当次工具调用 → try/finally + 超时 + 启动扫描清理│
└─────────────────────────────────────────────────────────┘
         ↑
┌─ desktop renderer ───────────────────────────────────┐
│  新顶层页 view="credentials"(SidebarNav 加一项)        │
│    3 tab: Cookie / Permission Token / Link             │
│  + MCP 编辑器加「使用凭证」下拉(token/link 绑定)       │
└─────────────────────────────────────────────────────────┘
```

**关键设计决策**(均经用户确认):
- 统一凭证库 + 复用现有基础设施(approach A)。
- 消费侧绑定:消费方(MCP 编辑器)出「选凭证」下拉指向凭证 ID。
- **三类凭证被工具使用时共用同一套授权 + 记忆机制(CredentialUseGate)** —— cookie 不能一套、token/link 另一套。
- cookie = 临时 Lease(不重存值);token/link = 常驻凭证库。
- 授权记忆:加「本会话记住」一档(内存、关 app 忘),不落盘。三类一致。

## 3. 数据模型

```ts
// core: 常驻凭证(仅 token / link;cookie 不进库)
type CredentialType = "token" | "link";

interface Credential {
  id: string;              // 引用键,kebab-case,如 "my-figma-token"
  type: CredentialType;
  label: string;           // 展示名
  // 密文:UI 永远只显示掩码;持久化时按现有 redact 范式脱敏(见 §7)
  secret?: string;         // token: token 值;link: client id/secret 等的 JSON
  exposeAsEnv?: string;    // 可选:静态暴露为 shell env 变量名
  meta?: { appUrl?: string };  // link: 业务方 app 注册地址
}
```

存储文件:`{ version: 1, credentials: Credential[] }`,全局与项目各一份。
写路径必须用 `userHome()` 而非裸 `homedir()`(测试隔离,见 memory `project_test_pollutes_real_settings`)。

> Cookie **不**进此模型。它的"凭证"就是 `persist:browser` 分区本身;Cookie tab 列的是
> "哪些域名已登陆/可桥接",不是存储的条目。

## 4. 子模块细节

### 4.1 Cookie —— 复用 Cookie Lease(已就绪设计)

**直接按 `docs/browser-cookie-export-design-2026-06-14.md` 实现,本 spec 不重述其内部。** 要点:

- 临时 lease:主进程从 `persist:browser` 读限定域 cookie → 生成 `/tmp` 下临时 Netscape cookies.txt
  → 注入当次工具调用的 `CODESHELL_COOKIE_FILE` env → try/finally + 超时定时器 + 启动扫描三层清理。
- 安全护栏:按域名、0600 权限、用完即删、不落工作区。
- **与本 spec 的衔接点(对原 Cookie Lease 的两处对齐)**:
  1. **授权走统一的 CredentialUseGate**(§5),而非 cookie 专有审批路径。
  2. **加「本会话记住」一档** —— 原 Cookie Lease §7 写死"不提供始终允许、每次确认";
     本 spec 放宽为支持「本会话该域名不再问」(仅内存、关 app 忘、不落盘),与 token/link 一致。
     永久/项目级落盘授权仍不做(trust policy 留后)。
- **UI 形态敲定**(原文档 §9 未决):Cookie tab 列出 `persist:browser` 里已有登录态的域名
  (经 main 枚举),提供「在浏览器打开 <url> 登陆」入口;不在面板暴露"直接导出 cookie"按钮
  (导出只在 agent 工具触发时经审批发生,符合原文档 §7 安全立场)。

### 4.2 Permission Token —— 手动录入,常驻

- **UI**:表单(label / token 值 / 可选 exposeAsEnv)。值输入后只显示掩码。
- **消费**:
  - MCP 编辑器「使用凭证」下拉指向它 → 连接时解析成 `bearerToken`(复用现有 MCP 鉴权字段)。
  - 或带 `exposeAsEnv` 静态进 env 给 Bash/skill。
  - 或工具使用时经 CredentialUseGate 审批后注入。

### 4.3 Link —— 业务方 app 凭证,常驻

- **UI**:列出已 link 的 app(label / appUrl / 凭证字段)。「注册」是引导用户去 `appUrl` 线下注册,
  拿到凭证后手动录入(client id/secret 等多字段存进 `secret` 的 JSON)。
- **消费**:同 token —— 供 MCP / 工具引用,经 CredentialUseGate。

## 5. CredentialUseGate —— 统一授权 + 记忆层(三类共用)

任何凭证(cookie / token / link)被工具使用前,经同一道门:

- 发 `ApprovalRequest`(扩展 `kind: "credential"` 或复用现有结构),经
  `InteractiveApprovalBackend.requestApproval`(`packages/core/src/tool-system/permission.ts`)。
- **审批文案统一**:「AI 想用『<label>』(<域名/用途>)执行此命令,是否允许?」
  含请求方、目标命令、凭证范围、风险提示(沿用 Cookie Lease §7 文案要素)。
- **记忆档位(三类一致)**:
  - 「仅此次」—— 默认。
  - 「本会话记住」—— 落 `sessionAllowRules`(内存,关 app 忘);键按 (凭证 id / cookie 域名) 而非工具名
    (避免一次批准放行无关调用,见 memory `project_permission_session_cache`)。
  - **不提供**永久/项目级落盘授权(trust policy 留后;与 Cookie Lease 安全立场一致)。
- 允许后注入:cookie → 触发 Lease 生成 txt 并注 `CODESHELL_COOKIE_FILE`;token/link → 注入值/env。

## 6. 消费侧绑定:MCP credentialRef

- `McpEditor`(`packages/desktop/.../mcp/`)鉴权区加「使用凭证」下拉,存 `credentialRef: id`(仅 token/link)。
- core 构建 MCP 连接 headers 时(复用 `buildHttpHeaders`,见 memory `project_mcp_auth_error_ux`):
  有 `credentialRef` → `resolveCredential(id)` → 注入 `bearerToken` / `envHeaders`。
- 引用不存在的凭证:复用 `humanizeError` 范式给友好错误。

## 7. 错误处理

- Cookie:目标域无 cookie(未登陆)→ 明确提示「未检测到该站点 cookie,请先在浏览器登陆」;
  过期检测/403 兜底归 Cookie Lease §6。
- 引用不存在的凭证:MCP 连接 / 工具调用时友好报错。
- 脱敏:token/link 的 UI 与日志永不显示明文;持久化按现有 redact 范式。掩码如 `tok_****abcd`。
- cookie 明文只活在 /tmp 临时文件(Lease 三层清理),不落库、不落工作区。

## 8. 测试策略 (TDD)

每个单元独立单测,`bun test` 带 `src/` 避免 dist 旧测试(见 memory `project_image_video_gen`):

1. **CredentialStore**(token/link):读写、双层合并、脱敏、`userHome()` 隔离。
2. **CredentialUseGate**:三类凭证审批请求经 InteractiveApprovalBackend;「本会话记住」按 id/域名键
   生效且仅内存;无落盘授权。
3. **resolveCredential**:按 id 解析,缺失返回友好错误。
4. **MCP credentialRef**:解析成 bearerToken/envHeaders;缺失走 humanizeError。
5. **Cookie Lease**:沿用其文档的测试要点(Netscape 格式映射、三层清理、按域)。本 spec 新增:
   Lease 授权改走 CredentialUseGate 后路径仍通;「本会话记住」对同域第二次调用不再弹。
6. **readShellEnv 凭证层**(token/link 带 exposeAsEnv):正确注入,层级优先级正确。
7. **renderer**:凭证页 3 tab 渲染、token/link 录入与掩码、Cookie tab 已登陆域名列表(锁定测试)。

## 9. 分阶段实施(每阶段独立可验收)

1. **core CredentialStore + 数据模型(token/link)** —— 存储/双层/脱敏 + 单测。
2. **core CredentialUseGate** —— 统一审批/记忆层 + 单测(为后续 cookie/token/link 复用)。
3. **renderer 凭证页 + Token/Link 两 tab** —— 录入、掩码、SidebarNav 接线、view 类型扩展。
4. **Cookie 子模块** —— 实现 Cookie Lease(按其文档)+ Cookie tab UI + 授权接入 CredentialUseGate。
5. **消费通道接线** —— MCP credentialRef + token/link 的 env 注入。

> Cookie Lease 本身是块独立大工程(main 进程 + IPC + 三层清理)。若它优先级高,阶段 4 可单独先做;
> 否则建议先把 Token/Link 常驻库 + 统一 Gate(阶段 1-3)落地,Cookie 随后。

## 10. 复用的现有基础设施

- 审批:`packages/core/src/tool-system/permission.ts`(InteractiveApprovalBackend / ruleMatches /
  sessionAllowRules)。
- Cookie 桥:`docs/browser-cookie-export-design-2026-06-14.md`(Cookie Lease 全套)。
- env 注入:`engine.ts:2980 readShellEnv`(三层合并范式)。
- MCP 鉴权:`buildHttpHeaders`(两端同源,见 memory `project_mcp_auth_error_ux`)。
- 浏览器分区:`BrowserPanel` 的 `partition="persist:browser"`;main `hardenWebviewGuests`。
- UI:shadcn/ui + Tailwind;弹窗用 DialogProvider 三 hook;反馈用 toast(见 desktop CLAUDE.md +
  memory `project_dialog_unification` / `project_desktop_toast`)。
- 设置子页异步加载:复用 settingsCache 范式避免 loading 闪(见 memory `project_settings_page_loading_flash`)。
