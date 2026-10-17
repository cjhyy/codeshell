# 第五批实际覆盖与持续缺口

冻结基线：`9a421b3e65d5bfe662b78062cb86bd99483a683a`。本批重新阅读当前源码，历史只用来去重；不是对全仓已完成的声明。

| 范围 | 实际证据 | 未覆盖 / 限制 |
| --- | --- | --- |
| Prompt / preset | 真实 scanner/composer/section loader/cache/preset assembly；自有嵌套目录；6 首次测试 / 33 expect | 实际 Engine/model、真实 Git boundary finder、全部指令冲突的模型结果、所有 preset/section 组合 |
| Profile | 类型/store/activation/resolve/requirements/switch-plan/run-setup 的 86 项既有测试；真实 catalog key/reader/remover 自有目录 4 项；共90 / 228 | 真实 acquisition/clone/install/export、Desktop UI/Host/model、跨进程发布、崩溃故障、用户资料库 |
| Chat 文本 | 真实 Mimi→ChatGateway→LINE send 与内存 transport；长度边界、共享 Unicode/空白分块；3 / 46 | 真实 LINE validation/send、平台界面、所有 adapter 的入站/出站/Markdown/重试组合；主源不足的候选仍未确认 |
| Web 状态 | 真实 reducer/snapshot/wrapChildStream，真实 Agent background branch+fake spawner；5 / 23 | 真实父子 Engine、Host/WS/浏览器/DOM、自动 wake 时序、发送按钮；乱序结果仅支持的 reducer 条件，无真实传输乱序声明 |
| 其他模块/仓库 | 保留前批冻结报告用于查重 | Desktop/Server/Host/Core其余模块、Coding/Pet、Link/CDP/diagnostics、Arena/Lab、scripts/package/release 等仍有未覆盖分支；独立 Panel Apps 未做全仓审查 |

7 个完整首次 guarded shard，104 pass / 330 expect / 0 fail / 0 skip。其中 86 是明确列出文件的现有 Profile/run-setup 基线，18 是本批新写的聚焦验证与 controls，不把它们冒称104个新缺陷测试。复核只读，不新增执行数。

没有产品修复、全仓 build/test/typecheck/lint、真实 provider/平台/账号、权限或安全实验。源码哈希只证明冻结快照，阅读深度由各报告分别说明；不能由 manifest 文件数推断逐行审查覆盖。新 main 并发变化另见 integration-context.md，首次测试基线不随整合改变。
