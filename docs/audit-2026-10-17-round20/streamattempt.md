# TUI StreamAttempt：请求撤销过滤

冻结源码 `d40dd06987a2e0c20c377e243cf5c4e4b549c9ec`。本 lane 新增 **0 个正式问题、0 个候选、0 个旧机制关联计数**；这只表示所选 leaf 和普通输入控制未形成新问题，不能外推整个 TUI、流式回退或重放链路。

实际执行 [StreamAttempt](../../packages/tui/src/ui/stream-attempt.ts) 的 `begin`、`clear`、`revoke`，只使用调用者拥有的普通 `ChatEntry` 数组和字符串 ID。该文件唯一导入是 `import type`；[store](../../packages/tui/src/ui/store.ts) 仅作为擦除的类型来源，未导入 store runtime。十个 [focused cases](evidence/streamattempt-focused.test.ts) 加两个既有 leaf tests，共 **12 pass、28 expect、0 fail、0 skip，Completed**，首个 guarded shard 退出 0。命令及首跑保存顺序见 [receipt](evidence/streamattempt-first.exit.json)，原始 stdout/stderr 合并字节见 [raw](evidence/streamattempt-first.raw.log)。未重跑；两个既有 case 是 round7 已有 baseline 的重复控制，不是新复现。

测试验证：错误 ID 的撤销不消耗当前 attempt；`begin` 拷贝已有 ID 集合而非保留调用者数组；已有四类临时行仍保留；新增主代理 `assistant_text/thinking/tool_start/tool_running` 被删除，同类 child 行保留；user、result、error、status、system、agent 起止行按原顺序和对象引用保留；过滤不修改输入数组或行；`clear` 后重新开始采用新快照；撤销后同一 correlation ID 能重新开始；缺失 optional ID 不误匹配字符串 tombstone；两个实例状态独立。输入缺失 ID 的 case 只描述类型允许的 leaf 行为，未推导普通产品缺 ID 的 bug。

[App 选段](../../packages/tui/src/ui/App.tsx) 静态显示，主代理 `stream_request_start` 先 flush，再对当前 entries 调用 `begin`，随后关闭旧 streaming 行并添加新 thinking；主 tombstone 调用 `revoke`，匹配后清 buffer 并替换 entries；主 `turn_complete` 清 attempt。选段行 584–660、716–777、825–960 的来源和完整文件 hash 见 [source manifest](evidence/streamattempt-source-manifest.json)。未 import、mount、镜像或执行 App/React/Ink/ChatStore，没有真实 UI、timer、provider、网络或工具执行。

Core 仅静态阅读普通 producer 选段：`turn-loop.ts:1119–1123` 提供 `assistantMessageId`，`:2109–2115` 先撤销主消息和工具 placeholders，`:2219–2223` 在 fallback 返回后重开相同 correlation ID。实际 TurnLoop、Engine、ModelFacade、真实/伪 provider、transport/replay/accounting 都未运行。源代码顺序不能证明异步端到端时序、异常传输或真实 TUI 的效果；没有把人为乱序、重复 ID、基线行原地修改的构造变成产品 bug。

全历史去重扫描覆盖 docs/bugs 的 **2109 个 MD/JSON 文件**（1176 MD、933 JSON，含 archive）；递归 **267491 个字符串叶、373239 个全部 scalar 叶**，0 读/解析错。只搜索字符串，完整计数与最多 24 个上下文分开，见 [dedup](evidence/streamattempt-dedup.json)。关键词索引不代表语义穷尽。已核对 [round7 baseline](../audit-2026-10-17-round7/tui.md)、[旧 Desktop F-01](../archive/review-2026-07-09/03-optimization-findings.md)、round17 history mapper 和 round9 provider/history 配对范围，见 [decisions](evidence/streamattempt-dedup-decisions.json)。这些旧机制均未新计，旧失败 TUI Diff/Question 方向未恢复。

一次只读导航误列不存在的 `packages/core/src/model`，rg 退出 2；该猜测方向直接跳过，未变成导入或依赖失败证据。一次历史只读输出截断，只使用完全显示的 F-01 段，其他内容不计完整阅读。两者首响应与边界记入 [metadata skips](evidence/streamattempt-metadata-skips.json)，不属于 Bun 失败，未触发动态修复或重跑。准备阶段还按实际 `lineCount` 修正 source manifest 中两个显示范围文字，未改 fixture/raw。其余结果见 [validation](evidence/streamattempt-validation.json)；全部修改仅为审查文档和证据。
