# Capability / Operation Controller 实施边界

本工作包推进 [可靠性方案](agent-reliability-and-context-optimization.md) 的能力解析、
操作账本和强制回读验收。Core 提供通用控制器；provider 语义、账号和执行策略保留在
可信 adapter。所有真实写操作继续经 ToolExecutor、权限、Hooks 和原生审批。

首个生产消费者是现有 LinkAction 的 GitHub 写动作。它需要把当前“写请求返回成功”
收紧为“单次写入回执 + 独立只读回查通过”；SDK 的 PAT/OAuth 和 remote Link 使用相同状态语义。
权限或 provider 不支持回查时返回明确的未验证结果，关键写操作阻止 Run 以 completed 收尾。
其他外部写工具逐个迁移，保持每项真实消费者的验收证据。

## 控制阶段与账本

1. DISCOVER 选择当前 Run 粘性的 provider/连接/账号/语义 channel。
2. PREFLIGHT 检查实时权限、账号、runtime、scope 和通道健康。
3. VALIDATE 规范化输入并通过声明的只读验证确认目标。
4. PLAN 固定目标、参数摘要、后置条件、授权范围和幂等身份，持久化 planned。
5. EXECUTE 原子 claim 后执行一次，记录独立 attempt。running 的不明结果阻止自动重放。
6. VERIFY 通过同一明确账号、目标和许可范围独立读取；只有后置条件成立才能 verified。

每个目标独立记录 planned/running/succeeded/verified/failed/unknown/blocked。
成功的 HTTP 返回只能生成 succeeded。请求可能被消费或持久化结果失败时生成 unknown；
重新启动后的 running 同样按不明结果处理。已 verified 的幂等身份返回既有回执，新的
账号/参数/目标/后置条件不能借用原身份。网络 I/O 不持有同步文件锁。

凭据、完整正文和原始模型上下文不进入操作账本。账本保留有界目标标识、私有摘要、
状态、attempt、错误分类与验证回执；调用方负责受信任的授权身份。具体参数和敏感摘要的
托管随 Host/Session 私有存储实现，不引入 renderer 密钥或通用读 secret RPC。

## 权限与错误预算

固定操作的嵌套读取使用所属 ToolExecutor 的受约束执行入口，保留硬 deny、allowedToolNames、
capability、审批、Hooks 和执行记录。Hook 保留的参数引用不能在异步 handler 内改写固定目标。
每次异步授权/发现/回查后复核同一连接与 scope；撤销、项目或 Profile 切换会阻止后续 I/O。

Resolver 的 read/write intent、动作和账号在 Run 内粘性绑定。失效后明确失效该选择，
重新预检；“浏览器未登录”不能推断其他通道均不可用。通道 adapter 未提供能力就报告
unsupported，不虚构认证状态。不同风险、意图和目标不得共享审批或幂等身份。

错误区分 transient、stale_reference、validation、authentication、permission、unsupported、
postcondition_failed 和 poll_pending。写操作缺少 provider 幂等保证时不因 transient 自动重放。
相同错误指纹和策略切换遵守有界预算；声明了停止条件的 poll 不进入普通重复错误计数。

## 验收顺序

先验证进程竞争、断连/崩溃后重启、幂等冲突、结果落盘失败、权限撤销、验证失败及错误预算。
再连接真实 ToolExecutor 和 Link/CLI/remote HTTP fixtures，证明零重复写、独立回查和
未验证关键操作的终态阻断。所有测试的 HOME/配置与网络必须隔离；模型请求仅允许确切
localhost fixture origin，重定向拒绝，并核验实际 child/worker 继承的封锁收据。

实现、实际账号验收与发布分别记录。真实第三方写入和付费模型实验仍需其具体授权；
本工作包的自动化验证只使用受控服务，不增添侧边栏入口。

## 当前落地范围与边界

Core 已接通持久操作账本、单次原子 claim、独立验证、终态 fence、Run 粘性能力解析，
首个真实消费者是 GitHub `create_issue`。目标先经现有 `list_issues` 精确仓库读取验证，
创建成功后经同一 ToolExecutor 的固定 `get_issue` 回读比较 number/title/body/state。
local PAT、OAuth 和 remote Link 使用这条控制路径。未经所属 Engine/Executor 的 standalone
写调用明确拒绝。CLI 的所有写动作现在明确拒绝，旧已保存写 grant 也不能发送；新连接和
发现只提供读取。其他 provider 的写动作
尚未逐个迁移，不能据此声称所有外部写都已具备后置验证。

同一可信用户输入只有一个 create_issue slot；目标、正文、账号、连接或后置条件变化
与已落盘计划冲突。不同 model tool-call ID 不产生新 slot。Session 中存在已发送但未验证
的操作时，新意图也不能自动再写。单目标 Star 已实现固定布尔 desired state、持久仓库 ID
和独立 identity/state 回读，详见 [Star 交付边界](github-star-actions-delivery.md)。批量创建的
Host 固定 slots、其他 provider 写语义及独立 provider 只读复核仍需后续实现。
`update_issue` 的显式关闭／重开及独立回读已实现，见 [Issue 状态交付](github-issue-state-delivery.md)。
现有活动记录已提供原生确认的人工接受不确定性入口，详见下节；它不把旧操作或旧 Run
改成成功。没有 number 的未知结果不会用标题搜索冒充验收，也不支持直接修改账本来回滚。
只有新操作的真实独立验证通过才允许其 Run 完成。

已支持已知静态读取权限的预检；预检只是预测，不授予后续执行权限。具体新 number 的
权限、Hook 决策或授权在写后改变时，回查仍经完整授权链，失败留下未验证回执。
展示用 Hook 附加文字不会参与验证证据，但所有 Hook、审计与实际授权仍会执行。
相同操作最多进行两次失败回查；写请求没有自动重试。Resolver 已在当前 Link
消费者中使用，其通用 MCP/browser adapter 接口不代表这些语义服务已全部适配。

早期受管理 CLI 的实际 child fixture 曾通过创建和独立读取测试；它验证的是受控 adapter、
参数和进程隔离，不能证明真实 `gh` 的 HTTP 单次发送。后续对已安装 `gh 2.87.3` 的私有
localhost 审计观察到 PUT/DELETE 跟随 307 再次发送；stdin POST 跟随 301/302/303 后 GET
并报告成功（307/308 则仅发送一次 POST 后失败）。因此当前 CLI 写支持已关闭，不能继续
引用旧 fixture 作为真实 CLI 写保证；须明确连接 PAT/OAuth/remote，不自动切换后端。

账本位于 Session storage root 下独立 `.operations/ledger.json`，0700/0600，保留有界
元数据与 keyed HMAC；默认沿用宿主 credential cipher。未提供加密 cipher 的 Node/worker
宿主使用 owner-only plaintext key，不宣称系统密钥库加密。它不暴露给 renderer 或模型
RPC，不保存正文/凭据，也不是针对同用户任意代码的防篡改存储。16MiB/10000条达到上限
会拒绝新写，不丢弃旧幂等回执；压缩/保留策略仍待实现。

写回执采用短同步锁和原子 rename，不持锁等待网络或批准，不承诺断电 fsync durability。
任何 Run 终态先封住 planned/pending；同一 controller 即使落盘失败也先安装内存 fence。
独立进程之间必须依赖成功持久化的 fence，存储不可写时无法承诺跨进程原子撤销；错误
必须以未完成返回，不能继续发送。恢复/移动同一账本保留 key 与幂等身份，不能并行运行
两份旧备份作为一个实时账本。未知状态会阻止 completed、成功记忆与标题生成。

新增终态 `unverified_write` 已接入 Web reducer、终端提示和现有活动记录状态，不新增入口。
Host 的纠正消息同时写入 Transcript 和下一回合缓存，恢复历史保留原模型输出及其后的
未验证说明，不能仅依靠一次性的 error stream event 修正成功措辞。

## 人工接受不确定性

Desktop 的“设置 → 活动记录 → 任务中心”现有 Session／子 Agent 卡片可按需审阅最多
50 条脱敏回执。用户自行核查 provider 后，经默认取消的原生确认记录独立
`operatorResolution: accept_uncertainty`。缺 reference 也允许明确接受，但界面和结果始终显示
“结果仍未知”。这是人工承担不确定性的决定，不是 provider reconcile 或 verified 证据。

原始 state、attempt、reference、updatedAt、幂等 HMAC 和历史 Run 完全保留。旧 intent 永不
重发；仅当前已证明的 Session incarnation 的已处理记录解除新意图写阻断，其他未处理记录
继续阻断。新意图仍独立经过权限、审批、账号、scope 和后置验证。late settle 不能改写
原 unknown 或撤销人工决定。模型工具、worker、Web RPC 不拥有 resolve 入口。

Main 根据原生窗口／主 frame、真实 Session、项目／根、目录 inode、注册表和信任版本
授予短期一次性 review token。确认期间、确认后及最终同步 CAS 均重新检查；最终持有原
操作账本锁和 SessionManager 相同的 state.json 锁，确认当前没有 active Session 或 running
回执，保持 owner binding 未变，并持锁完成原子落盘。锁、存储或 CAS 失败不解除阻断。
回执不包含正文、账号、目标或 secret；无通用读密钥接口。

incarnation 复用真实 UsageLedger.adoptSession 校验的默认 namespace、Session scope 和
accountingSessionId，加上 sessionId／startedAt；SDK Engine 使用其真实注入的 UsageLedger，
不从 state 或 renderer 选择 namespace。Desktop 人工入口仅接受其默认 namespace。
原 intent HMAC 命名空间不变。已绑定的
旧 incarnation 不阻断同 ID 重建的新 Session，但旧 intent 仍不可重放。未绑定的历史记录
仅在至多 8 MiB 的 transcript 中找到相同 session_meta／startedAt、配对的真实 LinkAction
tool_use／tool_result 及精确 id／owner／fingerprint／attempt 证据时才允许人工处理；Hook
附加文本、模型正文及无证据的 legacy 记录都不适用，后者继续保守阻断。未绑定调用方
不能忽略已绑定 unknown，也不能借用另一 incarnation 的人工决定。

## 实际消费者验收

`node scripts/smoke-verified-link-write.mjs` 使用编译后的公开 Node SDK Engine，固定的纯
fixture provider 只返回工具调用/合成文本，Link Host 回调实际跨 localhost HTTP。测试覆盖
创建一次后独立 `get_issue`、写响应丢失后的 `unverified_write`、磁盘终态/纠正消息，以及
重启后新用户输入再次尝试写入时零重复请求。实际子进程在 Core 导入前安装网络 guard，
父进程核验 PID/ppid、确切 origin 与私有 HOME 摘要后才允许开始。没有真实模型或三方写入。
该消费者已接入 CI 的 core-engine shard；Windows 单独运行操作账本/解析器单测。

`verified-write.test.ts` 另外覆盖 remote Link、本地 OAuth 和实际受管理 CLI 子进程的
完整 ToolExecutor 链、读权限拒绝、Hook 参数/展示处理、授权变更、重放与验证不符。
账本测试实际启动八个并发子进程竞争同一 claim。以上证明实现路径，不等于真实 GitHub
账号验收、完整 Desktop GUI 或其他 provider 已完成迁移。

`bun run --cwd packages/desktop test:e2e:operation-resolution` 使用编译后的真实 Engine、
生产 Main/preload 和上述活动页：unknown → 原生取消／接受 → 冷 Main 新 PID → 冷 Engine
旧 intent 零重发／新意图独立回读成功，并验证撤销账号后零发送。开始审阅前等待真实
main／tool_summary 请求全部完成及 costState 持久化，没有改写 active 状态。Core writer 和
两次 Main 在导入前安装 deny-all HTTP，并核验私有 HOME、PID 和七项负探针；冷启动的纯
Playwright 控制器不导入 Core／模型。所有 Link 响应和 LLM 均为合成回调，原生 dialog 的
取消／接受响应由 harness 控制，未连接真实账号或验证真实 provider。单测另覆盖跨窗口／
项目、异步确认及最终 CAS 的再启动／撤权、同 ID 重建、真实原子 rename 失败和 late settle。
