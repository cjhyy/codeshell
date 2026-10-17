# 三项旧问题的 source-stage follow-up

建议 MARKETPLACE-R37-01、MCP-R38-01、MCP-R39-01 分别记录 **source-addressed at Root-reported 07e / runtime not revalidated**。只对各自原触发条件提供当前源码依据，不清除原分类，不创建新 ID，也不是修复实现或运行复验。

我此前参与这三项的是 metadata/history/聚合复核，并非原源码作者或修复实现者；本次不是盲审。Root 提供 main07e5791b1fc1ad1fcfd5c55c2913d8a45f1b20cb 与 22 incoming paths 作为上下文，我没有独立 Git 认证。旧 catalog 的 latest111 等历史值未改写。

- **MARKETPLACE-R37-01**：普通 marketplace writer 把 cacheDir/version 写入安装记录，正常路径为 plugins/cache/marketplace/plugin/version；直接安装使用 plugins/name 并登记 local tag。当前 catalog 独立提供 installationKind，经 main summary/preload DTO 到 resolver，再由真实 PluginsTab 分派。resolver 不再仅凭 marketplace 名称 local 推断直接安装：marketplace-kind 的 local 走 marketplace 分支，direct-kind 才走 local 分支。因此旧普通命名冲突条件在所读 source 上已针对处理。此结论假定正常接受的记录/布局，不认证路径、symlink、realpath、manifest 绑定或 filesystem custody 正确性；没有卸载操作。
- **MCP-R38-01**：当前 full stdio editor 仍展示 join 的 Args 文本，但保存时，文本值等于 initialArgsText 就复制 initial?.args?.slice()，仅不同文本进入旧 splitArgs 路径。原未改 Args 的 quoted 参数边界因而不会再由 join/reparse 改写。只覆盖原 untouched/equal-value 条件，不认证整个 grammar、任意编辑意图、改后恢复同文本或生命周期。
- **MCP-R39-01**：saveEdit 根据 originalName 找 previous，仅显式携带 connectTimeoutMs、connectRetries、inlineImages；三个条件都是 !== undefined，保留 0 和 false。rename record 先放这三个字段，再合入只列 editor 字段的 patch，并在同一 payload 中 null 旧名；本地 savedNext 也携带它们。不是任意 extras 的无损 roundtrip 证明，也不外推 override、后端事务、连接或认证行为。

完整边界见 [stages](stages.json)。[source manifest](source-manifest.json) 共 10 份产品源，1 full（resolver29行）、9 selected，350 语义行、671 显示行；显示相邻范围不扩大审查。读前 [initial pins](initial-pins.json)、[producer pins](producer-pins.json)、[patch pins](patch-pins.json) 已保存，[结束检查](checks.json) 全 10 个 SHA 未变。[源码片段](source-excerpts.json) 仅为阅读后的元数据快照，不重复计覆盖。

[metadata notes](metadata-notes.json) 如实记录两个猜文件名未命中、head70 的导航界限，以及误选 catalog88–98 相邻 custody 片段只显示、未纳语义且未展开的边界。没有重新打开旧失败实验方向。没有本次 fresh 全历史扫描，也不声称历史语义穷尽；本任务仅对 Root 已指明的三个旧条件做 source follow-up。新 formal/candidate/related 均为 0，产品/helper/import、测试正文/执行、fixture、UI、native、网络、进程及 Git 调用均为 0。冻结文件见 [receipt](reviewer-receipt.json)。
