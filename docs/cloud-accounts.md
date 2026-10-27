# 可选账号与云服务授权

本地 CodeShell 无需登录：聊天、项目、模型配置、工具、MCP 和本地任务不依赖账号
服务可用性。退出账号、token 过期或云服务离线不会删除或停止本地工作。

云账号支持多用户、用户名密码和 GitHub；每人管理自己的设备。Desktop 设置提供
独立账号入口，登录地址固定到 HTTPS origin。账号 token 仅由 main 持有，并用 OS
安全存储加密；renderer 只能读取公开账号状态，不能枚举或导出 token。系统密钥环
不可用时只影响云账号，不阻止本地启动。

第一条接入为设备中继：用户登录目录的账号服务，再明确登记电脑。管理 API 使用
账号 token；控制／数据连接使用绑定账号、电脑、服务 origin 和登录会话的短期设备
token。电脑访问口令、手机配对和目标项目权限继续独立校验。登录本身不启动遥控、
共享项目或上传历史。

access 过期后 main 单次刷新，refresh 轮换并持久保存。连接器在每次控制连接前取得
当前设备 token，同一控制代次的数据连接使用其对应 token。账号退出清除本机账号
状态，停止该账号的中继授权，向服务端撤销根会话和派生设备授权；LAN 和本地任务
不受影响。服务端未确认注销时界面明确报告，不能将仅清本机文件当作远端已撤销。

服务端实现及部署说明在独立 `codeshell-services` 仓库的 `docs/accounts.md`。
旧单管理员中继继续兼容，其 schema 1 不会按用户名自动归到新账号；账号模式使用
schema 2 和明确的新目录／重新登记。Cloud/Link 旧管理员入口、多用户云端 Runtime、
跨进程账号验证和账号模式备份恢复须另外实施，不能从账号登录推断这些能力已完成。

**2026-10-09 源码实施阶段的历史说明：** 当时只修改源码和受控测试，没有替换生产服务、
配置真实 GitHub App 或发布新包。此句不描述后续部署现状。2026-10-26 只读复核确认
Account 已有后续部署与 GitHub 登录/consent/native callback 证据，Link 已升级至
`da73ce5` / schema 3；见[部署追认及未完成边界](remote-link-host.md#2026-10-26-后续部署追认)。
登录成功不能关闭严格单仓读取、OS Keychain、旧 owner 迁移或薄云端恢复演练。

## 统一网站的账号管理与登录下发

统一网站已有账号资料、安全、登录会话和连接页面；管理员另有用户管理、概览和审计。
页面位于 `packages/web/app/AccountSettings.tsx`，账号数据库、资料修改、角色和会话权限
由独立 `codeshell-services/apps/account-server` 提供。独立 Hub 的 `/api/v1/auth/*`
仍是单 owner 认证，不把它扩展成网站多用户账号库。

网站先通过匿名、禁止缓存的 `/api/v1/account/status` 读取注册及 GitHub 登录开关。
登录或恢复会话后，`/api/v1/account/web/session` 返回公开账号资料与角色、会话元数据、
CSRF、账号概览中的安全状态和可用功能，以及管理员配置的固定 `cloudTarget`。
原生登录取得的短暂 grant 随即交换为窄路径的 Secure/HttpOnly Cookie；页面不持久保存
root token。模型密钥、MCP 秘密、Workspace 配置和项目历史不随此响应同步。

公开登录方式读取失败会单独显示错误与重试，密码登录仍可使用。恢复会话、切回窗口、
完成登录和退出时重新读取服务开关；过期请求不能覆盖新结果。资料保存采用服务端
返回的最新资料作为下一次比较基线，连续修改和恢复旧值都能提交。资料修改响应只有
`id`、`username`、`displayName`，权限与角色继续从 session/overview 获取。

账号范围的偏好与后续模块采用[账号上下文机制设计](todo/account-context-distribution-design.md)：
独立模块注册、schema/revision、作用域、CAS 冲突、会话代次和偏好覆盖层；首批拟支持
资料、主题/语言偏好、可用功能。该同步协议尚未实现，现有登录不会自动覆盖本地设置。
2026-10-27 的本轮范围及实际验收见 [Server 第二轮记录](todo/server-flow-optimization-round2-20261027.md)。
