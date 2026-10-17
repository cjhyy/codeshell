# 只读复核：Web 模型观测展示

复核基线 `65691923fa629970ac26dc04e35362a9c4ab57a8`。先按实际库存和 artifact/exit 回执定位材料；没有猜测日志后缀，没有执行新测试、产品 runtime 或 Git 写操作。只新增本复核文件。

结论：支持 [presentation.md](../presentation.md) 的 **0 确认 / 0 候选 / 0 旧关联**及有限覆盖表述；没有需要作者修正的阻断项。该结论不代表整个模型观测、UI 或 producer 链已验证无缺陷。

- [原始首跑日志](presentation-pure.first.raw.log)确有 **10 pass / 58 expect / 0 fail** 与 `Completed Bun shard: 10 tests, 0 skipped; 0 failures.`。命令与[退出回执](presentation-pure.first.exit.json)、[验证汇总](presentation-validation.json)一致；既有文件 5 项、自有 fixture 5 项，合计 10 项，只计一次。回执声明先保存首输出再读取；没有以本复核制造第二次运行证据。
- 阅读实际 Web 叶子、既有测试与自有 fixture。14 个显式类别、两种语言的非空且互异标签、未知类别不强制转换、request 与所选 attempt 的 wire 边界、media/external/event 优先级和输入未改写，均与实际纯函数和本地合同相符。fixture 使用内存 record/attempt/event；`approval` 仅作为 event kind 值传给边界函数，不涉及审批流程。类型导入擦除，没有通过 Core barrel 或 model-trace API 执行网络请求。
- 静态核对 `docs/model-observability.md` 的类别与输入边界、Core types 的 14 类/3 coverage、context 的 logical/wire/external 赋值及 store 的读时类别派生；核对 ModelTraceExplorer 的 badge/边界调用与标签接线。这些模块没有执行，不能把静态 producer 描述合成 backend/storage/Host/UI 的动态通过证据。报告保持了这一区分。
- [源码清单](presentation-source-manifest.json)的 **15 项**均逐一与冻结 Git blob 和当前文件重算 SHA-256 一致；[工件回执](presentation-artifact-receipt.json)的 **13 项**字节数、SHA-256 全部匹配；报告内 **7 个**本地链接均存在。工件回执不含自己，源码 pins 不等于全文件/传递运行覆盖。
- [去重脚本](presentation-dedup.py)与[结果](presentation-dedup.json)一致：1995 文件（1148 MD、847 JSON），253680 string leaves / 353952 scalar leaves，0 解析错误。递归包含 archive 并排除本批，JSON keys 不计叶子。匹配数 1/5/0/8 与每模式 16 个上下文上限分别记录，没有混淆截断与计数，也没有宣称关键词穷尽语义。
- 第十四批旧报告是不同 Desktop helper，本轮执行的是 Web 叶子；没有合并测试数字或恢复旧 backend/i18n 动态失败方向。[两项导航诊断](presentation-navigation-skip.md)明确是首工具响应转录、只读猜测错误；Core models 目录和旧 root-trace 文件均未被伪造为有效源码 pin。零 Bun 失败的表述没有吞掉这两项元数据错误。

本复核仅检查既存源码、日志、文档及哈希，没有 React 挂载、API/socket/历史、模型/provider、真实网络、原生进程或用户数据操作；没有 full-suite/build/typecheck/lint 结论。
