# 第十七批只读交叉复核：prompt 指纹

复核者：`message_mappers_round17`。只读检查作者现有报告、fixture、首次 combined raw / exit、preflight、source manifest、历史去重结果与所列消费调用段；**没有新增 runtime/test、重新导入模块、编译/提取执行 Desktop 代码或进行 Git 写入**。

结论：接受 [fingerprint.md](../fingerprint.md) 的 **0 formal / 0 candidate** 与有限覆盖表述，本次无需作者改动。

- [首轮 raw](root-fingerprint.first.log) 明确为 7 pass / 34 expect / 0 fail，guard 报 7 tests / 0 skipped / 0 failures / Completed；[exit](root-fingerprint.first.exit.json) 为 exit 0、firstRun true，唯一命令是规定的 guarded runner + 自有 fixture。raw SHA256：`9e9377873ffd34cf3ff952b54c14dbd70292028d9a63f0b470f8890db823b4ed`。
- [fixture](root-fingerprint.test.ts) 共有 7 个测试：前 6 项直接调用 server 的实际 leaf helper；第 7 项只读取自有 checkout 源码，定位并比较 Desktop/server 函数体及 SHA。它没有 import Desktop module，没有执行/编译提取的 Desktop 函数。fixture SHA256：`7439518780fb302dcab6cc218f29dd900c75aadb00c92bd06e205e8c3a3bf86f`。
- 直接输入包括空串、普通英文/中文/多行、完整 emoji、组合重音、空白、CRLF/LF、自有多段正文；断言是确定性、现有 UTF-16 长度后缀、形状和调用者输入保留。没有构造数学碰撞或声称输入全集唯一，多段正文没有被宣传为性能基准。7 项均为本批 focused，无既有 suite 通过计数。
- [source manifest](root-source-manifest.json) 的 8 个路径逐项重新与当前 bytes 和冻结 `d86db33012dffd5d1849e76b869fa15eb260324f` Git blob 比较，byte size/SHA 全部一致。whole-file hash 与 full/selected scope 分开，Desktop counterpart 只作源码一致性，运行时依赖 transcripts 的整模块未导入。
- 只读消费片段核对了 automation-host 的 job id + 原 prompt 指纹透传、useHostSubscriptions 对已提供 id 的优先使用/trim fallback、mobile-chat-turn 的 session/run/trim/附件摘要组合。报告没有将这些静态接线升级成真正提交、实际去重、重复消息或任务丢失验证，也没有假设不同前缀/trim 策略必然错误。
- [root-dedup](root-dedup.json) 为 prior docs/bugs 全部 1,134 Markdown + 804 JSON = 1,938 文件，239,449 **string value leaves**，0 parse errors，排除本批并包含 archive/_archive。23/39 为实际关键词匹配总数，120 是每类上下文上限；报告正确区分了计数与语义覆盖，没有误称全部 scalar leaves 或借历史测试当本次测试。
- [preflight](root-fingerprint-preflight.json) 仅实际已知两份源码的存在与冻结字节，不是 resolver / Desktop import 验证。没有发现 fixture/navigation 失败后的替代运行或扩大测试范围。

该结论仅审核这份分区记录及证据一致性，不宣称完成所有身份链路、renderer、网络/host、存储或 Engine 审查。
