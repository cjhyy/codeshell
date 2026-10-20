# Root frontier 独立静态复核

冻结点 `c1d007ed0af1eca9b56b32fabbb0ea2401037ee1`。复核 [frontier-selection.md](../frontier-selection.md)、Root source/dedup/分类/收据及 prep 副本。结论：**未发现需阻断或升级的问题；保留 0 新正式、0 候选、0 新关联、0 Root 产品尝试/测试。** 本 reviewer 只读文件和 Git 元数据，没有产品 import、fixture/测试、SDK/模型/网络 API、真实 stdin、队列、权限、FS 历史或 native 执行，没有修改作者材料或 Git；只新增本文件。

独立核对 [本批源码清单](root-source-manifest.json) 的 **33 条记录**：当前 bytes、行数、SHA 和冻结 Git blob 全部相符。scope 中为 **29 full exploratory/static + 4 selected**，包含历史报告，不应理解为 33 个独立产品模块动态或完整语义审查；作者明确限定 full 仅为静态读取，相关复杂消费者、传递依赖和业务动作没有执行。本复核只独立核字节及选定合同/排除依据，没有把 hash 核对冒充自己全文阅读这 33 份源码。

[prep current](root-prep-current.json) 的 **10 个 pin** 与当前、当前冻结点以及 prep 原 manifest 的冻结 SHA 全部一致。它们保持“前批准备、Root 只读提案/核 hash”的等级，未混入本批 33 份阅读范围或 runtime。原始 prep 的 29 行库存、5 个 artifact 的 bytes/SHA 在自包含副本中均可核对；绝对 `/tmp` 路径只作 provenance，没有访问该路径执行脚本。Root [作者收据](root-artifact-receipt.json) 最新的 **15 个 artifact**（含 prep 副本与原收据）全部 bytes/SHA 相符；本次核对采用 fetch 标签订正后的 report SHA `480122a7ff4572d6d6e0d56cda1ed46e5cd46a393afb385a42f58d76019793f8`。报告的 **9 个本地链接**全部存在。

实际读取 prior NDJSON、round10 runs/catalog，以及 operations-memory 的 1–70 行，确认三条主要排除依据：旧 CLI data/read-stdin 明确属于失败后跳过方向，Root 在任何执行前排除，不借 owned stream 恢复；RunQueue FIFO/dedup/pending/sync failure 已有基线，本轮只静态；参数 wire 的普通 false/0/dotted 控制和无更强普通合同的 parent/child 冲突已记录，不新增候选。Main 88–116 行只静态支持 positional/piped task 调用，不能据此声称实际 CLI/stdin 或错误退出通过。OM3 的首个动态组失败与已有排序观察已在旧报告 29–36 行明确，本批 prep 也保持不恢复。

Root 历史库存与本 reviewer 独立 Room 扫描的文件路径/SHA 集合完全相同：**2,301 文件，1,213 MD / 1,088 JSON，335,490 string leaves / 472,091 scalar leaves，0 parse errors**。Root stdin source/behavior 的15/5次匹配均保存；queue/params 为169/155，分别只保存100，未误写为全部已逐条审阅或语义穷尽。Root 决策收据也保留此限制。

prep 的 strings/scalars 少2/3这一读数差异可进一步定位：两个库存唯一 hash/bytes 不同的文件是既有 `docs/audit-2026-10-17-round22/evidence-index.json`，从14,213增为14,376字节，符合旧批索引收束时点变化，非本批产品输入或执行差异。作者没有把这两份读数合成一次扫描或要求历史语料永久冻结，处理正确。

Root 记录的不存在 `plugin-system` 库存目录、管道末端 head 导致工具 exit0 的元数据失败已明示，未充作产品成功或 Bun 失败；没有恢复该猜测目录验证。Fetch 叙述现为“本批首次 fetch session82277”，没有再误标为 end-fetch；这只是审查 Git 元数据。Root 其它分审的产品尝试另行分账，不能混进本方向的0。没有将负提案、重复基线或更多数字组合计为新缺陷，也没有全仓完成或完整验证结论。
