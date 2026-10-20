# Round30 data-frontier 独立静态复核

支持作者 prep 维持 **0 new formal / 0 candidate / 0 new-related，1 existing-cause exclusion**。在声明范围没有发现需要修改作者分类或证据元数据的问题。父上下文保留 `b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`，这不是尚未建立的 Round30 正式冻结基线；reviewer 0 Git，后续正式化仍由 Root 绑定当前源码。

复核先等待作者明确 freeze，再把其11个产物以及12条 source rows 固定为 durable pins，之后才读最终 proposal/decisions 和普通源码链。两 leaf 更早的独立读前 pins 保留在 [initial-pins](initial-pins.json)，跟随 source 的读前固定在 [consumer-initial-pins](consumer-initial-pins.json)；[author-freeze-pins](author-freeze-pins.json) 与结束检查证明作者文件没有被本次复核改动。新增材料仅在本目录，没有修改 Round29 或作者目录。

## 原因与普通调用链

`parse-log.ts` 全文29行仍按行拆分、再按裸 `|` 拆字段，hash取前8位；空白行跳过，缺字段补空串。实际 `utils.ts` 的 getGitLog 使用 `%H|%s|%an|%ci` 后调用该 parser。coding dynamic context 用 hash/message 生成 Recent commits，TUI /commit 用 message 拼近期风格提示。这些仅为源码读取，没有实际 Git、provider、TUI命令或模型运行。

October16 root 的 A04 已明确记录合法 subject 含竖线时标题截短、author/date错列，以及上述 dynamic context 和 /commit 两个后果。R13 git-text 又明确排除了相同 A04。当前源码没有提供新的因果边界或独立合同，不能把多读到一个消费者重新计为新 bug。R13 的8旧pass/17expect未借作本轮验证，A03 status trim 等邻近旧问题也未另报。

`channel.ts` 全文193行描述实际实现的 capability DTO、内建矩阵与兼容 helpers。显式 adapter.capabilities 优先；旧 supportsOutgoingAttachments=true 时返回全种类兼容能力，否则返回默认值；kind predicate 对 outbound.attachments 做 membership。webhook predicate按声明的 webhookPath 形状收集 adapter。普通 chat-gateway 只对 collected webhook 配置 ingress；gateway 会把能力交给 reply builder，catalog 按 channel 收集并以当前准确 adapter 的能力覆盖同名项。

所读普通调用链没有建立能力对象被意外修改或字段/消费合同相反的具体反例。这里没有声称导出的对象运行时不可变、所有平台限额准确、transport 已实测或完整 threads 受支持。随意修改共享对象、构造违反接口的 adapter，均不自动成为普通调用方证据；实际 adapter、平台 send、配对与身份机制没有实验，也未扩展审查。旧 Slack/附件证据及 Discord 首次 import/editReply/chunk 失败保持既有分类，未恢复其动态方向。

## 实际阅读与历史边界

独立完整阅读两个 leaf222行和两个既有测试声明126行，另选读 getGitLog producer、coding/TUI消费者、chat-gateway/gateway 共252行，合计 **9个产品/测试路径600行**。旧 root1–45与R13全文33合计78行，11条实际语义 source rows 的精确范围与 tool chunk 在 [source manifest](source-manifest.json)。media.ts 仅 hash，没有阅读；两项指令沿用此前全文读且SHA相同的内容，本轮只是核hash，新增语义行数0。

作者先前的两个旧报告 dedicated pins 晚于 scanner excerpt 阅读，所以其 initialSemanticReadSha256=null应继续保留；reviewer 独立 source pins 先于本次直接读取这两个报告。双方均没有逐片段精确读取时间，manifest以真实 pin UTC、执行片段和最终检查界定先后，不倒填未知时点。全文SHA不扩大selected范围。

本次读了作者保存的全部16个 channel 上下文；许多是旧查重JSON、threads边界说明或设计草案，不能把草案能力当当前实现合同。作者旧历史库存2765项（1275MD/1490JSON）逐项核当前字节全部匹配，未重做历史全文语义阅读。562917字符串/833428标量与127/175/16 occurrences、100/100/16保存上下文是该次 dated scanner 的口径，关键词不证明语义穷尽。

此 prep 明确排除当时仍 mutable 的 Round29 与 future Round30。因此这份复核认可其 dated snapshot，不宣称已完成未来正式 Round30 全历史去重；正式化时 Root 仍需把已冻结 Round29 纳入新时点历史，并绑定正式 baseline，保留原 parent b348。

## 收据与执行记录

12条作者 source rows 的当前字节、hash、行数、选段与semanticLines均匹配；author receipt的10个自有 artifacts与独立读前固定的全部11文件（包括receipt）均未变；两个选择输入metadata的hash仍匹配；proposal的8个本地链接均存在。作者0/0/0分类与validation空runs一致。没有需要作者修改的metadata事项。

本 reviewer **0产品/函数/import/测试/fixture/Git/React/browser/VM/native/网络/模型执行，0pass/0expect**。Python filesystem/hash/JSON/regex仅为审计元数据读写，成功退出不等于产品测试。所有初始、结束与产物证据见 [reviewer receipt](reviewer-receipt.json)；既有测试声明不算运行。该 negative 只适用于声明的普通数据合同片段，不代表全仓或平台交互无缺陷。
