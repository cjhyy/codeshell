# 可扩展账号上下文与配置下发机制

状态：2026-10-27 设计稿。首批目标是账号资料、偏好设置、可用功能，后续通过注册模块
扩展。本轮修复现有账号页面与登录能力恢复；下述 context API、偏好存储和跨端同步尚未
实施，不代表已部署。服务实现归独立 `codeshell-services`，客户端实现归本仓库。

## 当前基础与边界

- 统一网站已有资料、安全、会话、连接和管理员页面。`AccountSessionProvider` 恢复
  `/api/v1/account/web/session`，读取公开身份、overview、CSRF 和固定 cloudTarget。
  登录 grant 随即交换为 Secure/HttpOnly Cookie；原生账号凭据只由 Desktop main 持有。
- 匿名 `/api/v1/account/status` 描述注册、GitHub 登录开关；已登录账号的功能权限来自
  会话/overview。二者保持独立，账号下发不能赋予独立 Hub 的 owner 权限。
- Account 当前没有 preferences 表或 API。Desktop 的 `codeshell.theme` 与
  `codeshell.uiLanguage` 是本机 localStorage；Web SPA 主题跟随系统，PanelHost 的
  locale 目前固定 `zh-CN`，尚无完整网站偏好页或全站国际化消费链。
- Core/Host 的用户与项目 `settings.json` 包含执行配置和授权语义，继续由所属 Host
  管理。账号登录不自动开启遥控、安装插件、共享项目或上传历史。

## 分层与模块注册

会话层只负责认证和会话生命周期；Account context 层投影当前主体的数据；客户端模块
适配器负责校验、合成与应用。登录成功后独立加载 context，避免每次刷新凭据都传递未来
不断增长的配置。context 是数据，不是授权凭据。

服务端模块注册表声明 `id`、支持的 schema 版本、读写权限、允许 scope、字段白名单、
大小限制、投影器、写入器及审计策略。客户端注册表声明支持版本、校验器、应用/清理
适配器、依赖能力和缓存策略。注册发生在审查过的代码/包中；下发内容不能注册脚本、
加载模块 URL 或动态改变权限。新增模块不用修改通用会话和传输逻辑。

| 模块                                | 首批内容                                               | 写入与应用规则                                                                                                                     |
| ----------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `codeshell.account.identity`        | id、username、displayName、role                        | Account 权威；普通资料仍经专用 profile API 修改；role 当前由运营配置 `ACCOUNT_ADMIN_IDS` 推导，只读投影，未来角色管理 API 另立范围 |
| `codeshell.ui.preferences`          | `themeMode: light\|dark\|system`、`uiLanguage: zh\|en` | 用户可写，字段白名单；首版缺省字段表示继承，禁止任意 JSON                                                                          |
| `codeshell.account.capabilities`    | sessions、passwordChange、admin、links 等              | 服务端计算只读；只影响入口展示，实际请求重新鉴权                                                                                   |
| 后续 `codeshell.models.catalog`     | 模型目录、账号权益和配置建议                           | 不包含密钥，不自动覆盖本机模型连接                                                                                                 |
| 后续 `codeshell.skills.catalog`     | 已审查包身份、版本、可用目录                           | 可用不等于安装/启用，使用现有包审查与授权流程                                                                                      |
| 后续 `codeshell.mcp.catalog`        | 目录、要求与凭据引用                                   | 不自动执行 command/env 或连接 URL                                                                                                  |
| 后续 `codeshell.policy.constraints` | 明确受管目标的限制                                     | 管理员独立权限；普通偏好不能写策略或扩大权限                                                                                       |

首批仅 account scope。后续 device/workspace/installation scope 通过注册表显式扩展，
服务端核验稳定 ID 与主体关系；本地绝对路径不是可同步的 scope。Panel 业务模块由
独立 Panel 包拥有，Host 仅提供通用身份、传输与已授权能力，不吸收 Panel 业务 schema。

## 协议与读取

拟增浏览器 `GET /api/v1/account/web/context` 和原生 `GET /api/v1/account/context`，
共用服务端投影器。浏览器沿用固定同源路径、窄路径 Cookie；写操作沿用 CSRF。
原生通过 main 的现有账号认证客户端访问，renderer 只拿公开投影。

现有 transport 不直接兼容本设计：Web 请求路径校验不接受带点的模块路径；原生只允许
已有 PATCH 路径、普通响应限 16 KiB；两端还缺 If-Match 与保留 412 最新模块的结果类型。
实施时增加受限 context transport 适配器：注册模块路径白名单、固定条件头、mutationId、
独立 128 KiB 上限和 typed 412 结果。保留普通请求限制，不开放任意路径或任意 Header。

```json
{
  "version": 1,
  "subject": { "accountOrigin": "https://account.example", "accountId": "uuid" },
  "contextRevision": "opaque-snapshot-revision",
  "modules": {
    "codeshell.ui.preferences": {
      "schemaVersion": 1,
      "revision": "opaque-module-revision",
      "scope": { "kind": "account" },
      "status": "ready",
      "data": { "themeMode": "system", "uiLanguage": "zh" }
    }
  }
}
```

示例省略另外两个首批模块。`version` 表示 envelope 协议；`schemaVersion` 表示模块
结构；`revision` 表示数据版本，客户端只比较相等，不排序或推测其数值。
`contextRevision` 覆盖资料、偏好、角色、服务开关等实际投影依赖的变化；不能只取
preferences 的行版本。投影在一致读取事务中生成，包含当前调用者有权读取的模块。
首版响应上限 128 KiB，偏好 data 上限 4 KiB，未来大型目录改用分页引用接口。

首版完整快照，已注册且受支持的模块明确返回 `ready`、`unavailable`、`reset` 状态。
`ready` 的空偏好对象表示全部继承；`reset` 是明确清除覆盖的 tombstone；`unavailable`
无 data，附稳定原因码。未知模块/不支持版本不应用、不执行、不回写；已知可选模块
校验失败只影响该模块。缺失字段或未来选择性投影不能暗示删除。客户端不 PUT 整份
context，以免旧客户端抹掉新模块。

envelope 不支持、主体不匹配时整份拒绝。安全相关模块缺失、过期或无法识别时关闭
依赖它的远端入口并显示重试/升级状态，本地独立工作不受影响。网络错误保留当前已
确认会话并标记 stale；确认的会话失效按现有认证流程处理。首版使用 `no-store`，
不引入条件 GET；之后优化仍需每次先认证再处理版本。

## 写入、冲突与存储

偏好拟使用 `PATCH /api/v1/account/web/context/modules/codeshell.ui.preferences`；
原生使用对应不含 `/web` 路径。只接受已注册模块和字段的局部补丁，`null` 删除该字段
的账号覆盖。其他模块无通用写权限，资料继续使用专用 API，保留已有验证规则。

1. 写入携带 `If-Match: "<moduleRevision>"`、`expectedAccountId`、当前根会话 ID 与
   有界 `mutationId`。服务端先核验预期账号/根会话与认证 principal 相同；不符返回
   `409 subject_changed`，不写入、不返回另一账号资料。revision 也绑定 origin、账号、
   模块、scope，禁止不同账号用相同版本碰巧通过 CAS。缺少版本返回 428；
   版本不符返回 412 与最新可公开模块，保留用户草稿。
2. 在同一 SQLite 事务校验主体、字段、权限和版本，写入数据，推进 revision 并记录
   脱敏审计。服务端规范化后的模块作为成功结果，也是下次编辑基线。
3. 客户端保留 base/local/remote。远端只改不同字段时，可合并后用最新 revision
   重试一次；同字段并发修改提示选择，不能静默覆盖。模块允许哪些字段自动合并由
   注册表决定，不向未来策略/执行配置套用 UI 偏好规则。
4. mutationId 按账号、scope、模块绑定，记录请求摘要和结果；相同 ID/不同内容拒绝。
   结果未知时先核实该 mutation 或重读，不拿新 revision 盲重放。已撤销会话先拒绝，
   不能因幂等记录而绕过认证。

浏览器 Cookie 可被另一标签页切换，单靠客户端 generation 或晚响应丢弃不能防止服务端
向错误账号写入，故 subject 前置条件必须由服务端核验。现有普通资料 PATCH 没有此新增
前置条件；当前 CSRF/会话边界继续有效，不能宣称已经具备上述新协议的完整写隔离。

首版离线只保留本地草稿，不自动排队写账号。未来离线队列必须携带 origin、accountId、
scope、baseRevision、mutationId，并在同一账号重新确认会话后核实冲突，绝不跨账号重放。

新增 `account_module_values`（account/module/scope 唯一、schemaVersion、revision、
payload、更新时间）及有界 mutation 记录；由固定 SQL/schema 迁移管理。账号删除、备份、
恢复校验和 `recovery-schema` 同步演进，不能只增加一张孤立表。派生能力无需复制成
可写偏好。旧 profile/管理员接口的写入也推进对应 revision；现有 profile PATCH 没有
CAS，兼容期旧客户端仍可覆盖并发资料修改，不能把偏好 CAS 宣称为所有账号写入无冲突。

## 应用规则与账号生命周期

偏好生效顺序：产品默认值 → 当前账号覆盖 → 明确本机覆盖。界面区分“同步到账号”与
“仅此设备”，并显示当前来源；“跟随账号”移除本机覆盖。已保存的旧本机键视为明确
覆盖，缺失键才继承账号值，不能把首次读取的默认值误保存为本机覆盖。

账号偏好作为独立 overlay 应用，不写回 `codeshell.theme`、`codeshell.uiLanguage`
或 settings.json。退出先移除 overlay，恢复设备/匿名基线。非敏感缓存按
origin + accountId + module + schemaVersion + scope 隔离；同 UUID、不同 origin
不是同一个主体。默认只驻留内存；后续离线缓存也不包含身份私密资料或授权能力。

客户端每次读取绑定 origin、账号、会话 generation 和 scope；退出、切换账号、会话
撤销先增加 generation、取消请求和待保存操作、清理当前 overlay。晚到的 A 账号结果
不能应用到 B，也不能在退出后恢复 A 的主题或权限。注销远端失败仍明确显示现有错误，
不把本机清理当成服务端已撤销。

首版在登录/恢复、重新聚焦、保存成功后读取，合并并发刷新，有限超时和独立重试。
相同 revision 不重复 apply；同一代次内也检查模块请求序号，旧请求不能覆盖新结果。
未来 SSE/推送只通知 revision，丢包或重连后重新读取完整快照；通知不携带秘密或授权。
权限始终由每次服务端请求判定，能力缓存只用于显示。实际功能还取决于客户端实现、
Host 能力、项目授权和策略约束，不用一条“账号覆盖本机”的优先级链决定执行权限。

Desktop 主题已有 load/save/apply 分离；语言 `loadUILanguage()` 被多个共享 helper
直接读取，必须接统一 effective resolver，不能只改 I18nProvider。Web 需要真实偏好
消费器、CSS/PanelHost 的主题与 locale 接线及缺失文案支持；存下语言字段不算完成国际化。
OS change/storage 事件也重算 effective 值，不能重新读旧键后抹掉 overlay。Desktop
在登录完成/明确会话恢复路径启动同步，不让现有只读本地的 `status()` 隐式联网。
主题包、音效、窗口布局、工程路径、权限模式与执行环境首批不纳入同步。

## 秘密与扩展约束

后续模块只下发凭据可用状态与不透明 `secretRef`；引用不是 bearer token，持有引用
不能读取秘密。解析发生在已授权 Host/main 或对应服务，使用时重验账号、目标 scope、
用途和撤销。API key、access/refresh token、Cookie、MCP env、带秘密的 URL 不进入
context、通用写接口、日志或同步缓存。目录推荐也不能自动授予安装、连接或执行权限。

## 交付顺序与验收

1. **Account 基础（跨仓）**：冻结三个首批模块 v1；实现注册表、context 投影、preferences
   存储/CAS/审计及备份恢复。旧客户端继续使用现有 session/profile API。
2. **统一 Web**：接 context controller 与 generation 隔离，完成偏好页、来源显示和
   主题/语言实际消费。两浏览器并发写冲突、登录切换及离线恢复通过后再启用。
3. **Desktop**：main 拉取公开投影、renderer 合成 overlay，覆盖所有语言直接消费者，
   验证旧本机设置保留、多个窗口与注销还原。
4. **后续模块**：每项提供 schema、owner、scope、权限、大小/缓存界限、撤销及消费器，
   通过注册表接入。模型/技能/MCP/受管策略分别验收，不与首批 UI 偏好捆绑发布。

最低回归：旧/新客户端、未知模块与版本、异常/超大 payload、身份不符、同 UUID 不同
origin、A→B→A、退出后迟到响应、角色/开关变化、不同字段合并与同字段冲突、超时结果
未知、恢复后的 revision、权限撤销、设备覆盖与退出还原、凭据不出现在响应/缓存/日志。
跨仓服务和客户端固定候选后做真实 HTTPS Cookie、原生 main、安全存储与备份恢复验收；
受控 fixture 证据与正式部署证据分开记录。
