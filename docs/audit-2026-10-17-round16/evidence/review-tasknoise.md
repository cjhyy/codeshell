# Readonly cross-review: tasknoise round16

审阅者 `tabstops_round16`。本次只读作者报告、fixture、首次 raw/exit、validation、候选、navigation note、历史扫描摘要及 source/artifact receipts；仅新增本 review，不改作者材料，不运行产品、测试或 Git 写入。

结论：接受 **0 formal / 2 candidates / 0 related** 的保守边界，没有需要阻止汇总的材料问题。

- 首先以真实 `rg --files` 库存找到作者 receipt，再依据 receipt.rawLog 读取实际 ignored raw；没有猜测日志名。raw 为 **17 pass / 27 expect / 0 fail / 0 skipped / Completed**，与 exit 0、validation 的 1 clean shard 和 17 focused / 0 existing 一致。fixture 仅绝对导入实际 `detectPastedNoise`，没有导入 Engine、SGR/OSC/renderer。未执行第二遍测试。
- 静态核对 `task-sanitizer.ts:1–34`、`render-border.ts:17–29`、SGR 头部、OSC link:408–414、存档 utils:18。作者证明 dashed 字符和 colon/OSC 在真实 helper 中的分类差异，同时明确 renderer 定义、协议支持只是静态背景，普通 dashed UI 选择和保留原始 ESC 的传输链未证明，且 broad noise heuristic 没有穷尽合同；两项均维持候选，无产品会话/模型/终端后果声明。
- 静态核对 Engine:1684–1697 与 1725：`noise.cleaned` 仅用于拒绝分支提示，正常消息继续使用 `taskText`。作者没有把纯 helper 的 CRLF→双 LF 投影误报成正常任务被改写。TextInput:205–208 的 ESC 扫除也被用于限制 raw-control 普通路径推断。显式问题加密集框线的 rejection 被准确标为启发式边界，没有额外加 bug。
- 独立对照 **14 个 source entries** 的 frozen Git bytes SHA、当前文件 SHA 与作者 manifest，全部相符；scope 区分唯一 helper 执行、选段静态 producer/consumer 和 runner 执行，不拿 hash 相等替代动态覆盖。独立校验作者 self-excluded **11 个 artifact entries** 的 bytes/SHA，全部相符，含首 raw 和 fixture。逐一检查报告 **21 个本地链接**及源码行号边界，均存在。
- 作者两次元数据查询/猜测错误已分别转录首响应，明确组合 shell 最终 exit 0 不证明前面的 rg 成功，不虚构子退出码；猜测 entry 不在 manifest。没有将这些错误计为 Bun 失败或通过原始日志被修改后的重跑。

本 review 没有重新全量扫描历史，也没有新增普通生产路径证据；查重 1882 文件与 string/scalar 区分按作者摘要/JSON核对，不宣称语义穷尽。未恢复 round14 sliceAnsi 首次失败动态方向。
