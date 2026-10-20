# 第十七批冻结基线与并行主分支变化

本批所有产品首跑固定在 `d86db33012dffd5d1849e76b869fa15eb260324f`。收尾 fetch 已完成，origin/main 仍为 `02d5d9a9ecbbb206d5f3d8a1d367e7081d937101`；其他任务把本地主分支推进到 `ed07a8db9fe2682b67faf9e06f8461e906f880db`。本批工作树随后快进同步主分支，没有重跑产品验证。

[更新收据](evidence/main-refresh.json) 保存 8 个提交、10 个变更路径。变化涉及 Review header-only parser/新回归与操作测试、Panel 诊断 harness、另一任务验收文档。Root 对相关旧 parser 的产品 diff 做了只读核对；其他路径只作变更库存，不当成本批完整阅读或执行覆盖。本批实际验证的 helper 源码、普通 producer/contract pins 与仓库指令未变；全局 snapshot 中另行加入的旧 parser 则有明确冻结/当前差异。

其他任务提交 `9d7577249` 修改 `packages/desktop/src/renderer/diff/parseUnifiedDiff.ts`：从 `diff --git` header 提取 fallback 文件身份，并保留 add/delete 侧的 null 与后续内容/rename headers 的优先级。这对应旧 [R2-10](../audit-2026-10-17/root.md) 缺陷族，以及 [DESKTOP-R12-R1](../audit-2026-10-17-round12/desktop.md) 记录的 header-only 剩余边界。这里只确认源码变化，未执行旧触发、新回归、Git fixture、Review UI 或部署验收；没有关闭整个缺陷族，也没有恢复已跳过的 ApplyPatch summary 动态方向。

[addressed-sources](addressed-sources.json) 将该旧状态记录与本批 1 个正式 finding、3 个新候选和 0 个新增旧问题关联分开。旧源码、当前 main SHA 以及两个历史报告均被 [source manifest](source-manifest.json) 固定；整文件 SHA 不代表完整文件或所有子分支已重新审查。

[初始快照](evidence/integration-before.json) 保留启动 primary HEAD 与原有 dirty/untracked 字节；[集成前快照](evidence/integration-premerge.json) 反映外部 HEAD 推进。除 HEAD 外字段一致，4 个原有普通 untracked 文件和 tracked deletion 未动。仅本批 docs 路径属于本次待提交内容，持续全仓审查目标没有完成。
