# 全量 TODO 实施检查点（2026-10-09）

目标：完成当前未完成待办，优先补齐全部三方 Link。根 `TODO.md` 保留未完成条目；
本文件记录工作包、依赖与验收状态，不将设计、fixture、候选构建视为实际发布。

## 当前实施

| 工作包                | 当前状态                                                                                                      | 完成条件                                                                                                                       |
| --------------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Link 统一授权前置批次 | PR60/64 已合入 main；系统浏览器 broker、一次性消费、取消／过期与云端交接已验证                                | 真实 provider 应用与账号另验收；不以 fixture 代替已登录账号                                                                    |
| 全部远程 Link         | Host PR61、services PR18/19、Host PR63 已合并；10 provider 的 26 个原动作及 GitHub 新增 3 动作已实现          | 固定可信 adapter、账号／作用域／资源过滤与续期；九家缺少应用配置和真实账号验证，不能公开为可连接                               |
| Services 公开包兼容   | PR17 已合入 main，固定五个公开包为 0.9.26；目标 Link 已升级 82d0e4d/schema 3 并完成 GitHub 真实只读及离线恢复 | 同版本五包、完整能力/资产检查、Node 22 服务测试、浏览器授权、容器及恢复验收；记录准确包集与部署版本                            |
| Runtime Phase C       | PR62 已通过全部 9 项 CI 并合入 main；真实资源 ownership／关闭路径已验收                                       | host/engine/session/run scope、逆序幂等释放、部分激活回滚、identity disposer、真实关闭路径、两 Engine 隔离及所有 Host 组合验证 |
| 跨 Session 成本       | PR68 全部 9 项 CI 通过并合入 main；receipt ledger、恢复隔离、SDK/stdio/TUI 及现有活动记录入口已验证           | 完整 GUI 与真实账单对照另验收；unknown、估算及自定义 fetch 内部重试限制见专项交付记录                                          |
| Runtime Phase D       | PR73 已合入 main；实际投影、持久请求边界、私有 Host 签名与 Linux 真实 SecretService 验收通过                  | fetch 锚点不证明远端收到／收费；macOS 真实 OS 钥匙串验收尚未完成                                                               |
| Workspace / Link 只读 | PR65 已合入 main；Profile 求交、十家 provider 固定视图及原生 ToolExecutor 链已验证                            | 不扩大已有连接与 grant；跨文件／语义检索及 OCR 另行推进                                                                        |
| 上传解析／索引        | PR70 已合入 main；有界 Office/PDF 解析、词法分块、冷缓存重验和逐文件权限通过 12 项 CI                         | Core PDF 需 Node 22.13+ 和可选 parser；Desktop 使用已验证 managed Node；不是 OCR 或语义索引                                    |
| Skill 列表预算        | PR72 已合入 main；上下文 1%／最多 2,048 估算 token、排序、按权限搜索与分页通过 12 项 CI                       | 非核心工具渐进发现仍独立开发；不把估算 token 当作精确 tokenizer 结果                                                           |
| 优化实验室 P1b/P2     | PR67/71 已合入 main；无工具 Agent、指令快照、原生范围化采用与撤销、11 条 signer 清理路径已验证                | 默认关闭；不覆盖有工具任务或真实收益。临时执行不落盘，授权报告／预算／receipt 持久化                                           |
| 写操作控制            | PR69 已合入 main；持久 operation ledger、单次 claim、GitHub create_issue 独立回读通过实际 SDK/HTTP            | CLI 写入已在 PR77 禁用；早期 fake CLI 证据只证明调用／隔离，不能证明真实 gh 的传输安全                                         |
| GitHub 仓库／Star     | Host PR77 与 services PR21 已合并；单目标 desired state、独立身份／状态回读与 unknown/restart 不重发已验证    | services PR21 未部署；新动作必须显式授权。其他 provider 写语义、批量、人工 reconcile 和保留策略待推进                          |

最终组合按 PR73 → PR71 → PR77 顺序接纳。对应精确 head 为 `f8abbc05`、`adc42100`、
`8817b208`，分别通过全部 12 项必需 CI；最后一项与当前 main 的合并树逐字节一致。
Core-engine 1,775／13 skip、Core-rest 2,946、rest 4,421／80 skip、Desktop 4,771／68 skip、
Windows 75 均有完整零失败报告，三个浏览器 driver 独立分片也通过。原生包验收为
9 个 tarball／47 个类型入口／45 个运行入口。SDK、真实 stdio worker、TUI、Star、issue
和 P2 编译后消费者均在 Core 导入前设置私有环境并验证实际子进程回执。

Linux Electron 使用私有 GNOME SecretService、移除 Playwright 的明文／模拟钥匙串开关，
独立核验 5 logical／6 physical 请求与 1 个加密密钥；强制不可用时新增 provider 请求为零。
早期 macOS mock-keychain 结果不计为真实 OS 托管证据；修正后真实 SafeStorage 调用未完成，
已结束自有测试进程，保留待验收状态。完整 CI 见
[PR73](https://github.com/cjhyy/codeshell/pull/73)、
[PR71](https://github.com/cjhyy/codeshell/pull/71)及
[PR77](https://github.com/cjhyy/codeshell/pull/77)。本轮 Host 准备 0.9.27，正式产物以 Release 为准。

当前服务器 Link 已升级为 services `82d0e4d`，健康检查返回 schema 3，HTTPS 证书验证通过。
原有 GitHub 连接在停机维护中完成一次自动续期、原账号校验、资源发现和现有 grant 下的
只读调用；既有账号绑定、客户端和授权关系保持不变。在线／停机／升级后备份及新旧工具
离线恢复通过，密钥另存 root 私有备份；不把离线恢复当成实际线上降级。完整证据见
[目标 Link 验收](https://github.com/cjhyy/codeshell-services/blob/0469c4b87e14b4816c304bfbec4d314fd5c46781/docs/link-target-acceptance-2026-10-09.md)。VPN 路径问题通过
单连接绑定物理网卡解决，不修改系统路由或关闭证书验证。生产私密配置只确认已配置
GitHub OAuth；其余 provider 应用配置和真实账号验收仍待提供，不能以受控上游替代。
继续保留现有密钥、数据与可恢复备份，遵守迁移和跨版本回滚限制。

## 后续工作包

1. 跨 Session 成本的完整 GUI／真实账单验收，以及 macOS 真实 OS 钥匙串验收。
   Runtime MCP pool 已有实现，补核多 Session/项目隔离、释放和汇总展示，避免重复重建。
2. Workspace 跨文件／语义查询及 OCR；上传解析／索引、Profile 求交与现有 Link 只读视图已实现。
   写操作的其他 provider 语义、批量 slots、人工 reconcile 与账本保留策略仍待逐项接入。
3. 更多真实工具的后置验证和错误预算适配、非核心工具渐进发现，以及真实长程与按模型
   配对评测、通用评测 adapter。Skill 预算已实现；工具发现仍在独立分支，未纳入本轮发布。
4. 优化实验室真实模型实验、报告价值评价和有工具的任务试验，须按原授权要求完成。
5. 数字人经验提升流程、切换影响预览与 plugin 降级导出。
   受约束 dream 先确定 ownership/审批，不自动写 portable profile memory。
6. Durable 流式 journal、共同游标、分页恢复和重启代次映射，覆盖超出原有缓冲上限的
   长输出、断线和 Main 重启。独立分支正在验证真实消费者，尚未合入或纳入本轮发布；
   不能通过单纯扩大内存上限宣布完成。
7. Cloud/Link/设备中继的兼容公开包与镜像、目标服务器部署、真实业务、恢复与升级回滚。
   六 Panel 四组合、真实第三方账号、实体手机弱网/后台恢复/通知和 Pet 实际加载验收
   分别记录；未执行的项目继续留在 TODO。

## 保留既有产品边界

Panel 内部业务和手机界面按 2026-09-27 决定暂缓；不可信 Runner、多租户/SSO、
Memory P2、quick-chat 树状 Session、IM 编排大脑、同 Workspace 多 active Profile、
Mimi TodoWrite 聚合及向量记忆不因“全部 TODO”自动翻案。跨仓职责仍以各仓库说明为准。
侧边栏精简已合入 main；任务中心和其他低频功能继续从设置访问，不因新接入增添入口。
