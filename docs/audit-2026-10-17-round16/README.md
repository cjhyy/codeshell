# CodeShell 第十六批审查

冻结源码：`ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f`。本批审查 TUI tabstops/bidi 与 Core task-sanitizer/memoize。**0 项新增确认缺陷，6 项新候选，0 项新增旧问题关联计数。** 持续全仓审查仍在进行，没有修改产品。

| 候选 | 实际证据 | 未验证边界 |
| --- | --- | --- |
| [TAB-R16-C1](tabstops.md) | 实际展开/测宽得到 9；静态 writer 从绝对列 5 的独立算式为 12 | DOM/Yoga/writer 与最终布局未执行 |
| [TAB-R16-C2](tabstops.md) | 手造 SGR 切开 ZWJ 字素时，实际 tab 空格数和测宽改变 | 未建立普通高亮 producer；终端 glyph 未验证 |
| [TASKNOISE-R16-C1](tasknoise.md) | 实际 helper 未识别项目定义的 dashed 框线；solid 对照被拒为噪声 | 无穷尽 heuristic 合同或普通 UI/粘贴生产链 |
| [TASKNOISE-R16-C2](tasknoise.md) | 实际 helper 未剥离 colon SGR/OSC；基础/分号 SGR 对照正常 | 普通输入保留原始控制串的链路未建立 |
| [BIDI-R16-C1](bidi.md) | 冻结源码提取谓词漏检 Adlam；其他已列脚本及 ASCII 控制正常 | 未执行实际 module/export/library/platform gate/终端 |
| [BIDI-R16-C2](bidi.md) | 静态重排对象与直接 writer 没有可见的奇数级镜像步骤 | 未运行完整算法；下游 glyph/字体责任未核验 |

均保留候选、不定严重级别。[findings](findings.json) 为空，[候选机器记录](candidates.json) 逐项区分观察、静态推论和普通生产者缺口。[related](related.json) 为空；旧 Skill/cache、ANSI Parser 宽度、sliceAnsi/i18n 等只作排除，未恢复已跳过的动态方向。初看 bidi regex 双反斜杠的猜测已被原始字节和对照否定，没有登记为问题。

4 个 **首次 guarded Bun shards** 均完整完成：**40 pass / 111 expect / 0 fail / 0 skip**，全部是新增聚焦观察/对照，没有既有 suite 执行主张。33 个测试执行实际纯 helper 模块，7 个仅编译冻结源码提取谓词。原始 combined stdout/stderr 与 exit 先保存再查看，没有产品重跑；通过只证明这些观察/控制成立，不表示候选已修复或系统完整通过。[validation](validation.json) 保留每个实际命令及 scope。

[memoize 专项](memoize.md) 没有新问题：7/36 验证 resolver/参数、undefined/falsy 缓存、side-channel key、clear 和同步 callback 异常控制。scanner/loader 仅静态读取，没有执行目录扫描或失效策略。Tabstops 预 import 将 Core barrel 缩为实际 intl segmenter，真实 tokenizer 和 Bun.stringWidth 保留；没有替换宽度函数、运行 JS fallback 或真实终端。Task noise 的 cleaned 只在静态拒绝提示中消费，不能外推为正常 taskText 被改写。Bidi 两个 TypeScript 签名注解以外的函数原文不变；完整重排仍只有静态证据。

全历史查重覆盖本批外 docs/bugs 的 **1,119 Markdown + 763 JSON = 1,882 文件，222,452 JSON 字符串叶子**，含存在的 archive/_archive；Tabstops/Tasknoise 同时统计 **309,912 全标量叶子**，两口径明确分开。0 JSON 解析错误，关键词计数与保存上下文上限分开，不宣称语义穷尽查重。

四份只读交叉复核：[Tabstops](evidence/review-tabstops.md)、[Task noise](evidence/review-tasknoise.md)、[Bidi](evidence/review-bidi.md)、[Memoize](evidence/review-memoize.md)。[source manifest](source-manifest.json) 为 36 个去重的选定源码/合同路径，49 次逐 worker 源码核对；[worker integrity](worker-integrity.json) 核对 40 份 worker artifacts。冻结/当前/main 字节一致，整文件 SHA 不代表整文件或所有依赖已阅读。[evidence index](evidence-index.json) 保存本批 bytes/SHA（自身除外）；raw 原样保留，metadata 导航/collector 失误均有首次响应转录且不计 Bun 失败。

最终 [汇总只读复核](evidence/review-aggregate.md) 无阻断意见；[Root evidence 复核](evidence/root-qc.md) 记录提交前要求。Tabstops 的 column 初始化链接已从第 21 行校正为实际第 22 行，只更新报告和材料 SHA，没有改源码/fixture/raw 或重跑产品。

主分支并行更新仅涉及另一路 CI workflow/验收文档，见 [基线更新](baseline-refresh.md)；初始与刷新后的 primary 快照分别保留，原有 dirty/untracked 字节不变。没有真实模型、付费 API、账户、用户文件、外发消息、产品网络/native/PTY、auth/permission/security/custody/watchdog 实验、共享依赖/dist rebuild 或全 build/typecheck/lint/suite/E2E 通过主张。独立 codeshell-panel-apps 仓库未作本批全量审查。
