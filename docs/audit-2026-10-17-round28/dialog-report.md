# Round28 Dialog state 与普通消费者静态审查

本方向 **0 formal / 0 candidate / 0 related**。Root 提供冻结基线 `32c633e58c20b3853f49bb0e43264b4577281eac`；作者未运行 Git，也未运行产品、测试、import、fixture、React/browser、VM、native、网络或模型。本轮只读源码/历史文档与文件hash，没有修产品或恢复任何旧失败方向。

按rg库存先固定before-read filesystem pins，随后完整读 [dialogState](../../packages/desktop/src/renderer/ui/dialogState.ts)、[unit test声明](../../packages/desktop/src/renderer/ui/dialogState.test.ts)、[DialogProvider](../../packages/desktop/src/renderer/ui/DialogProvider.tsx)、[interaction wrapper](../../packages/desktop/src/renderer/ui/DialogProvider.interaction.test.tsx)、[ConfirmDialog兼容层](../../packages/desktop/src/renderer/ui/ConfirmDialog.tsx)、[profileRequirements确认消费者](../../packages/desktop/src/renderer/digital-humans/profileRequirements.ts)，共 **653行产品/测试合同**，另2份指令222行。8 pins与各自初始bytes/SHA、finish SHA一致，见 [source manifest](evidence/dialog-source-manifest.json)。当前filesystem证明不回填为作者Git冻结blob验证。interaction wrapper引用的browser fixture没有展开或执行。

普通合同反证足够，本轮没有新的可达缺陷：

- `initialDialogState`为空，`enqueue`在无active时立即显示，其余追加FIFO；`resolveActive`空状态no-op，完成active后从queue取下一项。正常由这些操作产生的状态，不存在active为空而queue仍积压的异常形状。
- Provider的`open`用原生Promise创建resolver，正常值由Confirm的true/false、Alert的undefined和Prompt的string/null产生；Alert API又明确把结果映射void。reducer允许unknown是共享内部边界，不能仅据此假设真实调用方传了错误类型。
- `close`比较active request身份，陈旧或重复回调不能误关下一项；Promise resolver不是任意业务回调。人为构造throwing resolver、递归enqueue或改写caller-owned queue不能直接算普通产品输入，本轮也没有这类实验。
- Prompt按request在layout阶段重置defaultValue，composition与229键码阻止输入法Enter提交，Escape也有composition阻止分支。Confirm/Alert的外部关闭映射cancel/dismiss；optional confirm在没有Provider时返回false属于显式fail-closed合同。这些是源码反证，非本轮UI或时序验证。
- profileRequirements确实await boolean确认，并在依赖动作前后检查isCurrent；兼容层仅重导出hook/type。未建立普通Provider整体卸载后调用仍需继续完成的合同，不将悬置Promise猜测凑成候选，也没有扩展focus/native/竞态实验。

先做全历史去重再分类：[dialog-dedup](evidence/dialog-dedup.json) 覆盖docs/bugs全部 **2677文件=1262MD+1415JSON**，递归value scalar含506929strings/740424scalars，0 parse error；包括169 exact archive/_archive目录路径（substring archive口径174），排除current28。exact-source54、dialog-contract142、producer35是occurrence总数，保存context54/100/35，cap100；关键词和完整文件SHA不代表历史语义穷尽。结构化coverage prep缺少本路径不能证明历史未读：检索确实找到既有source inventories、旧测试收据和普通DialogProvider消费者。旧copied-module路径harness记录、旧settings/session消费者问题保留原因果，见 [history decisions](evidence/dialog-history-decisions.json)，没有重报。

[validation](evidence/dialog-validation.json) 的所有运行计数为0。已有6个unit test声明及interaction wrapper的6个scenario名称只作设计意图阅读；没有调用wrapper的Bun.spawn、真实Radix/browser或reducer。该negative只覆盖声明范围，不代表所有modal、浏览器交互或全仓已无问题。
