# 本批选题、静态库存与排除记录

冻结点 `c1d007ed0af1eca9b56b32fabbb0ea2401037ee1`。Root 本方向 **0 新正式项、0 候选、0 新关联、0 产品尝试/测试**。本文件记录更广的实际源码阅读和负提案，不把哈希、已有测试或不同数字组合当成新缺陷。

[源码 manifest](evidence/root-source-manifest.json) 为 Root 本轮 33 个读取文件逐项标明 full / selected、冻结字节和边界。其中包含 RunQueue、read-stdin、参数投影，以及 Server response lifetime、Room history、模型配置/语音、Chat media/canary、Link recipes、输出整理、导出和 hook 等选题读取。full static 只表示展示并阅读了该文件，不代表其所有合同、依赖或跨层流程均已审完；这些初选模块没有被 Root import 或执行，也没有运行队列、取消、额度、凭据、进程、下载、真实 stdin、审批、sandbox、恢复、身份或文件历史操作。Product、cron、Room 的独立分审负责其各自更深范围。

全历史 docs/bugs 的 MD 与递归 parsed JSON 标量去重，含 archive/_archive、排除本批；本次读数为 **2,301 文件 = 1,213 MD + 1,088 JSON；335,490 字符串 / 472,091 全标量，0 parse error**。[完整库存与有界上下文](evidence/root-dedup.json) 的 stdin source/behavior 为 15/5 次；RunQueue/params 为 169/155 次、各最多保存 100 上下文。计数含被复制的历史片段和库存噪声，不构成语义穷尽。[决策收据](evidence/root-dedup-decisions.json) 分开保留：

- `read-stdin` 的实际叶子及现有 5 个测试已静态读取，但去重发现[既有 NDJSON 记录](../audit-2026-10-17-round21/ndjson.md)明确将旧 CLI data/read-stdin 列为失败后跳过的方向。本批在任何测试前排除，没有用新的 owned stream 入口恢复它。`main.ts:88–116` 只静态证明普通 positional/piped 调用，不运行 CLI 或默认 process.stdin。
- `RunQueue` 的 FIFO/dedup/pending cancel/sync executor failure 已由[第十批](../audit-2026-10-17-round10/runs.md)和[早期运营审查](../audit-2026-10-17/operations-memory.md)保存基线。本批不重复运行，不从构造参数的自造无效值推断新普通故障。
- 参数投影的正常 false/0/空值、多个 dotted wire path 及 parent/child 冲突观察都已由[第十批目录审查](../audit-2026-10-17-round10/catalog.md)覆盖；没有新的普通 preset/冲突优先级合同，不新增候选或强行构造 runtime。

上一批异步交付的 [utils 负提案原件](evidence/root-prep/proposal.json) 已保存副本。其 29 路径库存、10 个 source pins 与 5 个作者材料字节均重新核真；本批冻结点的 10 个源码 hash 仍与旧比较点相同。Root 此处只读提案及收据、核 hash，**不把此前 prep 阅读算成本批 10 份全文新覆盖**。同名排序属于已知 OM3 且其首个动态组失败；format、JSON、Unicode 等也没有新的独立范围，因此不推荐 fixture。该副本原来记录的 `/tmp` 绝对路径与 `7e557`→`c1d007` HEAD 时点作为 provenance 保留，没有改写成新的运行或新合同。详见 [本批复核](evidence/root-prep-current.json)。

prep 历史读数为 2,301 文件、335,488 strings / 472,088 scalars；Root 当前读数多 2 strings / 3 scalars，来自读取时点之间已完成的 round22 元数据，不把它们混作同一次扫描或要求最终 main 语料永不变化。

一次初选 `rg --files ... | head` 包含猜测的不存在目录 `packages/core/src/plugin-system`，stderr 报 `No such file or directory`，组合管道工具 exit 为 0（末端 head），不能记录成产品成功或 Bun 失败。未沿该猜测目录修复/替代验证；已存在的其它库存输出仅作选择。本批首次 fetch 返回 session82277，后续同一 handle 正常完成 exit0。没有失败测试、fixture 修复、产品重跑、依赖/dist 重建或新外部合同查询。

主审仅写审查材料并负责隔离分支集成；未修改产品，也未声称全仓完成。此负选题记录不会压缩“所有内容继续找 bug”的目标。
