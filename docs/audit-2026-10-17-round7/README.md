# CodeShell 第七批审查记录

本批新增确认 **4 项（1 P2、3 P3）**，另保留 **5 个候选**。仅记录审查、fixture 和证据，没有产品修复；持续全仓审查仍未完成。

冻结源码：`1b04838474bcd57212f80f791d0e268a00d347e3`。全部首次测试结果只归属于该基线。

| ID | 优先级 | 已确认问题 | 报告 |
| --- | --- | --- | --- |
| FILES-R7-01 | P2 | 单次 Edit 将替换文本中的 `$` token 展开，实际文件内容与成功 diff 不符 | [files.md](files.md) |
| FILES-R7-03 | P3 | Grep 的 Node fallback 仅匹配 basename，目录 glob 得到假阴性 | [files.md](files.md) |
| FILES-R7-04 | P3 | Read 超限错误推荐 offset/limit，但该分页请求仍被同一 size gate 拒绝 | [files.md](files.md) |
| PROV-R7-01 | P3 | Anthropic 参数事件的工具 id 落后一块，实时卡片显示前后工具的错误参数 | [providers.md](providers.md) |

Anthropic 的最终 response/Transcript input 保持正确，本批没有执行真实 Builtin、Engine、API 或 UI，不声称工具执行参数被调换。Grep 的缺命令条件通过内存 seam 注入，实际 `rg`/`grep` 没有启动。Edit/Read 仅操作自有临时文件。

[候选索引](candidates.json) 单列 Glob 的截断选择、OpenAI 晚到身份、Anthropic thinking 续轮和两个 TUI Diff 预测。Glob 缺少明确全体最新 200 合同，OpenAI 缺少正常 producer/有效流顺序证据，均经复核降级；另外三个候选所属首次 fixture 失败后跳过。原始测试和日志未随降级修改。TUI 与 Root 范围详见 [tui.md](tui.md)、[root-metadata.md](root-metadata.md)。

**9 次首次 Bun shard** 中，**7 个干净分片，69 pass / 372 expect / 0 fail / 0 skip**；包含 53 项现有 baseline 与 16 项聚焦观察/对照/候选测试，不能称 69 项新 bug 复现或全仓 gate。另 2 个失败分片保留原样：thinking fixture 完整结构断言遗漏自动 cache_control，TUI fixture 相对 import 路径错误。thinking 的 1 pass / 13 expect calls 单列，不并入干净结果。没有修复、重试或替代验证这些方向。

Root 翻译方向另在 metadata 收据准备阶段因硬编码的 checkout-local dist 路径不存在而停止，guarded runner 零启动，不计 Bun shard，也不证明实际共享 package resolver 或发布产物有问题。主题调用方导航搜索的 shell glob 失败单列为工具响应转录。Provider 收据组装的路径计算修正只涉及 metadata，未重跑产品测试。

机器索引：[确认发现](findings.json)、[候选](candidates.json)、[首次验证计数](validation.json)、[冻结源码清单](source-manifest.json)、[最终材料哈希](evidence-index.json)。去重、正常触发、对照和范围限制在分报告中；[质量复核](quality-review.md) 与三个只读交叉复核补充说明结论的边界。

没有真实模型、付费 API、账户、用户数据、外部消息、native/PTY、权限/安全/平台实验；没有重建依赖或共享 dist，没有全仓 build/typecheck/lint/test、干净安装或跨平台结论。既有失败方向保持跳过。独立的 `codeshell-panel-apps` 仓库未在本批做全仓审查。
