# 已有项目本地与云端运行技术方案

状态：技术设计草案，本文新增能力尚未实施。日期：2026-10-12。

代码基线：原生云端客户端核验于本地 `main` 的 `7a79b53b`；后端项目容器核验于同一提交，并对照 `origin/main` 的 `17501c75`。后者的账号与 Link 管理增量按各自既有边界衔接。原生接入的本地提交不代表已发布版本。

## 1 目标与核心决策

在侧栏已有项目中使用同一套聊天界面，选择“此计算机”或“云端”执行。项目保留身份、说明、仓库关联与配置；会话保存实际执行位置；云端为新会话准备独立工作区。关闭桌面客户端不影响已接受的云端任务。

推荐采用“稳定项目 + 固定会话目标 + 持久工作区 + 可重建执行实例”的模型。首版为自托管、单控制平面、单 owner 信任域，使用现有 Node Server 和 Docker 执行器。Provider 接口为未来 VM 执行器留出扩展点。

| 决策                           | 具体含义                                                                    |
| ------------------------------ | --------------------------------------------------------------------------- |
| 项目默认值与会话目标分离       | 改项目默认值只影响下一条新会话；打开旧会话不修改默认值                      |
| 首次创建前锁定目标             | 请求发送前持久锁定 pending target；服务端创建后永久固定，换位置继续另建会话 |
| 一条顶层云端会话一个工作区     | 后续多轮对话复用工作区；并行顶层会话有独立文件、`.git` 和 HOME              |
| 环境模板与运行实例分离         | 模板 revision 不可变；任务文件和执行进程分别保留、恢复和回收                |
| 连接生命周期与任务生命周期分离 | 关闭窗口、WebSocket 断开、重新登录不自动取消已接受的任务                    |
| 增量迁移                       | 旧项目容器继续使用，新会话逐步走 V2，原 ID、历史和数据卷保留                |
| Core 保持领域无关              | Git 与仓库工作流属于 coding 能力；Server 管理身份、资源和生命周期           |

本方案建设 CodeShell 自己的云端执行服务。Codex 和 Claude Code 的公开行为作为产品与隔离设计参考，不接入两家的私有云 API。既有外部 Agent runtime 可以作为 coding 能力在获准的执行环境中运行。

首期交付集中于原生聊天、流式输出、审批、取消、历史恢复、隔离工作区及成果取回。远程终端、全部 Panel 业务、自动跨位置迁移、多节点调度与公开不可信多租户分别验收，不并入“选择云端即可获得”的承诺。

## 2 当前实现及缺口

原生桌面已经能登录远端服务、把已有本地项目关联到已有云端项目，并在原生 ChatView 中运行云端聊天。连接使用 Main 持有的认证状态和受限 IPC；本地与云端历史及文件操作已有隔离措施。

| 当前实现                                         | 缺口                                                 | 核验位置                                                                                                                                                         |
| ------------------------------------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectRuntimeSelection.bindingId` 保存项目选择 | 同时影响当前历史和执行路由，缺少会话固定 target      | [project-runtime.ts](../../packages/desktop/src/shared/project-runtime.ts)、[App.tsx](../../packages/desktop/src/renderer/App.tsx)                               |
| `CloudEnvironmentDescriptor.kind = project-host` | `environmentId` 是服务安装身份，不是可复用环境模板   | [cloud-environment.ts](../../packages/desktop/src/shared/cloud-environment.ts)、[control-server.ts](../../packages/server/src/project-runtime/control-server.ts) |
| `ProjectRuntimeProvider.ensure(project)`         | 项目和执行实例一对一，不能分配会话工作区             | [types.ts](../../packages/server/src/project-runtime/types.ts)                                                                                                   |
| 容器及 data/workspace volume 按项目命名          | 同一云端项目的会话共享文件、分支、依赖和配置         | [docker-provider.ts](../../packages/server/src/project-runtime/docker-provider.ts)                                                                               |
| managed entry 固定 `/workspace`                  | 可以继续用于单工作区 Host，不能放开任意客户端 cwd    | [managed-entry.ts](../../packages/server/src/project-runtime/managed-entry.ts)                                                                                   |
| 控制面 reconcile 与关闭会停止旧项目容器          | 控制服务重启尚不能承诺任务继续                       | [manager.ts](../../packages/server/src/project-runtime/manager.ts)                                                                                               |
| Core 有持久输出 journal 和 cursor                | 能恢复已持久输出，不保证任意进程或工具自动续跑       | [output-journal.ts](../../packages/core/src/session/output-journal.ts)                                                                                           |
| 独立服务已有可选账号与设备授权                   | 多用户登录不等于多用户执行隔离，不能按用户名合并身份 | [账号边界](../cloud-accounts.md)                                                                                                                                 |

因此保留已完成的原生接入、认证边界与 Core 协议，主要新增会话目录、环境模板、工作区管理和任务执行账本。

## 3 项目内交互

侧栏保留已有项目。项目菜单提供“默认运行位置”，输入区提供当前新草稿的“运行于：此计算机／云端”。第一次选云端时，在原生对话框中完成服务关联、登录、选择项目关联和已发布环境。环境准备与管理留在项目设置中；正常聊天继续使用当前窗口。

项目下展示统一会话目录，每条会话标明“此计算机”或具体云主机，允许筛选。筛选只影响展示，不改写会话归属。旧会话顶部显示固定位置；打开它始终根据会话记录路由。项目默认云端时，仍可打开旧本地会话，而且默认值保持云端。

| 用户动作                     | 行为                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| 修改已有项目的默认位置       | 下一条新草稿采用新默认值；已有会话与后台任务保持原目标                           |
| 在新草稿选择另一个位置       | 保存当前草稿，恢复该目标的草稿；附件需要重新取得对应目标的授权                   |
| 云端任务运行时打开本地会话   | 本地会话正常使用；云端继续，返回时恢复输出                                       |
| 打开已停止工作区的旧云端会话 | 显示原工作区状态，显式恢复同一工作区，不创建替代工作区                           |
| 云端登录过期或离线           | 保留原目标和草稿；禁发送、审批，提供原服务重新登录／连接                         |
| 关联被移除或主机身份改变     | 保留历史，显示关联失效或身份不匹配，禁止换成本机运行                             |
| 需要在另一位置继续           | 独立“在云端继续／在此计算机继续”流程，预览代码与上下文，生成新会话并保留来源关联 |

草稿由 Main 的持久 DraftStore 按 `(clientProjectId, authorityId, authProfileId, draftTarget)` 保存，不能只存于 renderer 内存 Map。文本、模型选择和附件元数据用 revision/CAS 防止迟到写入覆盖；附件 handle 带目标、主体及有效期，重载或登录变化后复核。文件句柄失效时显示“需要重新选择文件”，不能凭旧路径自动重获权限。更换运行位置不复制历史、工作目录、未提交修改、插件、MCP、凭据或审批授权。选择本地附件后上传前明确显示目标；远端附件和资源也不能按本地路径打开。

首次创建请求未确认时，原 pending target 保持锁定。用户可打开别的会话或独立新草稿，不能把原提交改发到另一位置。只有请求确定未发送，或服务端按 createRequestId 确认未创建并建立撤销 tombstone，才恢复该草稿的目标选择；迟到 create 必须被拒绝。

保留历史指保留原服务端记录及本机已知目录／允许的缓存；撤销访问后不承诺仍能拉取完整远端历史。离线副本若存在，显示最后同步时间和只读状态，不冒充当前远端权威状态。

“在另一位置继续”后置于成果取回闭环之后。首期保持旧会话原地继续，不承诺会话原位迁移或双向实时同步。

## 4 目标架构与职责

![拟议运行架构](project-cloud-runtime-v2/codeshell-cloud-runtime-v2-plan.svg)

图中 `EnvironmentRevision` 对应下文 `EnvironmentTemplateRevision`，`TaskWorkspace` 对应 `Workspace`。

| 层                      | 职责                                                                  | 归属                                                              |
| ----------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 原生体验                | 项目默认值、统一会话目录、草稿、聊天、运行状态                        | `packages/desktop` renderer                                       |
| Runtime Gateway         | opaque handle、IPC 校验、认证、能力裁剪、目标与事件路由               | Desktop main/preload；复用 `packages/web` 事件归约                |
| Cloud 控制面            | 项目授权、模板版本、会话目录、工作区、Operation、RunReceipt、资源配额 | `packages/server` 的纯 Node 模块；部署组合在 `codeshell-services` |
| Workspace Manager       | 准备、启动、接管、停止、归档、清理和一致性对账                        | `packages/server`                                                 |
| Runtime Provider        | 资源受限的执行实例、卷、网络、实例身份与观测                          | 首版 Docker；后续可替换 VM Provider                               |
| Worker Host             | 单工作区 Core Worker、事件、审批和工具执行                            | 现有 managed/headless Host 的工作区作用域适配                     |
| Source/Artifact Adapter | Git clone、branch、diff、patch、非 Git 输入与产物                     | coding 包或其他能力包，通过 reviewed adapter 接口                 |
| 账号与 Link             | 上游身份、授权、第三方凭据和受限连接                                  | 现有独立 services；不搬进 Core 或 renderer                        |

保留现有受限 Core RPC，不把 headless Host 扩成客户端指定任意 cwd 的多租户路由器。V2 实例内仍是一个受控 workspace；跨 workspace 的调度放在控制面。

## 5 数据模型和身份

以下为拟议契约，字段名在实施前以共享 schema 固化。

| 实体                          | 关键字段与约束                                                                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ProjectExecutionPreference`  | `clientProjectId, defaultTarget`；继续使用已有 `LocalProject.id`，仅播种新草稿                                                            |
| `CloudHost`                   | `hostId, origin, authorityRef`；hostId 对应当前 installation/environment 身份                                                             |
| `CloudProjectBinding`         | 保留已有 `bindingId, localProjectId, remoteProjectId, origin`；新增显式 `hostId, authorityId, authProfileId, principalKey`，不重建旧 UUID |
| `EnvironmentTemplateRevision` | `templateId, revisionId, projectId, imageDigest, capabilitySet, resources, networkPolicyRef, setupSpec, secretRefs`；revision 不可变      |
| `SourceSnapshot`              | `snapshotId, kind, digest, manifestRef`；Git 输入额外固定 repo 与 commit SHA，不只记 branch 名                                            |
| `ConversationRecord`          | UI conversation UUID、clientProjectId、远端 conversationId、固定 target、engineSessionId、parentConversationId                            |
| `Workspace`                   | `workspaceId, serverProjectId, conversationId, templateRevisionId, sourceSnapshotId, storageRefs, mode, retention`                        |
| `RuntimeLease`                | `runtimeId, workspaceId, provider, incarnation, controllerEpoch, providerRef, state, heartbeat`；实例可重建                               |
| `Submission`                  | `submissionId, conversationId, clientMessageId, payloadDigest, inputRefs, sequence`；一条用户输入的持久身份                               |
| `RunAttempt`                  | `attemptId, submissionId, attemptNo, retryOfAttemptId, resumeRequestId, engineRunId, incarnation, state, outputCursor, terminalReason`    |
| `Artifact`                    | `artifactId, workspaceId, attemptId, digest, bytes, mediaType, manifestRef, retention`；下载使用资源 handle                               |
| `Operation`                   | 异步准备／启动／归档的持久步骤、重试次数和错误；不依赖客户端长连接存活                                                                    |

```ts
type ConversationTarget =
  | {
      kind: "local";
      hostId: string;
      localProjectId: string;
      workspaceId: string;
    }
  | {
      kind: "cloud";
      bindingId: string;
      hostId: string;
      authorityId: string;
      authProfileId: string;
      principalKey: string;
      remoteProjectId: string;
      environmentRevisionId: string | null; // 旧共享工作区允许为空
      workspaceId: string;
      workspaceMode: "isolated" | "legacy-project";
    };
```

本地 workspaceId 由现有目录／worktree 身份解析，不要求所有本地会话新建隔离目录。云端 `isolated` 才要求独占工作卷。顶层云端会话创建一个 Workspace；普通子 Agent 继承它，需要文件隔离的子任务显式申请 child Workspace。

`hostId`、`templateId`、`revisionId`、`workspaceId`、`engineSessionId` 和 runtime incarnation 各有独立含义。不能把当前 `environmentId` 改解释为模板 ID，也不能把项目 generation 当作环境 revision。

服务端授权主体使用验证后的 `{issuer, subject}`，不接受 renderer 传来的 owner 字符串。首期 legacy owner 使用独立命名空间；其与账号服务 subject 的关联须显式验证和迁移，不能按同名 username 自动合并。所有云端实体和请求受服务端 project ACL 限制。

binding 和 conversation route 同时绑定认证 profile 与已验证主体。当前仅按 origin 隔离的认证 partition 需升级为 origin + authProfileId；同 origin 切换账号、退出、撤销或 authority 改变时，Main 撤销旧 RuntimeHandle、连接与审批权。旧主体缓存可按原 scope 保留，但不得用于新主体发送或展示为新主体的实时状态。legacy binding 在重新验证主体前标 unresolved，不能填一个猜测的账号 ID。

事件、审批、缓存至少绑定：

```text
authority + principal + hostId + serverProjectId
  + conversationId + workspaceId + attemptId + incarnation
```

客户端目录可保留旧 `cloud:<bindingId>:<engineSessionId>` 展示 ID 的兼容映射，但执行权只根据结构化 target 和 Main handle 判定。engineSessionId 在 workspace 内有效，不能单独作为全局缓存键。

## 6 环境准备和代码来源

环境模板包含固定镜像 digest、能力包版本、资源和网络限制、安装／启动定义及凭据引用。发布生成不可变 revision；更新模板只影响后续创建，旧工作区继续使用原 revision。首版允许管理员准备并发布模板，不依赖模型自动完成环境搭建。

输入通过领域中立 `SourceSnapshot` 传给准备器。coding adapter 负责将仓库 selector 解析成固定 commit 和清单；通用 Agent 可以使用空目录或受控文件输入，不强制每个项目都是 Git 仓库。

| 来源                  | 默认策略                                                                                      |
| --------------------- | --------------------------------------------------------------------------------------------- |
| 远端 Git 仓库         | 授权仓库 + 固定 commit SHA；branch 仅作用户选择，创建时解析并记录 SHA                         |
| 当前本地工作副本      | 显式选择后生成上传预览与 digest；列明 tracked 修改和选择的 untracked 文件，不隐式上传整个目录 |
| 旧云端共享工作区      | 继续原地使用；需要隔离时从已停止或一致快照的旧工作区显式克隆                                  |
| 空目录／非 Git 文件集 | 由 adapter 提供不可变 manifest，接受大小、路径和文件类型限制                                  |

每个新 Workspace 有独立 clone／文件副本及 `.git`。只读对象或依赖缓存由可信准备器按 revision 与来源 digest 使用，不把共享可写 bare repo、HOME 或 `.git` 挂进多个执行实例。首版优先完整隔离，后续再优化写时复制与缓存。

clone、setup、依赖安装和仓库 hooks 在受限准备实例内运行。控制面不执行项目脚本。Git URL 采用允许协议、允许来源及 DNS／重定向策略；私有网络源由管理员显式配置。禁止把 repo URL 拼进 shell 命令。上传检查绝对路径、`..`、符号链接、超量文件、归档展开大小；凭据与缓存默认排除，预览清单不得以“全量同步”掩盖上传范围。

私有仓库使用 coding `RepositoryAccessBroker` 的受限 clone/fetch/push 契约，服务端验证 repo、ref 与动作。真实凭据由可信服务保管；执行实例通过限时的仓库访问 handle／credential helper 获得授权，不能读取通用账号 token。复用 Link 授权时需单独补齐 Git 数据传输 adapter，既有 Link 目录动作不等于已经实现 Git 代理。

模板缓存不得包含用户 secret、会话历史或个人配置。凭据引用不参与文件快照；确需进程读取的秘密只按显式能力短期交付，并纳入日志脱敏与清理。网络 allowlist 必须有实际出口代理或网络执行层，Docker bridge 隔离本身不能被描述为域名访问控制。

## 7 创建会话与运行协议

新增 V2 应用协议，业务语义与 Core 执行协议分开。REST 管理目录、准备操作和持久回执；WebSocket 复用现有流式事件／审批形式。旧 `/p/:projectId/ws` 路由保留给 legacy 会话。

| 拟议接口                                                                  | 用途                                                            |
| ------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `GET /api/v2/capabilities`                                                | 协议版本、scope 和能力协商                                      |
| `GET /api/v2/identity`                                                    | 认证后的 hostId、authorityId 和 principal，供 Main 核验绑定主体 |
| `GET /api/v2/projects/:id/environments`                                   | 项目有权使用的已发布 revision                                   |
| `GET /api/v2/projects/:id/conversations`                                  | 云端会话元数据目录                                              |
| `POST /api/v2/projects/:id/conversations`                                 | 幂等创建 Conversation、Workspace、Operation，可原子记录首条提交 |
| `GET /api/v2/projects/:id/conversation-requests/:createRequestId`         | 在尚未获知 conversationId 时恢复创建回执                        |
| `POST /api/v2/projects/:id/conversation-requests/:createRequestId/cancel` | 取消未创建请求并留 tombstone；已创建则返回原会话与回执          |
| `GET /api/v2/operations/:id`                                              | 查询准备／启动进度与可恢复错误                                  |
| `POST /api/v2/conversations/:id/connect`                                  | 重新授权并建立 workspace 连接；不创建工作区或提交任务           |
| `POST /api/v2/conversations/:id/turns`                                    | 持久接受后续提交，返回 RunReceipt                               |
| `GET /api/v2/conversations/:id/submissions/:clientMessageId`              | 对账接受、派发、执行或不确定状态                                |
| `POST /api/v2/conversations/:id/runs/:attemptId/cancel`                   | 请求取消指定运行，返回取消回执                                  |
| `POST /api/v2/conversations/:id/runs/:attemptId/resume`                   | 显式恢复中断任务，按 resumeRequestId 创建关联的新 attempt       |
| `POST /api/v2/conversations/:id/approvals/:requestId/decisions`           | 带 attempt/incarnation 的审批决定                               |
| `GET /api/v2/conversations/:id/history`                                   | 分页历史与 durable cursor                                       |
| `/p/:projectId/w/:workspaceId/ws`                                         | 经授权的实时事件通道                                            |
| `POST /api/v2/workspaces/:id/suspend`、`resume`、`archive`                | 工作区生命周期动作                                              |
| `GET /api/v2/workspaces/:id/artifacts`                                    | 产物清单；下载另领受限资源 handle                               |

新草稿首次发送时 Main 创建稳定 createRequestId 和 clientMessageId，并在网络请求前把目标 scope、规范化 payload/digest、输入资源引用和请求 ID 持久写入本机 pending-submit outbox。只有本机写入成功才发送。重载／重启复用原 ID；即使首次创建 ACK 丢失、客户端还不知道 conversationId，也先用项目级 conversation-request 查询恢复，不能生成新 ID 重新创建。

服务端先校验并耐久封存附件／上传快照，再在事务中记录 Conversation、Workspace、准备 Operation 与首条输入，返回已持久接受的 operation/run receipt。接收事务将输入资源引用归属到 submission，不再依赖短期上传登录会话或其 TTL；未提交成功的孤儿输入延迟回收。准备器就绪后派发首条消息，客户端关闭也不丢失已接受的工作。准备失败时保留输入和错误，由用户修正或重试准备步骤。

后续提交在 `(principal, project, conversation, clientMessageId)` 上唯一，记录 payload digest。同 key 同 payload 返回原回执，不同 payload 返回冲突。创建请求也单独幂等；清理后保留有限期 tombstone，避免旧重试意外创建新任务。

Submission 与 RunAttempt 分开：同 clientMessageId 永远表示同一份输入，正常重连返回其原 attempt。显式恢复中断任务时，在固定 target/workspace 下按新的 resumeRequestId 和预期记录版本创建关联 attempt；重复恢复请求返回同一个新 attempt。修改了输入则创建新 Submission。恢复会展示已确认／不确定的执行状态，不自动重放未知工具步骤。

同 conversation 首期只有一个 active attempt；后续提交按服务端持久 sequence 排队。审批等待属于 active，不能仅靠 renderer 的 busy 禁用控制并发。取消排队输入由控制面完成；业务重试与消息发送去重分别记录。

```text
已有项目的新草稿 + 云端目标
  → 核验身份、项目授权、revision 和输入范围
  → 持久记录会话、工作区、准备 Operation、首条提交
  → 分配受限执行实例和独占卷
  → 固定来源并物化文件 → setup → readiness / capabilities
  → 派发 RunAttempt → 原生输出、审批、取消
  → 会话保留工作区 → 后续 turn 继续同一工作区
```

Main 返回与窗口／frame 所有权绑定的 opaque RuntimeHandle。renderer 只提交消息与受限选项，不传 cwd、宿主绝对路径、volume 名、Docker 参数、凭据或扩大后的 sandbox 策略。Main 和 Server 从记录推导真实目标，并在每次请求复核授权。

WebSocket 断开和丢 ACK 后先查询 submission receipt，再恢复 history/journal；不会默认重发 `agent/run`。状态为“尚未发送”才允许同 key 安全提交；已接受则等待原任务；不确定则显示查询中或需要处理。持久去重防重复接受，不代表外部工具副作用具备 exactly-once。

执行侧新增 durable inbox，按 attemptId + payloadDigest 先落盘并 fsync 接收记录，再启动模型／工具。同 key 同 digest 返回原 receipt，异 digest 拒绝；started 与 terminal 状态持久记录。控制面 outbox 仅在 fenced dispatcher 与当前实例的 inbox 共同确认未接受时重派；单次 404、超时或断线不能证明未执行。Worker 崩溃后对已 started 且无 terminal 的 attempt 标 interrupted/unknown，不自动重跑。这一执行侧回执属于 P1，而非后置恢复优化。

取消是独立幂等动作。尚未派发的提交由 ControlStore CAS 成 cancelled 并阻断 outbox，控制面可给确定终态；准备操作按需中止，保留已创建工作区。dispatching 状态不确定或已经运行时，需 Worker terminal receipt 或确认执行实例已停止，才能显示已停止。超时保留“正在取消／无法确认”，不能只关连接就宣告任务终止。

## 8 状态存储与耐久恢复

V2 控制面推荐 SQLite WAL、外键和单控制器文件锁。`ControlStore` 封装事务、Operation/outbox、唯一提交 key、状态版本及回收记录。Server 保持纯 Node，驱动需满足仓库 Node 版本与打包矩阵，不引入 `bun:sqlite` 或仅新 Node 可用的 API。驱动的原生依赖／ABI 兼容检查是 P0 的上线门槛。

现有 V1 JSON registry 继续为旧容器提供权威状态；V2 数据库负责新实体，不能两边同时写同一个实体。Core transcript、journal 和会话文件仍在 workspace data volume；数据库仅记录引用、游标和可恢复操作，不复制第二份 transcript 权威数据。

SQLite 与 data volume 无法跨存储原子提交。采用 durable Operation/outbox、Worker receipt 和 reconciler 对账：每一步先记录意图，执行可识别的资源动作，再持久确认；崩溃后按资源标签与私有身份校验恢复。不能仅凭“数据库写了 dispatched”推断工具已执行或未执行。

| 对象         | 主要状态                                                                                                                             |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| Workspace    | `creating → ready → retained → archived → deleting → deleted`；准备失败保留 `failed` 与数据引用                                      |
| RuntimeLease | `provisioning → preparing → ready → busy / idle → stopping → stopped`；无法确认实例时 `unknown`                                      |
| RunAttempt   | `accepted → dispatching → running / waiting-approval → completed / cancelled / failed / interrupted`；丢失执行确认单独保留 `unknown` |

Workspace 的文件保留与计算资源状态分开。停止实例不删除卷；归档不等于删除。资源删除有持久计划和延迟清理，先核对无引用、无运行和保留期限，再操作 provider。

| 故障                 | 恢复规则                                                                                |
| -------------------- | --------------------------------------------------------------------------------------- |
| 客户端关闭／断网     | 云端运行继续；重连恢复身份、回执和 cursor                                               |
| 控制面重启，实例仍活 | V2 不执行现有 `stopAll`；核验 DB、Docker labels、实例私有身份后接管，重建路由与连接授权 |
| Worker／容器死亡     | 标记 interrupted，保留文件和输出；显式恢复实例并创建新 attempt，不自动重跑未知副作用    |
| 宿主机重启           | 通过持久卷恢复数据；进程内工具不能假装续跑，先对账再恢复                                |
| 同一资源存在两代实例 | fencing 拒绝旧代 RPC／事件；先确认旧实例停止，才能把同一卷挂到新实例读写                |
| 磁盘满、journal 损坏 | 停止接受无法耐久的提交，展示真实错误，禁止用空状态覆盖历史                              |
| 备份恢复             | 离线验证 DB、卷、模板／产物引用的一致性，撤销旧连接／审批授权，重新确认实例             |

`controllerEpoch` 防旧控制器继续路由；`incarnation` 防旧 Worker 回复污染新运行。接管握手为：获得 installation 独占控制锁，数据库事务分配单调 epoch，私有 Host 核验接管凭据并确认新 epoch，然后才开放路由。Host 拒绝旧 epoch 的命令与审批；仅控制面重启不改变仍活 Worker 的 incarnation。失锁立即关闭调度、路由及 provider mutation，无法排除旧控制进程仍活时不强制接管。

Provider 动作绑定 immutable container ID 和 incarnation，执行前与 await 返回后复核控制权，不能仅按可复用容器名操作。RPC fencing 不能阻止旧进程直接写文件，因此 provider 必须保证单 Workspace 只有一个读写实例。无法确认旧实例状态时阻止第二个读写挂载，不能靠新 token 假装已隔离。基础 generation 校验与唯一写实例约束从 P1 生效，P2 才增加完整重启接管流程。

接管运行实例不继承旧登录或旧审批授权。重新登录后核验 pending approval，向新授权上下文发出有效请求；迟到审批以 attempt、requestId、incarnation 和授权版本校验，失败则拒绝。

首版采用显式停止计算资源。自动空闲回收后置，必须检查 active run、待审批、子 Agent、后台 shell、定时／Sleep 任务及 Host 后台任务的存活条件；不能把最后一个 WebSocket 离开当作空闲。

诊断以 operationId、workspaceId、attemptId 和 incarnation 串联，记录准备耗时、队列／资源用量、提交不确定状态、重连与接管结果。日志不记录原始凭据、完整用户输入或可复用授权 handle。备份使用 SQLite 一致备份机制，并在 workspace 写入已停止／冻结后捕获卷；不能只复制运行中的数据库主文件而漏掉 WAL，或将不同时间的卷与 DB 拼作一致快照。

## 9 隔离与能力契约

每个 isolated Workspace 有独立 data volume、workspace volume、HOME、会话根目录、临时资源与执行凭据引用。执行实例沿用 non-root、只读根文件系统、cap-drop、no-new-privileges、CPU／内存／pids 限制；不挂载 Docker socket、宿主 HOME 或控制面配置。

Docker Provider 首期适用于自托管单信任域。面向互不信任租户开放服务前，需另设 VM 或等效强隔离 Provider、租户配额、出口执行策略、凭据隔离及恶意负载验收。不能由“多用户账号能登录”推导公开多租户执行已完成。

数据作用域明确分为三层：

| 作用域     | 内容与访问方式                                                                   |
| ---------- | -------------------------------------------------------------------------------- |
| 用户私有   | 账号、模型与第三方原始凭据；可信服务保管，任务只获限时引用                       |
| 项目共享   | 项目说明、锁定的 Panel／能力包版本，以及明确声明共享的项目资料；通过授权服务访问 |
| 工作区私有 | 代码副本、会话、运行账本、临时文件、任务日志和产物；默认不跨会话共享             |

保留既有项目共享 Panel 资料的语义，不把所有业务资料默认复制成会话私有数据，也不把共享可写项目卷直接挂进执行实例。通用 Host 提供带 scope 的资源与任务机制；Panel 的数据规则、模板和模型仍由独立 Panel 包负责。项目共享 Memory 若需要跨会话写入，应通过明确授权的服务实现，不能共享可写 HOME 来间接达成。

把当前 `LocalRuntimeActionsContext` 布尔门控逐步替换为能力集合：`chat, approvals, history, upload, files, diff, git, worktree, terminal, artifacts, transfer`。服务端声明、Main 裁剪，缺失默认关闭。隐藏按钮只是体验措施，实际授权仍在 Main／Host 校验。

远程 files/diff/artifacts 使用 workspace resource handle；本地文件、Git、undo、Panel API 不接收远端绝对路径。新 target 引入不自动开放 Goals、Cron、插件命令或远程终端，只有其生命周期和权限经对应验收后才 advertise。

## 10 成果取回与显式继续

任务结束后保留 Workspace，生成带 digest 和大小的 Artifact manifest。通用产物包括文件、文档、图像和受限日志；coding 产物额外包含基线 commit、当前 HEAD／branch、staged/unstaged patch、选定的 untracked 文件和测试结果。

取回本机默认落到新 worktree 或新目录，先显示变更预览与来源。使用基线 SHA 检查兼容性或做三方合并；冲突保留双方内容，不覆盖本地未提交改动。下载验证归属、大小、哈希、路径穿越和符号链接。

push 和 PR 是 coding 的独立显式动作，校验仓库、目标 branch 与远端期望 ref。完成任务不自动 push，也不把“已下载 patch”称作已合并。

后续“在另一位置继续”复用 SourceSnapshot 和 Artifact 流程：选择代码版本及要带走的修改、上下文摘要和附件，创建带 parentConversationId 的新会话。源会话保留；凭据、审批权限和正在运行的进程不迁移。

## 11 兼容与数据迁移

### 11.1 桌面状态

保留 `LocalProject.id`、roots、本地 transcript 和 engineSessionId；保留 CloudProjectBinding UUID、origin、主机身份、remoteProjectId 及时间戳。V1 selections 只转成新会话默认值，不能据此猜测旧会话 target。

旧本地会话按现有 workspace／主机信息建立目录，缺少依据则标记 unresolved，不猜另一个路径。旧云端会话从原 binding 的远端目录发现并懒建立路由，`workspaceMode=legacy-project`。删除 binding 留 tombstone，旧历史可识别但不可偷偷换目标继续。

现有 store 的锁内重读、严格校验、fsync + 原子 rename 继续保留。首阶段沿用 canonical `project-runtimes/v1.json` 路径，校验并保存只读 V1 备份后原子写入 `version: 2`；旧客户端严格拒绝未知版本，避免旧进程覆写新数据。不要同时留下可写 v1.json 与另一个 v2.json 作为两个权威入口。路径改名可在兼容期结束后单独实施。

会话路由索引旁路建立，原 catalog／transcript 不覆盖删除。记录迁移 source schema、进度与每批完成状态，避免位置 store 已升级、会话目录尚未建完时丢失路由；部分迁移可幂等继续。

迁移必须可重复、掉电安全；损坏原文件保留并报错，不用空配置恢复。自动回滚只允许尚未产生 V2 数据的迁移；有 V2 会话后保留新格式，旧客户端只能拒绝或走只读兼容导出。

### 11.2 服务端状态

V1 registry、`/p/:project/ws`、项目容器与卷继续原地使用。每个旧云端项目登记一个 `legacy-project` Workspace，并让其既有会话共同引用；这表示旧共享语义，不能标为新隔离工作区。

新会话只有在 V2 capability 与可用 template revision 都确认后才创建 isolated Workspace。旧服务不具备能力时，UI 明确显示旧共享模式或要求升级，不能无提示降级。需要从旧共享工作区转移时先停机／制作一致快照，显式克隆后生成新会话，原数据保留。

旧项目执行器沿用其现有 reconcile 规则；V2 Manager 单独实现接管，不能把“不停 V2”改成无校验收养旧容器。同一 installation coordinator 持有全局控制／维护锁，V1/V2 Manager 在它之下分别管理自己的命名空间。V2 labels 包含 schema=2、installationId、workspaceId、runtimeId 和 incarnation；停止、备份和 GC 按可信完整记录与 immutable provider ID 操作，不能按 project 或名称前缀泛扫。

legacy Workspace 仅引用旧资源，由 V1 Manager 管理；V2 Manager 不接管或删除旧卷。两者的维护与备份共享 installation 锁，避免旧恢复工具与新调度器同时修改资源。

回退发布时关闭新 V2 创建入口，保留 V2 数据与可续跑的兼容服务；不得将 V2 卷塞回 V1 共享目录或删除未知卷。备份清单包括控制数据库一致快照、卷、template/source/artifact 引用及 schema；恢复需重新授权和验证，不自动复活旧 token。

首版备份采用离线流程：全局 maintenance 锁阻止创建、派发和 GC；停止并确认 V1/V2 所有相关 writer 与后台任务；通过 SQLite backup API 获取一致数据库，再打包卷与引用 manifest，复核 digest 后释放维护锁。活实例直接 tar 卷不算一致备份。业务运行接管与备份维护是不同模式，维护明确允许中断计算。

### 11.3 账号与服务仓库

V2 控制面先复用现有 legacy owner 授权。独立账号服务对接通过稳定 authority adapter 进入，签名／会话撤销验证和 owner 关联是另一工作包。设备中继 token、Cloud runtime 权限和 Link grant 各自验证，不能互相替代。

涉及部署、账号 authority 或 Git broker 的服务改动在 `codeshell-services` 独立任务分支完成；Panel 业务变更在 `codeshell-panel-apps` 完成。固定兼容包与 schema 版本后再联合发布，不让安装包依赖开发工作树。

## 12 实施顺序与改动落点

| 阶段                | 交付内容                                                                                                                               | 退出标准                                                                                     |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| P0 契约与客户端解耦 | 三种状态分离、持久 DraftStore、统一会话目录、host/template/主体身份、V2 schema、ControlStore 与 fake Provider、legacy 导入             | 改默认值和打开旧会话互不影响；同 ID 不串流；迁移及并发版本写入通过                           |
| P1 新会话隔离闭环   | 发布最小模板、固定 SourceSnapshot、独占卷／HOME、基础 fencing、异步准备、原生 run/approve/cancel/history、客户端 outbox 与执行侧 inbox | 同项目两条会话文件及分支隔离；关客户端继续；首创与 turn 丢 ACK 均不重复运行                  |
| P2 耐久与运维       | 控制面重启接管、Worker 中断状态、配额、备份恢复、私有仓库 broker 和真实出口策略                                                        | 崩溃矩阵通过；未知实例不双挂卷；legacy 管理员会话／审批撤销、broker grant 与私有仓库权限验证 |
| P3 取回与生命周期   | Artifact manifest／下载、本地新 worktree 导入、冲突保护、显式跨位置继续、受保护回收                                                    | 产物哈希一致；不覆盖本地修改；回收／升级回退不丢旧数据                                       |

P1 就应具备固定代码来源、基本环境准备与丢 ACK 对账，不能先上线“隔离容器”再补最基本的可恢复提交语义。P1 支持公开仓库和显式上传的 SourceSnapshot；私有仓库接入能力未具备时明确关闭。P2 才增加完整接管、私有源与运维门槛。独立多用户账号 authority 接入仍是跨仓工作包，不由阶段表默认为已完成。自动空闲停止、远程终端、远程文件编辑和更多 Panel 能力可在 P3 后按协商逐项开放。

| 文件／模块                                                                    | 改动方向                                                                                     |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `desktop/src/shared/project-runtime.ts`、`session-catalog.ts`                 | preference、conversation target、host identity 与目录 schema                                 |
| `desktop/src/main/project-runtime-store.ts`                                   | V2 迁移、conversation route、binding tombstone                                               |
| `desktop/src/main/runtime-draft-store.ts`、`runtime-submit-outbox.ts`（新增） | CAS 草稿、scope/附件复核、发送前持久 key 与首次创建回执恢复                                  |
| `desktop/src/main/cloud-environment-service.ts`、IPC/preload                  | V2 capability、异步 operation、workspace handle、回执与 scoped events                        |
| `desktop/src/renderer/App.tsx`、`Sidebar.tsx`、`useSessionNavigation.ts`      | 统一目录；按 active conversation/draft 路由，去掉项目 boolean 全局分支                       |
| `desktop/src/renderer/runtime/*`                                              | RuntimeManager 管理后台订阅；保留 CloudProjectRuntime 为 cloud adapter                       |
| `server/src/cloud-runtime/*`（新增）                                          | V2 schema、ControlStore、WorkspaceManager、RuntimeSupervisor、Operation/Attempt/Artifact API |
| `server/src/project-runtime/*`                                                | 保留 legacy；抽取可复用的 Docker/备份机制，不扩张任意 cwd 接口                               |
| `server/src/serve/*`                                                          | 单 Workspace Host 身份、回执、能力与 scoped history 适配                                     |
| `coding/src/*`                                                                | Source/Artifact Adapter、仓库准备、patch/branch/PR 领域行为                                  |
| `web/src/*`                                                                   | 复用流式 reducer、history 与 approval 语义；不承担 Host 权限决策                             |

V2 面向客户端的 DTO 需放在受审的 browser-safe 契约入口。renderer 保持现有 import 边界，不直接 runtime-import Core 或 Server 内部模块。

## 13 验收矩阵

| 类别         | 必须通过的场景                                                                                                            |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 已有项目交互 | default=cloud 打开旧 local 仍 local 且 default 不变；反向同样成立；所有步骤在同一原生窗口                                 |
| 并行与视图   | cloud 运行中切本地、切项目、重载 renderer，不改原 target 或丢后台状态                                                     |
| 身份与范围   | 同项目不同 workspace 使用相同 engineSessionId/tool requestId 不串历史、事件、审批或文件；慢响应不覆盖新选择               |
| 文件隔离     | 两条云端会话改相同路径／分支互不影响；HOME、配置与进程环境独立                                                            |
| 草稿与上传   | 各目标草稿重载／重启后保留；句柄失效要求重选；无隐式上传；accepted 输入不随登录／上传 TTL 消失                            |
| 准备失败     | clone/setup 失败、磁盘满、依赖缺失显示准确步骤；重试准备不重复建会话或派发首条消息                                        |
| 丢 ACK       | 首创 ACK 丢失且桌面重启、pending 时切位置、接受前后／派发中／terminal 后均按原 ID 对账，不默认重发或改 target             |
| 重启恢复     | 控制面重启保留活 workload；Worker 死亡显示 interrupted，保留文件与已发布 journal                                          |
| fencing      | 旧控制器、旧实例及迟到审批拒绝；旧实例无法确认停止时禁止第二次读写挂卷                                                    |
| 取消与恢复   | 排队／准备中取消阻断派发；运行取消超时不虚报停止；同 resumeRequestId 不重复建 attempt，工作区保留                         |
| 授权         | 登录过期、撤销、同 origin 切账号、项目无权限或 host/authority 改变时旧 handle 与审批失效，无跨主体缓存发送／本地 fallback |
| 目录与能力   | binding 移除后历史保留；缺少远程 files/git/terminal 能力时 UI 和 API 都关闭                                               |
| 迁移         | V1 IDs/roots/transcript/volumes 保留；新旧客户端并行与迁移崩溃只有一个 canonical 权威状态                                 |
| 成果         | Git binary patch 与非 Git 文件可取回；哈希一致；冲突不覆盖本地未提交内容                                                  |
| 生命周期     | 断开最后客户端不回收；有审批／后台任务时不空闲停止；归档与删除有保留保护                                                  |
| 运维         | SQLite 驱动 Node/打包矩阵、卷与 DB 一致备份、升级回退、资源配额与目标 Linux Docker 演练                                   |

按仓库规范使用 guarded Bun test shard，fake Provider 和精确 origin 的受控模型／工具 fixture；再跑真实 Node HTTP/WS、真实 Docker 双工作区、真实 Electron 原生流程。CI fixture 通过与真实部署、第三方账号或实体手机验收分别记录。本方案本身只交付设计文档和架构图。

## 14 设计依据与后续约束

官方公开行为核对日期为 2026-10-12：

- Codex 桌面通过 Work in 选择 This computer／Cloud；已发布环境包含仓库、工具和依赖，每个任务有独立工作区，现有任务保留自己的状态。[运行位置](https://learn.chatgpt.com/docs/environments/modes)、[云环境与状态](https://learn.chatgpt.com/docs/environments/cloud-environments)
- Claude Code Desktop 分别选择 Environment 和 Project folder；托管 cloud session 使用独立 VM，环境保存网络、变量与准备配置。[桌面入口](https://code.claude.com/docs/en/desktop#start-a-session)、[云端隔离](https://code.claude.com/docs/en/claude-code-on-the-web#security-and-isolation)
- 切换客户端入口与迁移执行地点需要分开：Codex 当前不支持 handoff 到 Codex Cloud；CC Desktop 有显式 Open in Cloud，CLI 的 clone/bundle/teleport 各有独立数据规则。[Codex handoff](https://learn.chatgpt.com/docs/remote-connections#hand-off-a-chat-between-hosts)、[CC 移交](https://code.claude.com/docs/en/desktop#continue-in-another-surface)、[CC 代码来源](https://code.claude.com/docs/en/claude-code-on-the-web#start-a-cloud-session-from-your-terminal)

本方案的具体 API、数据模型、SQLite、Provider、fencing 与迁移方式为 CodeShell 设计选择，不宣称是 Codex 或 CC 的内部实现。

既有 [Hub 总体设计](codeshell-hub-remote-service-architecture.md)、[项目与 Panel 总计划](project-cloud-panels-plan.md)、[可选账号边界](../cloud-accounts.md) 继续作为各自领域依据。本方案更新其中与本次需求冲突的交互方向：已有项目保持稳定身份，执行位置落实到会话；独立云端网页可作为另一个客户端存在，桌面云端聊天不通过跳转网页完成。旧总计划中的云端工作台入口不作为本方案的桌面实现要求。
