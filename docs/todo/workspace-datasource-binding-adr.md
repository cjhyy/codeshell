# Workspace 数据源绑定 — ADR + 只读 MVP 范围

> 状态：**已评审，待实现**（本文即 DS-01 的交付物）｜日期：2026-07-15
> 输入：`docs/nightly-2026-07-10/large-feature-breakdown.md` §4（DS-01…DS-14）、`docs/todo/mcp-http-auth-oauth-link-tech-design.md`、`docs/todo/credentials-partition-mismatch-plan.md`、`docs/superpowers/specs/2026-07-15-workspace-profile-design.md`
> 用户已拍板（2026-07-15）：①MVP kind = mock + mcp-resource + **local-files（上传）**；②凭证全局、用法项目级；③Profile 求交只定接口不实现；④统一 ListSources/ReadSource 读取面；⑤desktop 做**项目配置中心**页（数据源上传/绑定 + 数字人 + 项目指令 + 能力开关聚合）。

---

## 0. 一句话

给 workspace 一个受控的"资料抽屉"：全局定义连接（SourceDefinition）、项目级声明可见范围（WorkspaceSourceBinding）、运行时求交出实际可读面（EffectiveSourceAccess）；模型只看到源的名称/范围/状态，**读内容必须过显式读取面 + 审批**；项目配置中心页让用户在一个地方上传文件、绑定外部源、管数字人和项目指令。

## 1. 三层模型（ADR-1，核心决策）

```
SourceDefinition（全局库）          "github-work 是一个 mcp-resource 源，用 credentialRef=cred-123"
  └─ WorkspaceSourceBinding（项目级）   "本 workspace 可见 github-work 的 issues + pulls 两个 scope"
       └─ EffectiveSourceAccess（运行时）  binding × source.enabled × credential 状态 ×（future: Profile）× 审批，默认 deny
```

**不把任何东西再塞进 `mcpServers`**；MCP resource 只是 adapter 的一种。

### 1.1 SourceDefinition（全局）

- 存储：全局 store（沿 `model-catalog` 的存储模式），损坏项隔离、versioned schema。
- 字段：`id`（用户可选稳定 slug，命名规则同 WorkspaceProfile：`/^[a-z0-9][a-z0-9_-]{0,63}$/`）、`kind`（`"mock" | "mcp-resource" | "local-files"`）、`label`、`adapterConfig`（按 kind 的配置对象）、`credentialRef?`（指向全局 CredentialStore 的 id）、`enabled`。
- **多账号 = 多实例**（ADR-3 推论）：`github-work` / `github-personal` 是两个 SourceDefinition，各持自己的 credentialRef。不做 per-workspace 凭证。

### 1.2 WorkspaceSourceBinding（项目级）

- 存储：`${cwd}/.code-shell/settings.json` 新增 `sources` 数组（versioned）。**只存 `sourceId + 显式勾选的 scope id 列表 + readPolicy`，绝不存 secret/token**。
- `readPolicy`：`"ask"`（默认，ReadSource 每次审批）| `"deny"`（本 workspace 只允许 list metadata、禁读内容）。**不提供 "allow" 免审批档**——自动放行留给未来与 permission rule 体系统一设计，MVP 不开这个口。
- "全盘授权"必须显式勾选对应 scope，**不能作为无提示默认**。
- source 被删/禁用后 binding 显示 **dangling**（可见的失效状态），绝不静默换源。

### 1.3 EffectiveSourceAccess（运行时）

- 纯 resolver（无 IO 副作用的求交函数 + 状态读取）：`cwd → binding[] × source.enabled × credential 状态 ×（future: activeProfile）→ 可读面`。
- **默认 deny**：不在 binding 里的源/scope 对该 workspace 不存在；UI 隐藏不能充当授权。
- 签名预留 `profile?` 参数（见 §6），本期恒不传。

## 2. 凭证归属（ADR-2）

- 凭证**全局**：继续存现有 CredentialStore（token/link/cookie/oauth 四类，resolver 边界不变），一次登录处处可用。
- 用法**项目级**：哪个 workspace 能用哪个源由 binding 控制；credentialRef 只在 SourceDefinition 层出现。
- 保存 binding 时只校验 source/credential 的 **metadata/type**（不解密）；运行时按现有 credential access 边界 resolve。

## 3. 撤销与失效语义（ADR-4）

| 事件 | 结果 |
|---|---|
| 凭证删除/过期 | 该源下一次 resolve 立即 `unavailable`；ReadSource 拒绝并报状态；日志只含 id 不含 secret |
| SourceDefinition 删除/禁用 | 所有引用它的 binding 显示 `dangling`，列表可见、读取拒绝 |
| binding 移除（unbind） | 该 workspace 对此源立即不可见（下一轮生效，同 settings 热重载粒度） |
| scope 缩小 | 超出新 scope 的 resource 立即不可读 |

## 4. Adapter 边界（ADR-5，防 provider 特判）

统一 `ConnectorAdapter` 接口：

```ts
interface ConnectorAdapter {
  kind: string;
  listScopes(def: SourceDefinition): Promise<SourceScope[]>;          // scope 目录
  listResources(def: SourceDefinition, scopeId: string): Promise<SourceResourceMeta[]>;  // 只 metadata
  read(def: SourceDefinition, resourceId: string, opts: { maxBytes: number }): Promise<SourceContent>;
}
```

MVP 三个实现，core 不出现任何 Figma/Notion 字样：

1. **mock**：本地 fake（2 scope / 3 resource），零外部依赖，进 CI；纵切 e2e 的载体（DS-13）。
2. **mcp-resource**：包装现有 MCP List/Read；`adapterConfig = { server: string }`。
3. **local-files（本轮新增，承接"上传"需求）**：
   - **每个 workspace 隐式自带一个内置源**（如 `id: "project-uploads"`，label "项目文件"），**不进全局 catalog**——上传的文件天然项目本地，三层模型通过"隐式定义 + 默认绑定"保持不破。
   - 文件落 `${cwd}/.code-shell/uploads/`（上传 = 拷贝进该目录；删除 = 移除文件）。
   - scope：MVP 单一 scope（全部上传文件）；未来可按子目录分 scope。
   - 无凭证；但 **read 仍走 ReadSource 审批 + 大小上限 + 不可信包裹**——上传的 PDF/文档同样可能携带注入内容。
   - 路径安全：resourceId 解析必须 canonicalize 并限制在 uploads 目录内（防 `../` 逃逸）。

真实 OAuth provider（Figma/Notion/GitHub…）= 未来新 adapter + Link catalog 条目 + OAuth profile，不改本模型，不阻塞 MVP。

## 5. 读取面与注入面（ADR-6/7）

- 两个 builtin 工具：
  - **ListSources**：只出 metadata（源名/scope/状态/resource 列表的名字与大小），**自动允许**。
  - **ReadSource**：读内容，**默认 ask 审批**；执行时对 source/scope/resource id 做二次校验（防止审批后换参数）；结果带 **provenance 标注（来自哪个源/scope/resource）+ maxBytes 上限 + secret redaction**，内容经 `wrapUntrustedInput` 包裹。
- 注入面：**只在动态上下文**（`buildDynamicContextMessage` 通道，不进可缓存 system 前缀）列已绑定源的名称/scope/可用状态摘要；**无绑定源完全不注入**；内容永不进 system prompt。

## 6. 与 Profile（数字人）求交（ADR-8，只定接口）

- 接口：`WorkspaceProfile` 未来可声明 `requiredSources? / suggestedScopes?`；求交点唯一——`EffectiveSourceAccess` resolver 的 `profile?` 参数：`effective = binding ∩ (profile 声明 ?? 全集)`。
- **Profile 永远不能越过 workspace binding**（只能收窄不能放大）；切数字人下一轮刷新。
- MVP 不实现，resolver 留参不接线（与 WorkspaceProfile 的 `sessionProfile` 缝同一手法）。

## 7. 项目配置中心页（ADR-9，desktop）

按项目维度的独立配置页（不是全局设置页里的散块），聚合：

| 区块 | MVP 内容 | 来源 |
|---|---|---|
| **数据源** | 上传文件（拖拽/选择 → uploads 源）、绑定外部源（选 source + 勾 scope）、状态/解绑/dangling 展示 | 本 feature 新建 |
| **数字人** | 当前激活/切换/关闭 | 复用 `ProfileSection`（已落地） |
| **项目指令** | 查看/编辑 `CLAUDE.md` | 现有文件读写 IPC |
| **能力开关** | project capability overlay | 复用现有 Capabilities 区块 |

MVP 先落**页面框架 + 数据源区块**，数字人/能力区块直接挂现有组件；入口放在项目维度的自然位置（与 TopBar workspace 指示/侧栏项目上下文一致，实现时按现有导航模式选点）。全局 Connections/Link 页保持管"连接定义 + 凭证"（DS-08 数据化），项目页管"本项目用什么"。

## 8. 威胁模型（DS-01 要求）

| 威胁 | 缓解 |
|---|---|
| 源内容 prompt injection（含上传文件） | ReadSource 结果 `wrapUntrustedInput` 包裹 + provenance 标注；list 面只含 metadata |
| secret 泄漏 | project settings 不存 secret；日志只含 id；ReadSource 结果 redaction；credential resolver 边界不变 |
| 跨 workspace 越权读取 | binding 是唯一授权面，resolver 默认 deny；ReadSource 二次校验 id 归属 |
| 过宽授权 | scope 显式勾选，无"全盘"默认；scope 缩小立即生效 |
| dangling 引用被利用 | dangling/unavailable 是显式拒绝状态，不 fallback、不静默换源 |
| 上传目录路径逃逸 | resourceId canonicalize + 限制在 `${cwd}/.code-shell/uploads/` 内 |
| 大文件拖垮上下文 | ReadSource maxBytes 上限 + 超限截断并声明 |

## 9. 只读 MVP 范围（= DS-02→11 + DS-13 + local-files + 项目页）

1. versioned schema/types（SourceDefinition / WorkspaceSourceBinding / scope / readPolicy）
2. 全局 SourceCatalog store（mock + mcp-resource；损坏隔离）
3. local-files 隐式源 + uploads 目录管理（上传/删除/列表）
4. project binding 持久化 + dangling 语义
5. credentialRef 校验 + 撤销传播
6. ConnectorAdapter 接口 + mock / mcp-resource / local-files 三实现
7. EffectiveSourceAccess resolver（默认 deny，`profile?` 留参）
8. ListSources / ReadSource + 审批 + provenance/上限/redaction
9. 动态上下文 metadata 注入（无源不注入）
10. desktop：项目配置中心页框架 + 数据源区块（上传/绑定/scope picker/状态）；全局 Connections UI 数据化（最小：从 store 渲染 + add/disable）
11. mock connector 纵切 e2e：connect→bind→list→approve read→unbind→拒绝
12. 故障测试：凭证过期、source disabled、binding dangling、scope 缩小、路径逃逸、内容超限

### 明确不做（本期）

- ❌ 写操作（对源只读）
- ❌ 真实 OAuth provider adapter（Figma/Notion/GitHub…）
- ❌ Profile 求交实现（只留 resolver 参数）
- ❌ 跨 workspace 共享 binding / 源内容索引与 RAG
- ❌ 上传文件的解析/向量化（模型按需 ReadSource 原文，超限截断）

## 10. 决策记录

- ✅ 三层模型固定；MCP resource 只是 adapter 之一，不塞 `mcpServers`。
- ✅ MVP kind：mock + mcp-resource + local-files（上传）；真实 provider 后置。
- ✅ 凭证全局（CredentialStore），用法项目级（binding）；多账号 = 多 source 实例。
- ✅ Profile 求交只定接口（resolver `profile?` 参数），MVP 不实现。
- ✅ 读取面：统一 ListSources（自动允许，仅 metadata）/ ReadSource（默认 ask + provenance + maxBytes + redaction + untrusted 包裹）。
- ✅ local-files 为 workspace 隐式内置源，文件在 `${cwd}/.code-shell/uploads/`，不进全局 catalog。
- ✅ desktop 做项目配置中心页（数据源 + 数字人 + 项目指令 + 能力开关聚合），MVP 先落框架 + 数据源区块。
- ✅ 注入面只走动态上下文，无源不注入。
