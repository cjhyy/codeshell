# Workspace 数据源 Profile 权限与 Link 只读视图

2026-10-09。本轮源码实现复用现有设置入口；不新增侧栏。本轮不含写操作、上传解析/索引、任意查询及新增服务商；随后完成的有界上传解析/逐文件词法索引见[独立交付边界](workspace-upload-document-index-delivery.md)。

Profile 的 `sourceAccess` 省略继承 workspace binding，显式空数组拒绝所有源（含项目上传）。声明的 source/scopes 只取交集，任意 deny 禁读。Session pin 优先，缺失 Profile fail-closed。项目预览、动态摘要和工具统一求交；读取和 metadata await 结束时复查当前绑定、源定义、Profile revision 与 live pin。

Link 类型固定一个连接、一个已审查只读动作和参数：

```json
{
  "id": "team-issues",
  "kind": "link",
  "label": "Team issues",
  "credentialRef": "saved-connection-id",
  "adapterConfig": {
    "providerId": "github",
    "action": "list_issues",
    "params": { "owner": "acme", "repo": "docs", "limit": 20 }
  },
  "enabled": true
}
```

项目绑定 `team-issues` 的 `github:list_issues` scope 后，读取唯一 `result` resource。ListSources 只列固定视图 metadata，不请求外部数据。全局凭证按所属工具 settingsScope 解析；项目/隔离执行不能借源升级为 full。十家 provider 的现有 25 个 discovery/read 动作可用，写动作配置和执行均拒绝。Figma 仍要求明确 file key；授权资源与查询限制继续由现有 Link 实现执行。

ReadSource 的许可与 LinkAction/grant 许可必须同时成立。所属 ToolExecutor 提供受约束嵌套调用，继续执行统一 permission/hooks/visibility/capability/allowedToolNames/审计，不伪造审批；固定参数禁止 hook 替换。无 executor seam 的直接 adapter 读取 fail-closed。在嵌套审批结束、真实 IO 前复查 source/binding/Profile 与账户/grant/resource revision。正常刷新仍使用原授权，连接撤销或结果返回时权限改变则不发布内容。

本地 browser OAuth 的 reconnect/refreshing、invalid/missing、expired 且不可刷新均显示 unavailable；只读 metadata 检查不解析 token，不刷新。旧 PAT/CLI 连接保持兼容。账号/grant/resource revision 同时包含 masked OAuth 的公开 clientId/tokenEndpoint/scope，能拒绝审批期间的 client/config 替换；正常轮换 token 的值和到期时间不进入指纹。

验证包括 Profile 求交/Session pin/库 revision、审批和 IO 期间撤销、同连接 ID 替换 grant、LinkAction 整体及 provider/action/connection deny、capability off/执行列表限制、hook 写入改参、顺序单槽队列嵌套，以及 256 KiB/secret redaction/untrusted 包裹既有回归。十家/25 动作测试注入 CredentialAccess 执行 seam；本地 GitHub 使用真实 provider HTTP adapter 加 fetch fixture。另一个 localhost 测试实际经过 OAuth callback、加密凭证接口、ReadSource 双重审批、remote refresh 和资源过滤的生产模块。

上述 fixture 使用合成账号和上游响应，不是十家真实账号验收，不新增生产 provider 配置，不执行真实账号写操作。发布/部署与真实服务验收分别记录。

最终与 `61fa95bd` 主线组合后，Source/Link/Profile、完整 tool-system 与相关 Desktop 表单回归共 1,482 pass / 3 skip / 0 fail（158 个文件）；跳过的是既有真实 LLM 连续输入测试。12 个包类型检查、runtime build、Desktop main/preload/renderer/mobile build 和改动文件 ESLint 均通过。此前本分支 package release 门槛验证了 9 个 tarball、47 个带类型入口；随后主线组合补做上述相关检查。

复查补强固定输入：hook 持有的 nested params 在凭证解析 await 期间不能改变真实请求目标。最终约束校验后从固定 JSON 建立独立 handler 快照，记录与执行使用同一快照；新增生产 GitHub fetch 回归修复前会请求错误仓库，修复后保持原 owner/repo。相关 Source/Link/executor 共 214 项回归、Core 类型与改动文件 lint 通过。

降级必须保留匹配版本的数据备份。旧 binary 不认识 `sourceAccess`，会忽略此限制；旧目录编辑器不理解 `link` kind，也可能丢弃该定义。不能只回滚代码并继续使用这些新授权数据。降级前应先撤销或收窄项目 binding，并核验旧运行时的实际可读面；源目录、Profile 和连接备份要与恢复版本匹配，不能宣称旧版本保留本轮授权求交。
