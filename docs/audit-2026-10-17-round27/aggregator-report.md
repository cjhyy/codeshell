# Round27 文件变更归组与外部工作树路径审查

冻结点由 Root 提供：`9b667863e8a8eb91db7b1f99eb9876169dcf19ec`。本方向 **1 项 P3 静态正式发现、0 候选、0 新关联**；作者执行产品、import、测试、fixture、React/browser、native、业务 Git、网络均为 **0**。源码值流不是实际点击或真实文件打开结果，没有修改产品或 Git。

## AGGREGATOR-R27-01 / P3：隔离 DriveAgent 的文件链接丢失工作目录

普通触发：本地 Desktop 会话工作目录为 `/repo`，通过支持的 `DriveAgent(isolation:"worktree", cleanup:"keep")` 在 `/isolated` 修改 `src/a.ts`。默认 `auto` 在有改动时也保留工作树。完成事件正确携带 `cwd:"/isolated"` 和 `changedFiles:["src/a.ts"]`；聊天自身仍使用 `/repo` 是正常状态。

问题在 [fileChangeAggregator.ts:295](../../packages/desktop/src/renderer/messages/fileChangeAggregator.ts:295)：函数先用正确 cwd 得到绝对 identity，却把剥除 cwd 的 `displayPath` 传给 `consume`，最终 `FileEditEntry` 只保存 `path:"src/a.ts"`。随后文件行使用聊天 cwd，静态构造的打开请求是 `/repo/src/a.ts`，预期应为 `/isolated/src/a.ts`。父目录同名文件存在时指向另一文件；不存在时该行也无法指向真实隔离文件。

值流和反证已核实：

- [DriveAgent schema](../../packages/coding/src/tools/drive-agent.ts:104) 明确支持单独 worktree；`:1068–1097` 选择工作目录，`:1164–1177` 将 launch cwd 设为新 worktree，`:1246–1270` 交给后台完成处理。无需畸形手工 DTO 或相对 Edit 参数。
- [完成处理](../../packages/coding/src/tools/drive-agent.ts:784) 对真实 job cwd 规范化相对路径，并把同一 cwd 发给 renderer。`:316–354` 的 keep 分支只解锁并保留工作树；默认 auto 在有改动时进入 keep，没有先合并或复制回父目录。[inspectWorktreeChanges](../../packages/coding/src/git/worktree/crud.ts:413) 只读取 status/rev-list，不能补偿根目录丢失。
- [renderer 事件](../../packages/desktop/src/renderer/types.ts:1986) 保留 cwd；[摘要类型](../../packages/desktop/src/renderer/types.ts:282) 只有 path，没有外部 root。`fileChangeAggregator.ts:81–84/288–300/331–335/366–372` 将根目录信息消去。
- [ChatView](../../packages/desktop/src/renderer/ChatView.tsx:1818) 和 [MessageStream](../../packages/desktop/src/renderer/MessageStream.tsx:609) 为整张卡传当前聊天的 conversationRoot；[文件行](../../packages/desktop/src/renderer/messages/FilesChangedCard.tsx:258) 调用 `openFileTarget(e,{path:f.path,cwd})`。[openWith](../../packages/desktop/src/renderer/chat/openWith.ts:36) 与 [bucket 事件](../../packages/desktop/src/renderer/app/usePanelBuckets.ts:918) 透传该 pair；[FilesPanel](../../packages/desktop/src/renderer/panels/FilesPanel.tsx:228) 按 revealFile.cwd 拼接相对路径。

同 cwd 的普通外部文件正常，job cwd 之外的绝对路径不会被该分支剥除。原 system marker 仍含外部 cwd，job/lifecycle 说明也可能提供手工定位路径；没有声称内容或工作树被删除。多个不同 job cwd 下同名相对文件还会产生相同的行 path/key，但它们属于同一个 root 丢失原因，不另计发现，也未观察实际 React warning 或 UI 行丢失。

本项限定本地 Desktop：`LocalRuntimeActionsContext` 默认 true，云 surface 显式 false。主会话自己的 workspace 即使解析正确，也不能恢复另一个 job 的根目录。修复应在摘要输出中保留可用的外部绝对 identity 或独立 cwd，并让行打开动作消费它；本轮只记录，没有实施。

## 查重与覆盖边界

[初始全历史库存](evidence/aggregator-dedup.json) 为 `docs/` 与 `bugs/` 的 **2596 文件（1250 MD +1346 JSON）**，含 archive/_archive，排除当前 round27；468104 JSON 字符串值、676635 标量、0 解析错误。完整文件 SHA 库存保存，名称/分组/旧项总命中 **465/237/36**，保留上下文 **220/220/36**。第二次 [身份补查](evidence/aggregator-dedup-supplement.json) 命中5/8；[接续语义补查](evidence/aggregator-resume-dedup.json) 逐文件重核同一库存字节，174 个 path component 小写后含 `archive` 子串的路径（若只算 exact `archive` / `_archive` 目录则为169，不混用），定向命中 **7/17/50**，全部保留。关键词和选读旧父记录不等于历史语义穷尽。

[历史决策](evidence/aggregator-history-decisions.json) 区分了两类旧 cwd 项：旧 dock 以 repo root 代替主会话 workspace；旧 DriveAgent 调研讨论外部 CLI 在 launch 后自行迁移，使 launch 快照陈旧。本项从正确、已知的 child launch cwd 出发，仅在 renderer 输出中丢失，不复报这些旧机制。旧 R13 Delete、`+++`/`---` 内容行、Move 家族仍保持此前失败方向 SKIP，不重跑或升级。

[源码清单](evidence/aggregator-source-manifest.json) 保存29个 source/contract pins、各自全文或选段范围及 filesystem SHA。大文件 App、ChatView、types、DriveAgent、FilesPanel 只读明确片段；没有通读它们或 compose 内部算法。作者没有执行 Git 对照，冻结 blob 的独立绑定由 Root 负责；先前作者的8个初始 byte pins 与接续当前读取相同，新增 pins 首次持久 hash 在本次阅读后捕获，未冒称具备 read-start SHA。

成功/失败工具过滤、last real user turn、injected continuation、同路径归组、已知净撤销、现有单 cwd external attribution 的测试意图已读，没有运行本方向测试。相对 native Edit 路径猜 external cwd 缺少强普通输入合同；external-only 空 snapshot 的未知与净空语义也未据此凑第二项。详见 [validation](evidence/aggregator-validation.json)。Root 的 compose 首次 fixture 导入失败属于另一方向，不借其16 pass/54 expect 支持本静态发现。

[metadata notes](evidence/aggregator-metadata-notes.json) 保留两个 locator 错误：猜测 MessageList/MessageItem 路径，以及把 re-export barrel 当函数定义文件；随后只按库存定位真实源码。没有产品失败后恢复验证。最终 [作者材料收据](evidence/aggregator-artifact-receipt.json) 校验自有文档/evidence 字节，不替代产品测试或全仓完成证明。
