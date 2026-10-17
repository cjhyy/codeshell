# 本批质量复核

最终为 **6 个冻结基线 P3、2 个未确认候选**；其中一个冻结 finding 已在并行 main 源码中消除。没有为增加计数晋升合同不足或 fixture 失败的线索，也没有把旧 A03/A04 等再次报告为新问题。

root 核对四份报告、实际源函数、首次日志计数与失败错误、fixture/receipt，三份独立只读复核为：

- [Web worker 对 Git/Plugins 的复核](evidence/cross-review-web.md)。
- [Plugins worker 对 Git/Web 的复核](evidence/cross-review-plugins.md)。
- [Questions worker 对 Plugins/Git 的复核](evidence/cross-review-questions.md)。

Git 的 1→2 文件计数差异有明确 unique files 合同、普通/不同文件对照和官方 Git quote 格式支持；进程 guard 的四个测试均证明 nativeCalls=0。Plugins 的空参数合同是模块本身声明的 quoted tokenizer/placeholder 语法，不声称已测上游 Codex；named grammar/未知变量保留合同支持第二项；Windows 路径只作为字符串，guard 接线在 clone 前静态确认。Web MIME/大小只测客户端转换和 fake upload，不将回调接受当真实服务接受。

Mobile multiSelect 的 host 合同允许忽略展示 hints，没有明确 Mobile 多选验收承诺；相关 fixture import 失败而未运行。TUI 的非合批控制仍失败，所以原始结果不足以证明合批特异性。两者保持候选/SKIP，不因其他纯控制通过而升级。Questions 6 个 failed-shard expect calls 与 clean 203 分开，Bun skip0 也不代表没有跳过审查方向。

复核仅改文档引用、状态和收据：query.ts 消费者范围从 179–194 校准为 173–177；WEB-R8-01 单列并行 `658b8c6f...` 源级消除；插件 metadata collector 改用 NUL 路径枚举，工具响应转录保留，未增加产品运行。导航缺失路径等错误说明与 raw Bun log 分别标识。原始 fixture/log/exit 保持第一次执行的字节，不修复/重跑/改方法验证失败方向。

Root 首次汇总曾把所有 exit 收据假定为 `.txt`，实际 Plugins/Web 使用 `.json`；[工具诊断转录](evidence/root-assembly-note.md) 保留错误，只修汇总选择/解析，未重跑产品。最终材料以根 evidence-index 为准。源码整文件 hash 只定位冻结证据，不代表每行全部审查；39 个现有基线和25个聚焦观察/控制只是有限合同覆盖。没有全仓或真实 UI/API/native/跨平台/干净构建通过结论。

提交材料 whitespace 检查的唯一例外是原始 `questions-tui-batched-choice.first.log:21`：Bun 源码错误框打印 `62 | ` 的尾空格。完整 `git diff --cached --check` 因此返回 2；排除原始日志的检查返回 0。为保持首次 stdout/stderr 逐字证据，保留该空格，不把它当产品或文档源错误，也不宣称完整 whitespace 检查通过。

主工作区在审查中途新增与本目录无关的 CI workflow 修改。保留初始收据并补最终集成前快照，核对原始未跟踪文件仍一致；最终集成比较最新 snapshot，保持当前 CI/删除/未跟踪内容。没有为了满足旧 SHA 而恢复或覆盖其他写入者的文件。
