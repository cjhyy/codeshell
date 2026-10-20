# prep142：手机 pending 审批重放候选的独立反证复核

**建议撤回 APPROVAL-R141-C1 原“worker 退出后没有其它读取便长期保留缓存”的触发论证；本复核 0 新正式、0 活跃候选、0 new-related。** 这是已知假设的独立源码复核，已读冻结141的报告、候选和 manifest 元数据，非盲审。没有运行 worker、审批、React、timer、网络或测试。

关键反证是实际无条件启动的周期 reader，而非推测消费者可能读：Main `index.ts:2094–2107` 构造 PetImDecisions 的 `read`，先用 Bridge alive/generation 调用 `setWorkerState`，随后读 cache；`:2127` 正常初始化立即 `start()`。`pet-im-decisions.ts:139–143` 安排即时 tick 与5000ms interval；`:156–160` tick 的第一项工作就是 `options.read()`。所以原来“没有 outbound/native/Pet read 就无限残留”的缺省情景遗漏了真实周期读取。interval 注册并不是本轮观察到的清理时限或严格5秒 SLA。

## 亲读支持与限制

- `pending-approvals.ts:13–16` 在 dead/newgen 清 cache；`:57–63` replay 自身不采样，Root141 这项源码观察仍成立。Main `:1826–1831` outbound、`:6957–6966` native pending IPC、`:2097–2105` Pet read 是采样入口；不能从前两个入口不触发推断第三个不触发。
- 手机 `handle-client-event.ts:236–250/282–315/567–590` 的 select/sync，经实际 callback `mobile-remote-orchestrator.ts:245–268/332–367` 重放 cache。selected external route/recovery 源码未显示普通 native replay 前必定采样 worker；但这些选段不认证完整 authority/journal/连接机制，也不独立构成缺陷。
- Bridge `:435–479` 的 exited/spawn-error 分支发 renderer lifecycle 与 Pet projection，并维护 snapshots；所读 `safeSend:1145–1166` 为 renderer 通道。`getSnapshot:2019–2021` / last context `:2335–2337` 是本地数据。没有以单个 onExit 未直接调用 setter 证明所有 observer 缺失。
- `SessionSnapshotStore.ts:68/207–217` 表明 snapshot epoch 属 Main store，worker exit 只将所属 run 标 idle。手机 selected `useRemoteApp.ts:735–753` 在 epoch 改变时清卡，`:1251–1289` raw callback构造 approval；`useRemoteSocket.ts:189–198/245–253` 路由 raw notification。**这些范围不足证明完整客户端不会过滤旧卡**，因为被调用 helper/reducer及全部生命周期未展开。它们也不足把下一次 poll 之前的可能窗口单独升级为明确正常缺陷。
- 原生 renderer `useHostSubscriptions.ts:1054–1060` 在退出时清本地 Core cards；其 mount restore `:966–989` 有 invalidation 防护。Pet renderer selected lifecycle也会投影退出。这里没有声称原生清卡一定同步清 Main cache，或手机与原生实现相同。

因此保留“直接 replay 不自行采样”的局部事实，但不为了保住候选扩成任意5秒时序。当前缺少该窗口的完整确定普通触发、立即重放一致性合同及客户端长期残留闭环；未制造特殊调度、崩溃或坏 DTO，未声称死 worker 的旧审批成功执行、跨 generation 权限绕过或继任者接受前任请求。Root 可单独归档最终 disposition；冻结141原候选不回写。详见[候选复核](candidate-review.json)和[分类](classification.json)。

## 旧因、范围与冻结

亲读旧 `approval-quality-round10.md:55–81`：R19限定相同 alive worker 仍在等待、交付失败后普通卡消失；`:76` dead setter、`:77` resync 是相关保护。该旧条目不等于本候选已成立，也不因本轮轮询反证被清除。Root 共享[历史gate](history-gate.json)为5850 MD/JSON、4251467递归 JSON value scalar、0 parse error，纳冻57排58+；pending36命中均保留、cap100，机器扫描不是全史语义。实际窗口见[历史范围](history-read-windows.json)。没有再扫百万scalar或恢复旧失败实验。

[源 manifest](source-manifest.json)是13产品文件：1full（pending69与冻结141同SHA全文重叠）+12selected，701普通语义行，0测试声明；另2文件仅导航、2指令沿用旧实际读并核同SHA。显示已明确捕获的下限1409行；首次宽导航11150tokens输出截断，未知中段不算已读，见[首诊断](diagnostics.json)。后续用于语义结论的有界body均完整可见；机制边界实际显示不扩成全机制审查，不宣称新增唯一覆盖。

[初始pin](initial-pins.json)、[支持pin](support-pins.json)、[反证pin](counterevidence-pins.json)均先于本读者该源body/行号导航。[选段证据](source-excerpts.json)为实际显示后复制的已读范围，不运行其中表达式。[结束核对](ending-checks.json)17个源/指令pin、4个原历史/作者输入和共享batch全部同字节；不据此认证未来 Git 或全部历史成员。Root提供基线 `f31a847f45e4805bce34aeb9e6db7efb503cfcb0` 仅上下文，自身Git0。

[验证边界](validation.json)、[冻结检查](freeze-checks.json)、[作者输入pin](author-input-pins.json)、[自排除收据](reviewer-receipt.json)保留；元数据的 `checks.files=[]` 不冒充新的源码阅读或运行确认。
