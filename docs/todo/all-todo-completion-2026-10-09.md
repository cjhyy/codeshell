# 全量 TODO 实施检查点（2026-10-09）

目标：完成当前未完成待办，优先补齐全部三方 Link。根 `TODO.md` 保留未完成条目；
本文件记录工作包、依赖与验收状态，不将设计、fixture、候选构建视为实际发布。

## 当前实施

| 工作包                | 当前状态                                                                                                                             | 完成条件                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Link 统一授权前置批次 | 已合入 main（PR60）；系统浏览器 broker、一次性消费与云端交接已合入 PR64                                                              | Desktop/Web/Host 授权、取消/过期/重试、CLI 安装与登录、系统浏览器回调、发布声明和 CI 均通过后合入远端 main                     |
| 全部远程 Link         | Host PR61 和 services PR18 已合入各自 main，10 provider／26 action 跨仓验证通过；services PR19 凭据托管及 Host PR63 本地续期也已合入 | 固定可信 adapter、账号/作用域/资源过滤、逐家协议与刷新、全部 action、错误/越权/取消/分页验证；未配置的 provider 不公开为可连接 |
| Services 公开包兼容   | PR17 已合入 main，固定五个公开包为 0.9.26；目标 Link 已升级 82d0e4d/schema 3 并完成 GitHub 真实只读及离线恢复                        | 同版本五包、完整能力/资产检查、Node 22 服务测试、浏览器授权、容器及恢复验收；记录准确包集与部署版本                            |
| Runtime Phase C       | PR62 已通过全部 9 项 CI 并合入 main；真实资源 ownership／关闭路径已验收                                                              | host/engine/session/run scope、逆序幂等释放、部分激活回滚、identity disposer、真实关闭路径、两 Engine 隔离及所有 Host 组合验证 |
| 跨 Session 成本       | PR68 全部 9 项 CI 通过并合入 main；receipt ledger、恢复隔离、SDK/stdio/TUI 及现有活动记录入口已验证                                  | 完整 GUI 与真实账单对照另验收；unknown、估算及自定义 fetch 内部重试限制见专项交付记录                                          |
| Workspace / Link 只读 | PR65 已合入 main；Profile 求交、十家 provider 的固定视图及原生 ToolExecutor 链已验证                                                 | 上传解析/索引继续独立交付；不扩大已有连接与 grant 授权                                                                         |
| 优化实验室 P1b        | PR67 已合入 main；运行证据导入与固定候选试用通过原生 Electron/worker 验证                                                            | P2 隔离 Agent、指令快照、采用/回滚与真实实验仍单独验收                                                                         |
| 写操作控制            | 已实现持久 operation ledger、能力解析、单次 claim 和 GitHub create_issue 独立回读；Node SDK/HTTP/CLI fixtures 已验证                 | 其他 provider 写语义、批量 slots、人工 reconcile、保留策略及真实账号按专项边界推进                                             |

当前服务器 Link 已升级为 services `82d0e4d`，健康检查返回 schema 3，HTTPS 证书验证通过。
原有 GitHub 连接在停机维护中完成一次自动续期、原账号校验、资源发现和现有 grant 下的
只读调用；既有账号绑定、客户端和授权关系保持不变。在线／停机／升级后备份及新旧工具
离线恢复通过，密钥另存 root 私有备份；不把离线恢复当成实际线上降级。完整证据见
[目标 Link 验收](https://github.com/cjhyy/codeshell-services/blob/0469c4b87e14b4816c304bfbec4d314fd5c46781/docs/link-target-acceptance-2026-10-09.md)。VPN 路径问题通过
单连接绑定物理网卡解决，不修改系统路由或关闭证书验证。生产私密配置只确认已配置
GitHub OAuth；其余 provider 应用配置和真实账号验收仍待提供，不能以受控上游替代。
继续保留现有密钥、数据与可恢复备份，遵守迁移和跨版本回滚限制。

## 后续工作包

1. Runtime Phase D 的请求边界与持久证据；跨 Session 成本的完整 GUI/真实账单验收。
   Runtime MCP pool 已有实现，补核多 Session/项目隔离、释放和汇总展示，避免重复重建。
2. Workspace 数据源的上传解析/索引及更多查询模型；Profile 求交与现有 Link 只读视图已实现。
   写操作的其他 provider 语义、批量 slots、人工 reconcile 与账本保留策略仍待逐项接入。
3. 更多真实工具的后置验证和错误预算适配、Skill 预算、
   非核心工具渐进发现，以及真实长程与按模型配对评测、通用评测 adapter。
4. 优化实验室 P2 隔离 Agent、指令快照、
   范围化采用和回滚。真实付费模型实验及报告价值评价须按原授权要求完成。
5. 数字人经验提升流程、切换影响预览与 plugin 降级导出。
   受约束 dream 先确定 ownership/审批，不自动写 portable profile memory。
6. Durable 流式 journal、共同游标、分页恢复和重启代次映射，覆盖超出原有缓冲上限的
   长输出、断线和 Main 重启；不能通过单纯扩大内存上限宣布完成。
7. Cloud/Link/设备中继的兼容公开包与镜像、目标服务器部署、真实业务、恢复与升级回滚。
   六 Panel 四组合、真实第三方账号、实体手机弱网/后台恢复/通知和 Pet 实际加载验收
   分别记录；未执行的项目继续留在 TODO。

## 保留既有产品边界

Panel 内部业务和手机界面按 2026-09-27 决定暂缓；不可信 Runner、多租户/SSO、
Memory P2、quick-chat 树状 Session、IM 编排大脑、同 Workspace 多 active Profile、
Mimi TodoWrite 聚合及向量记忆不因“全部 TODO”自动翻案。跨仓职责仍以各仓库说明为准。
侧边栏精简已合入 main；任务中心和其他低频功能继续从设置访问，不因新接入增添入口。
