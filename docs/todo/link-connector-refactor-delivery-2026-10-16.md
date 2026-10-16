# Link 重构实施记录

2026-10-16。源码基线：CodeShell main `8c872e4bd`，Services main `acb55b1`。实现分支：`codex/link/connector-refactor-20261016`；Services Figma 分支：`codex/services/figma-action-identity`。用户允许直接清理旧 Link 记录；未授权生产部署或发版。

## 本批范围

- 公共 `packages/link` 提供统一 Operation 类型、50 个审阅契约与五种 recipe。契约记录资源授权、内容覆盖、默认参数、预算与重放规则；CI 比较完整快照和目标基线，既有动作无法通过修改快照静默改变契约。
- LinkAction 接入输入快照、契约校验、必选资源策略与结果过滤；返回 operationId、recipe 和来源信息。可选 content 不决定是否鉴权，创建 Issue 仍检查父仓库。
- Server 的小型运行时负责单次 adapter 调用、输入/输出限制、取消和最终授权复查。HTTP provider 实现通过 Core 空 registry 显式注册；各 Host 和 worker 负责组合。Core SDK 需要消费者显式安装 provider。
- Figma 新动作 `read_design_content` 默认 depth 2，完整文件必须显式 full:true；旧 `get_file` 严格保持 key-only、depth 1、最多 100 页的摘要。独立 Services 同步实现，新名没有自动加入旧 grant。
- token_refresh 区分配置拒绝、invalid_grant 和未知消费结果。只恢复已证实在 token 消费前失败的凭据，禁止重放可能已消耗的 refresh token。本地 OAuth、MCP 与 remote IPC 回执均携带有序状态快照，取消后晚到快照仍按 revision 处理。
- 新连接记录标记 recordSchemaVersion 2，只保存 recipe；旧执行轴由兼容 projection 读取，不能写回新记录。管理 DTO 分开身份授权、契约兼容和近期观测，授权验证时间不冒充动作健康检查。
- operation ledger 新增跨会话、连接和 incarnation 的原子资源冲突保护；缺账号是 wildcard，缺目标证据按 provider 阻断。旧连接删除不删除回执、恢复证据或远端 retirement 队列。

## 清理与运行边界

`code-shell-link-cleanup inspect|remove` 精确识别旧 Link 记录，跳过 recordSchemaVersion 已存在的新记录；保留普通 OAuth/MCP/模型凭据、外部 CLI 登录、聊天、项目与文件。`inspect` 只读，`remove` 在保护账本后 CAS 禁用并删除可见连接，远端授权进入现有私有 retirement custody。

清理工具要求使用这些凭据的 CodeShell Host/Worker 已停止。当前运行的 CodeShell 实例尚未退出，真实凭据尚未清理；不能将外部离线修改描述成已经撤回运行中 Worker 的权限。Codex 无须停止。独立远端 revoke 由既有 Host 恢复机制重试，本地删除不表示远端 revoke 完成。

## 验证与剩余工作

验证使用隔离 HOME、合成凭据和现有精确 origin fixtures；最终组合结果在收口时更新。重点包括 token 消费失败、IPC 乱序与取消、旧服务目录、新旧 Figma scope、选定资源过滤、只发一次的写操作、跨会话冲突、多进程 claim 和精确清理。

P0/P1 已有源码；P2–P4 首批迁移不等于整份设计全部完成。纯 Figma/GitHub 参数与结果 helpers、CLI/MCP 驱动及 verified-write adapter 的领域逻辑仍部分保留在 Core，后续需沿注册接口迁出。旧连接清理为离线维护入口，在线冻结/收口尚未实现。Services 契约包正式固定、生产部署、真实账号、安装包与跨版本回滚分别验收；本批不以 fixture 代替。

Event、Sync、Browser recipe、v2 capabilities/digest 和独立 provider npm 包继续按实际消费者后置。
