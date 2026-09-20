# Pet 工作可靠性修复技术方案

日期：2026-09-20。对应 [逐项审计与 TODO](pet-work-reliability-audit-2026-09-20.md)。先方案、后实现；本文件在验收时更新实际结果。

## 目标与边界

把“同一任务继续做”“能力是否在线”“预算是否用完”“图像证据是否仍存在”落实为代码可验证的状态。Core 只实现通用机制；Pet 路由、目标承接和回执策略属于 packages/pet 与 Desktop Pet Host。保留现有协议、scope 隔离、审批策略及用户已有未提交修改。

不把飞书/GitHub 业务规则写进 core；不自动修改本机插件安装、不重放外部写入、不覆盖历史记忆，也不宣称已确认缺乏历史日志的慢启动根因。

## 1. 同一任务的续办

自动收尾只提供当前任务的原 Session 和 workspace，Host 用持久化的 task.sessionId 作为 targetSessionId，不依赖模型猜 ID。原 Session 不存在、忙碌、有待审批或不支持续办时明确失败；不得 fallback 成新 Session。用户明确创建另一任务仍保留新建路径。

续办输入包含完整原始 objective、最新结果/checkpoint 和收尾模型提出的下一步。ledger 单独保留 originalObjective，避免下一次把整段恢复提示作为新目标层层嵌套。仅原任务使用 Goal 时继承 Goal 语义，普通任务不自动转为 Goal。约束继续由原 Session 历史承载；原目标同时作为恢复锚点。

DelegateWork 显式给 session_id 时必须有合法 continuationEvidence。能力层和 Host 两处校验统一 fail-closed：返回可纠正错误，不丢 ID 后新建。启动失败后的 Gateway 回告和返回结果使用同一错误事实，不能仍显示“已经继续”。

## 2. 路由候选补齐真实近期目标

保留标题与现有 ID 兼容，额外提供最近真实用户请求及最近 assistant 结果。先按现有可见性/workspace/数量限制裁剪，再有界读取 transcript 尾部，使用 mtime cache，避免每次全量读取大图 base64 历史。排除 Host injected 提示；片段标识为引用资料，不是新指令。

Pet 提示明确：标题可陈旧，疑似重试/续办需要 Sessions 查询或描述；有相同实际目标和兼容工作区才复用。不能单凭共同 URL 判断相同任务，也不能单凭不同标题排除。

## 3. MCP 初始化可靠性与故障可见性

配置新增 connectTimeoutMs（默认 30 秒，上限 120 秒）与 connectRetries（默认 1，上限 2）。重试只覆盖初始化超时；配置错误、权限错误和协议错误立即失败，工具调用尤其写操作不自动重试。每次尝试使用新 client/transport，前次关闭完成后再启动。一个截止时间覆盖握手和 tools/list，发现全部成功后才发布连接/工具，避免部分初始化泄露。取消、scope generation 更替和断连终止重试。共享同 scope 的初始化仅在最后一个使用者取消/释放后终止，首使用者结束不能误杀仍在等待的其他使用者。

stdio 启动必须具备进程树清理能力后才能默认重试，复用项目已有进程组终止机制；协议编码复用 MCP SDK。测试包含 wrapper 派生子进程的退出，防止超时后遗留后台服务。其他 transport 保持既有协议。

日志提供 server、transport、attempt、stage、elapsedMs、timeoutMs 及受控错误类别；不新增 args/env/URL/stderr 原文。阶段至少区分 spawn、首响应、握手结束，无法得知的子阶段如 npm 内部联网不推断。

connectRunMcp 返回当次失败快照并写入 ToolContext。engine 将摘要注入该 run 的模型上下文；Skill/工具发现也读取同 scope 的健康状态。每次 run 重建快照，恢复即清空，不跨 workspace 泄露状态。技能说明仍可读，但必须标明关联服务离线，避免教程与运行能力混淆。

部署建议：通过插件自身发行配置固定依赖版本，预安装并使用稳定入口；`npx @latest` 存在联网、版本漂移和 cwd 扫描开销。此次只记录建议，不修改用户全局文件。

## 4. 预算耗尽的终态

最后一轮由预算控制强制文本收尾时，即使模型 stop，也返回已有 max_turns 停止原因。正常在预算前完成仍为 completed。检查 Pet/Host 终态投影是否保留 max_turns，而不是把任何 final 文本都当作已达目标。复用已有协议字段，避免增加无必要的终态枚举。

## 5. 图像证据的有界保留

新图像不会在首次请求后立即全部清除。使用独立、确定性的近期图像窗口，同时限制保留请求次数、图像数量和字节数；新图至少有首次呈现机会，旧图按先进先出淘汰。实现默认保留 6 次成功模型响应，历史上限 4 个图像出现位置、8 MiB 编码数据；同一 block 被重复引用也按实际发送次数计入容量。新输入首次请求允许超过历史上限，随后淘汰超额内容。窗口是 run-local，新的用户 run 不自动恢复旧像素。淘汰只影响模型请求上下文，原始 transcript 仍可通过现有 view_image 回读。

占位文案改为“像素已省略，需要时重新加载”，不声称“已处理”；保留历史占位识别兼容。上下文压缩仍可更早淘汰图像，不能把窗口承诺成绝对保存。避免无界多图累计造成请求膨胀。

浏览器通用提示要求：精确 URL、行号、账户或对象标识优先使用结构化/文本证据；截图内容应先转成带来源的记录，核验对象后才写操作。解析/网络错误与业务 HTTP 状态分开；不从记忆补缺失链接，不因查询错误目标的 404 宣布源数据失效。Pet 收尾区分执行者自述与已核验结果，不添加无证据的原因推断。

## 文件归属与实施顺序

1. 文档和根 TODO 落盘。
2. Pet：packages/pet 的 delegation/profile/disclosure；Desktop pet-dispatch-service/coordinator 及测试。
3. MCP：core tool-system/mcp-manager、transport、配置规范化、run-tooling、ToolContext 与 Skill/发现工具；engine 接入由主任务统一完成。
4. Engine：turn-loop、图像窗口和 compaction 占位，以及通用 browser prompt。
5. 汇合后定向测试、类型检查与 lint；失败按归属修复，更新审计矩阵。无需并发 clean build。

## 验收与发布

以故障注入和本地 fixture 验证机制，不对用户 GitHub/飞书账号执行试验写操作。完成本地检查后报告改动及边界；运行中的 Electron/worker 必须重启或重新构建才使用新代码，未做真实部署则明确标注。历史会话结果纠偏属于另一个数据修复动作。


## 配置与最终实现说明

配置示例（使用实际配置中的服务名；示例不应直接覆盖现有设置）：

```json
{
  "mcpServerOverrides": {
    "example-plugin:server": {
      "connectTimeoutMs": 30000,
      "connectRetries": 1
    }
  }
}
```

独立 `mcpServers` 条目也接受相同字段，插件提供的 MCP 配置与 Host override 都做范围校验。不要通过无限提高期限掩盖启动问题；新日志能区分启动、首条协议响应和后续初始化阶段。需要稳定发行时，由插件维护方固定依赖并提供预安装入口；当前实测同目录直接运行已缓存服务，初始化约 506ms、工具发现总计约 509ms，说明插件主体能工作，但不能回溯证明历史延迟全部来自 npx。

已有源码入口：`core/context/image-history-window.ts` 负责图像窗口；`core/tool-system/mcp-connection-policy.ts`、`mcp-stdio-transport.ts`、`mcp-health.ts` 负责连接策略、进程生命周期和健康摘要。MCP SDK 继续负责协议编解码；跨平台命令启动使用 SDK 同款 cross-spawn 7.0.6，作为 core 显式依赖。

近期候选摘要每段 180 字、尾读 512 KiB、缓存最多 200 会话；原列表的最多 32 个候选和工作区过滤保持有效。这只是候选提示，不能把截断片段当作完整用户约束，续办仍要复用原 Session。

## 发布后 review 修复

- Goal 续办使用 `goalContinuation: { goalId, revision }` 继承原配置，不能重新提交目标字符串。Pet 在决策前和启动前读取当前 Goal；Protocol 入队前及 Engine 实际执行时再次校验版本。已暂停、已结束（包括预算耗尽）或已变更的 Goal 拒绝自动续办；预算、目标身份和原始时间锚点保持不变。
- `goal_progress` 只确定任务结果，不代表 Session 已结束。Coordinator 在同一 run 仍忙时保留待处理的 closure，收到空闲状态或恢复快照后重试；先处理已排队的最终正文事件，再生成闭环回复，不占住会话事件队列等待空闲。
- Web 原生任务在输入准备前登记登录归属，退出登录、应用撤权和 Host 关闭都中止准备。取消信号进入任务服务及文件准备流程；即使准备器忽略信号或取消发生于持久化期间，也不能启动执行器。其他登录的任务不受影响。
