# TODO

> 本文件只保留**未完成**的待办；已完成实现与历史验收见 Git 历史和 [能力盘点](docs/architecture/11-feature-inventory.md)。
> 分区规则：**小 feature = 体量 M 及以下（M/S/XS），可单会话直接着手**；**大功能升级 = 体量 L**，需先方案设计再分阶段落地。
> 最近一次核对：2026-10-08。数字人依赖编辑、TUI 子 Agent 待办、记忆提取精修和资源 clone 已完成实现与本地回归，移出本表；实际账号、运行时加载和正式部署验收仍单独保留。历史来源、源码标记、设计文档和未勾验收判定见 [夜间 TODO 核查](docs/todo/2026-09-11-overnight-todo-audit.md)。源码实现不代表已经发布或部署。

> Panel runtime 专项核对：2026-09-13。API 14 通用资源、包内工具、进程回执与 Desktop 后台任务已实现，视频处理业务已迁到面板；本次发布与最终 CI 仍见 [验收矩阵](docs/todo/panel-plugin-runtime-implementation.md)。旧 Host TTS 测试随业务迁至面板，不再作为 Host 功能待办。

## 小 feature（体量 M 及以下）

- **Pet 可靠性修复的运行时加载验收**（S，部署验证）。续办、插件初始化/故障反馈、预算终态、图片保留和提示约束已修复并做本地回归；9 月 21 日补齐微信纯图片路由、Mimi 长回合等待、断线保留消息与工具参数损坏反馈。后续在加载新构建的应用里验证真实插件、微信长回合与同 Session 续办，插件固定版本/预安装入口按发行配置落地。详见 [逐项 TODO 与证据](docs/todo/pet-work-reliability-audit-2026-09-20.md)、[技术方案](docs/todo/pet-work-reliability-design-2026-09-20.md) 和 [微信回合修复与回归](docs/todo/mimi-wechat-turn-lifecycle-2026-09-21.md)。不把源码验收当作已部署，不重放真实账号写操作。
- **Link 真账号 / 真 token 验证**（S，验证任务）。各 provider 仍需授权账号验证 action 响应与错误形状；现有 stub、契约和本地 CLI 测试不能代替真实账号验收。执行时按 provider 单独记录，不写入用户真实数据来代替只读验证。

## 大功能升级（体量 L，分阶段落地）

- **本地／云端项目与跨设备 Panel 完整版本**。工作包、仓库边界和发布门槛见 [总实施清单](docs/todo/project-cloud-panels-plan.md)；完整目标、基线、逐项要求和实际验证见 [交付记录](docs/todo/project-cloud-panels-delivery.md)。包含所有 Panel、项目版本绑定、手机／电脑四组合、独立 Link／services 与部署恢复；环境入口增量不代表全量完成。

- **Panel Host 整合与全部 Panel 服务端可用性**（Hub/Web 专项）。共享后台任务、目录书签、项目版本绑定和 Docker 公共流程已实现；实际安装包、完整 Linux 候选及受控业务流程已有验证。仍缺真实服务商、六 Panel 四种设备／项目组合的完整业务验收，以及旧数据迁移和完整升级回滚。Panel 内部业务与手机界面按 2026-09-27 决定暂缓。独立不可信 Runner 与多租户后置。最新状态以[总实施清单](docs/todo/project-cloud-panels-plan.md)顶部检查点为准；[早期全量验收矩阵](docs/todo/panel-server-workflow-parity-2026-09-18.md)保留为历史基线。
- **独立 Link Server + 双向 OAuth2**。服务仓库已实现单 owner、GitHub 上游适配、下游客户端／同意／PKCE／令牌轮换和撤销；Hub、配对 Web、Electron 云端窗口、原生桌面及真实 Docker 项目已通过受控上游的实际程序验证，第三方原始 token 不下发。遗留 grant 已有持久清理和桌面启动恢复验证。剩余真实 GitHub、物理手机、生产部署和兼容包发布。见 [接入与验证说明](docs/remote-link-host.md)及[总实施清单](docs/todo/project-cloud-panels-plan.md)；宿主本地连接与独立 Link 仍是不同能力。
- **Hub 与 Web 后续**。单管理员、原生云端窗口、项目隔离、稳定设备目录／中继及 Cloud／Link／设备目录恢复已有实现与候选验证。剩余真实目标服务器、域名/TLS、provider 配置、三仓兼容包／镜像正式发布、目标部署恢复／跨版本回滚、实体手机弱网及通知验收；项目路由语义和完整 Panel 适配继续按阶段推进。多用户 Runtime／凭据／CLI HOME 隔离仍后置。见[总实施清单](docs/todo/project-cloud-panels-plan.md)、[共享工作台](docs/todo/shared-web-workbench.md)和 [Web 面板](docs/web-panels.md)。私有候选通过不等于正式上线。
- **Workspace / Profile / 数字人后续**。现有 MVP、Session 绑定、portable memory 读写/编辑、JSON 导入导出和 Git 仓库分发保留。剩余包括项目经验提升为数字人经验的运营流程、受约束的数字人 dream 策略、切换影响预览，以及导出降级为 plugin。自动 dream 目前明确不写 portable profile memory；变更前需要单独确定 ownership 和审批语义。见 [数字人与 Pet 架构](docs/architecture/14-digital-human-and-pet.md) 和 [Profile 历史设计](docs/todo/workspace-profile-讨论稿.md)。
- **Workspace 数据源后续**。mock / mcp-resource / local-files 只读 MVP、Profile 权限求交与复用现有十家 Link 的固定只读视图已实现。剩余是更多查询模型、写操作所需 operation 账本，以及上传文件解析/索引。已有真实 HTTP fixture 不代替真实第三方账号验收；Link 数据源不扩大既有连接授权。见 [数据源 ADR](docs/todo/workspace-datasource-binding-adr.md)及[本轮交付边界](docs/todo/workspace-link-source-permissions-delivery.md)。
- **运行时共享资源与生命周期**。跨 Session 成本汇总和 [AgentModule](docs/todo/agent-module-resolved-composition-design.md) Phase D 的请求边界证据仍待推进。Runtime MCP pool/owner 隔离已有实现；Phase C 的 host→engine→session→run lifetime、disposer、部分失败回滚及各 host 的异步退出已实现，见 [验收记录](docs/todo/agent-module-phase-c-delivery.md)。保留现有隔离边界与成本统计，不为清理占位注释重复创建共享资源。
- **可靠性与评测体系**。统一 Capability/Operation Controller、结构化 VerifiedWriteResult、错误分类/熔断、Skill 列表预算、非核心工具渐进发现、真实长程 cache/notes 回放与按模型评估尚未完整实施。GPT-5.6 hybrid cache 已有短样本真实验证，Responses API / `previous_response_id` 仍是独立评估项。见 [可靠性方案](docs/todo/agent-reliability-and-context-optimization.md)、[Harness 评测](docs/todo/codeshell-harness-evals.md)、[通用评测层](docs/todo/agent-evals-platforms-and-adapters.md)、[优化 Agent](docs/todo/agent-optimization-agent.md)。
- **优化实验室后续**。P1a 文本实验引擎、预算账本、一次反思候选、原版/候选配对比较、效果/diff/成本报告及 Desktop 原生授权页已实现；P1b 完整样本表单、JSON 导入导出和窗口内项目隔离草稿已补齐。自动化验收使用本地假服务，仍需作者授权具体真实模型实验并评价报告价值。P1b 剩余运行证据导入与实验室内试用；P2 补隔离 Agent 试跑、指令快照、范围化采用和回滚。当前默认关闭，候选不进入生效 Skill/Memory/dream，不宣称真实收益或普通任务已采用。见[引擎交付验收](docs/todo/optimization-lab-acceptance-2026-10-08.md)、[样本编辑器](docs/todo/optimization-lab-editor-2026-10-08.md)及[技术方案](docs/todo/optimization-lab-mvp.md)。
- **聊天历史的长程流式恢复**。运行中的快照已淘汰必要流式前缀、或恢复缓冲超限后无法补齐时，当前明确显示恢复失败、保留可见内容并阻止不完整恢复写入缓存；从 durable raw 历史完整恢复正在生成的长段内容仍需后续设计。Mobile 在后台发现新 Main 代次后切回会话时，因保存的 history 与 snapshot 没有共同游标，当前保留 durable 历史并提示实时部分暂不能接续，不直接叠加完整快照；历史返回后，下一个顶层回合开始才恢复实时接收。旧版 peer 未携带 epoch 时仍无法保证跨 Main 重启的游标有效性。本轮有界恢复不等于任意长度、任意历史来源的无缝合并，实现与验证边界见 [夜间核查](docs/todo/2026-09-11-overnight-todo-audit.md)。

## 明确保留、暂不盲改的边界

- **Ink meta/escape 兼容**注释保留到明确 major 迁移策略；不能因为带 TODO 就删除兼容行为。
- **Memory P2 背压 / rate-limit / 注入 cap**按既有产品决策挂起，待真实容量或成本证据触发。
- **外部 CLI 的审批/排队可观测性**受上游 transcript 限制，继续诚实显示可观测状态，不通过猜测补成完整状态。Pet 外部卡片跳转、项目可见性 override 和真实委派终态收尾已实现。
- **Core First**：Arena、Pet、coding 都是独立能力包，经 extension/composition 组合，不反向加回 core 内置业务。
- **quick-chat 不做 Pi 式 parent 指针树状 Session**：快聊是短对话，需要合并时使用 fork/复制派生，不引入树状会话模型。
- **IM Gateway 不做编排大脑 / IM 内富交互审批 / 多租户**：Gateway 负责通道、隧道生命周期与入口回推；已绑定 Session 路由和通知能力保留。
- **同一 Workspace 同时一个 active Profile**；项目专属定制仍放项目指令，项目明确 override 优先。
- **Mimi 工作台不恢复 TodoWrite 聚合**：个人待办由 Mimi 收尾小结和跟进项承载，Session TodoWrite 是执行进度。
- **Mimi 记忆与 core 记忆分开**：不顺手引入置信度分流、待确认收件箱、周月巩固或向量检索；隐形 segment 与 notes 上下文策略保留。
- **服务端先单管理员**：当前不扩展团队租户、per-user worker 或 SSO；显式 passcode-only 兼容入口和 identity/dataRoot 底座保留。
