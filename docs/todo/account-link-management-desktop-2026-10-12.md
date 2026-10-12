# 桌面账号归属的 Link 管理

账号设置中增加当前账号的数据连接、使用方、授权操作与资源列表，以及审阅后的
显式撤销。断开连接会撤销其全部 grants；撤销单项 grant 保留连接和其他使用方的权限。
不发起新 OAuth、不创建 grant、不配置 provider token，不改变本地使用无需登录的边界。

服务合同由 Services `b16cf4eafa606e28acc15c1cb5add6a4c4e302ac` / PR #41 提供，见
[服务端合同](https://github.com/cjhyy/codeshell-services/blob/b16cf4eafa606e28acc15c1cb5add6a4c4e302ac/docs/account-link-management.md)。
`linkManagementEnabled` 是兼容可选能力；旧服务或未配置的服务不能误显示为空列表。
完整查询与撤销分别为固定 Account origin 的 `GET /api/v1/account/links` 和
`DELETE /api/v1/account/links/{connections|grants}/:uuid`。普通账号无全局 clients 接口。

Main 独占 Account token，请求先核对 renderer 审阅的 Account origin 和 UUID，再在
credential refresh 前后、HTTPS 返回后复验主窗口/frame、account sessionId 和本机
generation。退出、取消、切号或同 UUID 重新登录均使旧操作失效。renderer 只收严格投影
的公开 metadata；服务返回的未知字段、credential 和 global authority 不下发。
设备授权不能管理 Link。DELETE 不接受额外 body、query 或任意路径。

账号管理仍是八个真实 IPC/invoke：GitHub 登录和绑定使用同一个严格 typed mode 合同，
保留既有 public preload 方法，新增独立 links 操作。没有提高 architecture budgets、
动态隐藏 IPC 或把 mutation 塞入只读 capability channel。

列表仅在明确加载时查询。撤销先展示 provider/account、client、操作/资源与影响范围，
确认后才发送；确认响应必须精确匹配 kind/id，再重新查询。网络或认证错误不能当成功，
保留原列表并要求重新加载核实后才允许下一项撤销；明确确认但刷新失败时保留已证明的
撤销状态与其余列表，并区分错误。账号退出不自动断开已有 Link grants。
已经远端接受的撤销不能因本机退出撤回；重新登录后查询和幂等重试沿服务端合同执行。

仅完整 GET 列表将 native HTTPS 响应上限增至 1 MiB，其他账号请求维持 16 KiB。
公开列表限定 512 connections / 4096 grants，超限明确错误，不截断或伪装没有连接。
TLS、精确 Origin、无 redirect/cookie 继承、固定安全错误文字和 deadline 继续保留。

本地阶段验证：完整 workspace build 通过；六文件组合 44/44、360 assertions，通过真实
native HTTPS、Main 管理器、IPC/frame 围栏、DTO/上界、真实 React 设置交互与实际架构预算。
八个独立私密 HOME renderer 子进程覆盖审阅取消、单 grant/连接级联、加载失败、失联
未知结果、确认后重载失败、切号迟到、同 UUID 快速退出重登，以及 refresh 保留当前列表。
network guard 在产品模块加载前安装，未发任何外部请求。Desktop 全量 typecheck 与
lint 0 errors / 105 warnings 通过；后续组合门禁以最终合并提交的回执为准。

这些证据不表示目标服务器已部署新管理接口、正式安装包已发行、真实 provider / OAuth
已验收或系统钥匙串问题已解决。Cloud 项目管理的 Account authority 接线另行交付。

正常合入输出主线 `11434f1b` 后，组合 `36e839b2` 再次通过完整 workspace build、全部
workspace typecheck、Desktop 生产 build、lint 0 errors / 105 warnings，以及八文件
73/73、439 assertions（含原 sidebar 与 desktop remote services 回归）。Desktop build
重新生成的无关 Chrome extension artifact 已恢复，不纳入本次任务提交。
