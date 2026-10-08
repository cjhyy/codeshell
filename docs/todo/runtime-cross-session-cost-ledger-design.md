# Runtime 跨 Session 成本账本设计

状态：待实施。2026-10-09 基于代码审计制定；AgentModule Phase C 的 PR #62 独立交付。
本设计记录真实请求费用与归属，不承担 Phase D 的请求参数编译或验证。

## 需要解决的实际问题

- `LLMClientBase.onUsage` 是进程全局单个 callback，仅携带 model 和 tokens，没有 Runtime、
  Session、run 或请求身份。`EngineRuntime.costTracker` 当前没有接入实际请求。
- `CostTracker` 会规范化掉 provider prefix，按模型名称估算；未知模型使用默认价格，
  OpenAI 缺失 provider usage 时构造全零记录，均不能支撑准确的费用覆盖说明。
- `costStore.restore()` 恢复的是可变 tracker 整体快照。TUI 的全局 tracker 跨 Session 共用，
  一个 Session 的 restore/serialize 会覆盖或夹带另一 Session 的记录。
- Session 的累计 tokens、run totals、aux callback 和 child aggregate 是不同层次的预算/
  展示数据；把这些再相加会重复统计同一个实际 provider 请求。旧 costState 也未证明所有权。
- title、手动 compact/context package 可在主 run 外或结束后调用模型，不能只在 run finalize
  截取一个静态快照；已收费但内容解析失败、流式失败后 fallback 也必须保留请求证据。

## 账本与身份

每个真实 provider attempt 有随机、稳定且不复用的 `requestId`。费用 receipt 包含：

- schema version、requestId、storage namespace、runtime instanceId。
- owning sessionId、runId（可空）、parent sessionId/祖先归属；不从全局 logger fallback 猜 SID。
- 用途：main、aux summary、tool summary、goal judge、title、context package、manual compact、
  subagent 或明确的 external source。
- 完整 provider/model 与可用的非敏感 connection identity，不做跨 provider 的模型名称合并。
- started/settled 时间、reported usage 或 unknown、费用估算和采用的价格来源/价格快照。

不保存 credentials、API key、原始 endpoint、prompt、messages、tool inputs 或响应内容。
外部 receipt 的 source/requestId 长度与输入大小有界，文件名由规范化身份哈希生成。

发送请求前持久化 pending；收到 provider usage 后以相同 ID 结算。attempt 结束仍无 usage、
或重启发现未结算的旧 attempt，保留 unknown，不补零或猜测费用。先获得 usage 再发生解析
失败时，已知 usage 不能被后续 error 分支覆盖。流式 fallback 的新请求拥有新 ID，分别计费。

Provider 的重试循环里，每次真正调用 SDK 建立新的 attempt；纯本地参数失败不建立收费请求。
内置 OpenAI/Anthropic 均在真实 SDK 边界接入。第三方 provider 使用公开的 usage accounting
helper；仅返回 aggregate usage 的兼容 provider 要明确覆盖级别，不能宣称有物理重试证据。

## Runtime、Session 与跨进程存储

Runtime 持有自己的 ledger handle 与 instanceId。请求归属通过显式 request owner 和局部
异步上下文传递；process-static legacy hook 不承担新账本路由。相同 SID 出现在不同的
Runtime/store namespace 中不会互相改写。当前 Runtime 汇总只读其拥有的请求，历史 host
汇总在明确授权后读取稳定 storage namespace。

持久化 root 从 host 明确配置的 session/accounting storage 派生；namespace 是可恢复的
Host identity，instanceId 区分并发与重启后的 Runtime。独立 SDK 默认使用内存账本，可显式
配置持久存储。Desktop 的多个 project worker 与 Main 的历史汇总应共享经审阅的 Host
namespace；不同账号、容器或独立 SDK 存储不能隐式合并。

Receipt 文件是 source of truth，单条原子发布/更新，pending 到 reported 单调变化。
请求 ID 唯一使不同请求不争同一写入；external 重发对同一 ID 校验 owner 与内容的一致性。
读取有日期/分页/条数上限并返回覆盖信息；索引是可重建加速数据，不能成为丢账的单点。
若需要锁，临界区只做同步有界读改写，不持锁 await；遵循仓库现有锁争用约束。

Session costState 仅保存 versioned ledger reference/摘要，不能 restore 整个 Runtime tracker。
resume、重复输入 replay 和 UI reload 读取相同 receipt；不重灌历史累计 totals。fork 新建
会话，不复制已收费 request identity。旧 costState 不具备可靠 Session 归属，显示历史覆盖
不足/兼容 counters，不自动将它迁为另一份已知账单。

## main、aux、child 与 external

普通 run 的 main/goal/aux 请求绑定真实 SID/runId。独立 context package、compact 和晚到
title 显式捕获其 source SID，不能依赖请求完成时当前 foreground SID。费用写入发生在
实际 usage 收集点，不等待主 run finalize。

子 Agent 的叶子 receipt 只计一次。父 Session 通过明确 parent/ancestor identity 展示包含
子任务的汇总；Runtime 合计按 requestId 唯一集合求和。现有 `recordBilledUsage(child.usage)`
继续服务 Goal/token counters，不转成第二条 provider 账单。恢复后的 child continuation
从持久 parent identity 绑定归属，不能相信调用方任意提交一个 parent SID。

外部收费入口必须提供 source、requestId、provider/model 及 usage/明确费用证据；Host 填写
owner。相同 requestId 的相同内容重复提交幂等，内容或 owner 冲突拒绝。只有旧 aggregate
usage 的调用保留预算兼容，但费用显示 unknown/unattributed，不按 primary model 猜价格。

## 价格与汇总语义

账本保留已知 token 估算金额与 unknown 请求计数。未知模型、未知费用、缺失 usage 均不会
被呈现成 `$0.00`。已知免费价格需要明确可信的零价格证据。缓存价格的启发式来源必须标为
估算；不把 lookup 的 fallback 当成已知真实报价。历史估算保留当时价格快照，不随以后模型
表更新悄悄改账。

Summary 同时给出 known estimated USD、unknown cost requests、unknown usage attempts、
request count、tokens/cache tokens、Session/模型/用途分组、scope 和覆盖说明；金额统一标示
估算，不能冒充 provider 发票。总费用有未知部分时显示“已知估算 + N 项未知费用”。

## 现有界面与协议

通过现有 `agent/query` 添加有界 usage summary 查询。Session 范围沿用 Session ownership
验证；host 汇总需要 Host 授权，Session-only 客户端不能借省略 SID 读取其他会话费用。
协议只返回安全 summary，不返回磁盘路径、密钥或原始请求内容。

TUI `/cost` 与 footer 使用 owning Session/Runtime 的 summary。Desktop 在现有活动记录、
运行详情/用量区展示费用覆盖与跨 Session 汇总；Web 使用已有运行/用量入口。沿用 preload/
host bridge 边界和 i18n，不增加侧栏、任务中心或新的业务主导航。

## 实施范围与验收

核心新增 `cost-ledger/{types,context,store,summary}`；调整 `cost-tracker.ts` 的兼容适配、
`llm/client-base.ts`、LLM types/内置 provider usage 边界、model facade、run accounting、
session open/finalize、auxiliary/title/subagent、Session persistence 与 protocol query。
Host 调整 stdio/TCP/TUI Runtime wiring，Desktop 使用现有 runs service/preload/RunsView/i18n，
Web 只修改现有用量消费。Phase D 不混入该 PR。

主要验收：

1. 两个 Runtime 并发使用同 SID、同 Runtime 两个 Session 混合 main/aux/child/late title，
   证明 leaf request、Session rollup、Runtime sum 分别隔离且不重复。
2. 本地 fake HTTP provider 覆盖缺 usage、真正零 usage、已 billed 后解析失败、stream 失败与
   fallback、重试收费、缓存计费；不调用付费服务。
3. external receipt 重发、owner/内容冲突、未知价格和缺身份兼容路径。
4. resume/restart/fork/replay/冷读/晚到 usage 恢复去重，损坏或未完成 receipt 的覆盖说明，
   存储失败不触发多余收费重试。
5. Session-only 协议授权、bounded query、UI unknown 展示、现有 sidebar 结构保持精简。
6. 完整受影响回归、package release/NodeNext、12 workspace types、Desktop build，真实已
   编译 stdio/TUI/SDK 消费者；每个结果在交付记录中区分自动测试与未执行的人工 GUI 验收。
