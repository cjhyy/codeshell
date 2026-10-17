# 主审材料质量核对

冻结测试基线 `4ee32f28f78b8315112cca77cfc22b2f2f80ced6`；整合时并发 main 基线 `51761b53399cc5daa1823d60b6cfdf52b1237ebe`。本页只记录材料/源码差异核对，不增加产品测试或发现。

主审读过全部 7 个确认项的分报告、首次 fixture/raw log、收据与相关源码。CTX 两项分别为 prefix boundary 工具对失效、structured summary 文字遗漏；LSP 两项分别为 URI 输出转换、文档同步；Settings 两项分别为 YAML 基底选择、已知字段非法类型；日志一项为跨 bucket 排序。不同入口但相同根因的案例在各项内合并，没有把 controls、候选、旧 image 编号、旧 LSP lifecycle 或失败支架计为新 bug。

成功收据逐组核对为 Context 2+2 / 15+14 expect，Settings 5+4 / 31+15，Coding 8 / 32，Root retention 2 / 7。总计 **6 个完整首次 shard / 23 pass / 114 expect / 0 fail / 0 skip**。两份失败 raw log 独立保留：CLI 0 pass/1 fail/1 error，未打印 expect 总数，聚合保持 null；recorder 0 pass/1 fail/2 expect。都没有 Completed。失败后的原始文件未修、未重跑，没有以不同方式补成成功。

独立复核已完成，新增产品执行均为 0：[quality-settings](quality-settings.md) 核对 Context/Coding；[quality-coding](quality-coding.md) 核对 Settings/Root 两份失败及日志；[quality-context](quality-context.md) 核对 Coding/Root retention 和 CLI。接受的精度意见：SET-01 汇总写成 fresh manager 读到持久遮蔽，明确实际 app 重启未执行。Coding beforeExit 没有在 Bun 首跑触发，报告已有披露；没有为了追加输出重跑或篡改 raw log。

主审在线读到 Microsoft 官方 [LSP 3.17 didOpen 源文件](https://raw.githubusercontent.com/microsoft/language-server-protocol/gh-pages/_specifications/lsp/3.17/textDocument/didOpen.md)，核对同一文档 open/close 必须配对、打开期间内容由 client 管理的合同。严格 fake 的陈旧诊断仍只是假适配器观察，不扩大成特定真实语言服务器实测。其他确认实验没有网络需求。

并发 main 的差异范围见 [integration-context](integration-context.md) 与 [upstream收据](evidence/integration-upstream.json)。直接缺陷实现没有变化；Engine/TurnLoop 相关 diff 只作静态接线检查，所有首次源码/行号/动态收据仍保持原冻结基线。主 source-manifest 记录冻结 blob SHA 及当前相等状态；不能把它解释成两个变化大文件的全文当前 hash。当前未对新 main 重跑实验，也没有用另一任务测试结果作为本轮门禁。

材料验证包括唯一编号、报告/源码行号、所有本地 Markdown 链接、冻结 source blob SHA、最终 evidence-index SHA、收据计数与 staged 路径只在本任务目录。八份被 ignore 的 raw `.log` 仅在本任务 evidence 下显式 force-add。完整 staged `diff --check` 只有一条例外：`root-cli-data.first.log:7` 原 Bun 代码框空行包含一个字面尾空格。原始日志原样保留，排除日志后的材料空白检查通过。

没有 clean build、全仓 suite、typecheck/lint、真实 app/CLI/语言服务器/模型、跨平台或实际用户数据验收声明。最终审查记录只写本任务路径；主目录原有 dirty 状态、tracked diff 与四个未跟踪文件 SHA 在整合前后单独核对。持续 goal 的 worktree 保留用于后续批次。
