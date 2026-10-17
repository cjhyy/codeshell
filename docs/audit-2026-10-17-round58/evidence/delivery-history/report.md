# prep144：Delivery 停机候选的旧原因独立元数据对照

**在亲读的原 canonical 和报告窗口中，未建立已有记录明确描述完整“queue.stop 未排空→CLI lease.release→旧执行 consumer 继续 persist 覆盖新进程 snapshot”同因。** C8、SWC 与 CHAT-R11 的具体原因不足以据此判重。这不是全史无记录保证，也不确认138/143源码假设成立、新颖或应晋升。

本角色只读历史元数据，不读产品正文或138/143 mutable包；产品 source `files=[]`，Git/产品/helper/import/fixture/test/native/network运行均0。提出假设来自Root；与138作者只交换既有 canonical 路径和旧范围，没有借此作为独立源验证。

## 原件逐项对照

| 原条目 | 原因及范围 | 与本候选的区别 |
|---|---|---|
| C8，canonical N22 / originalId C8 | remaining `findings.json#/issues/21`、`coding-tui-chat.md:142–150`：serial SDK 的 earlier retry 被 later message 越过 | backoff 期间调度顺序；没有 stop/drain、lease或旧/新进程 writer 链 |
| SWC-01 | `server-web-chat.md:7–15`：持久adapter列表ordinal重排后错账号 | 重启恢复是共同情景，路由身份缺失是不同根因 |
| SWC-02 | audit2026-10-16 `findings.json#/issues/20`、报告17–25：去重键缺adapterId | 正常第二账号被当重复，不是并发snapshot写入 |
| SWC-03 | 同JSON `/issues/21`、报告27–35：小附件spool I/O降级成memory-only但仍queued/ACK | materialization错误与接收确认策略；不是停机后旧consumer终态覆盖 |
| CHAT-R11-01 | round11两个原JSON均 `/findings/0`、`chat.md:5–15`：首次load rejected Promise被缓存，后续同handler重试不再load | 通知进度初始化恢复，与DeliveryQueue停机lease生命周期不同 |
| archive cleanup/slow-load notes | `bug-followups-2026-08-13.md:83–100`：单全局persist retry闭包漏其它spool清理；attachment.load持锁 | 未描述完整stop→release→旧writer覆盖链 |
| 旧未确认取消容量风险 | `coding-tui-chat.md:228–229`：无界attachment.load取消可能占preparing；spool内存fallback恢复未独立确证 | 不应自动扩写成已登记停机并发写入缺陷 |

同报告 `:213` 的source-directed列表与 audit报告`:47–48`既读/已知retry声明，不等于已登记所有停机故障，也不证明这些模块无bug。原动态PASS、fixture叙述只作为当时记录的边界，本读者没有打开或执行相应产品/测试。对照原值见[canonical选段](canonical-excerpts.json)和[原因矩阵](cause-comparison.json)。

## 有限补漏检索

Root共享[路径历史投影](shared-history-projection.json)为5850 MD/JSON、4251467个递归JSON value scalar、含archive、排JSON keys、纳冻57排58+。delivery79、bound68都低于cap100且全保存；这些是机器导航，不是亲读79/68全部上下文。

另按授权只执行一次[shutdown+lease复合元数据查询](shutdown-lease-history.py)，以共享原5850 inventory为集合。先按文件值文本同时出现queue、lease、shutdown/inflight类词作粗门槛，再取lease/queue.stop的JSON value或MD窗口；JSON只递归value不查keys。首[stdout](history-first.stdout)、[stderr](history-first.stderr)、[exit](history-first-exit.json)已在查看结果前保存，exit0。结果[快照](shutdown-lease-history.json)：126上下文/24文档，cap300，126全保留；0 parse/其它错误、0dated字节漂移、0单窗口/value同时具有三个词组。命中主要是其它lease设计文件在inventory/derived claims中的路径，以及旧coverage排除词组；没有把这些派生locator当作第二份语义证据。所读少量原locator与canonical未提供完整同因。

该检索依赖有限词组与窗口，不涵盖任意中文“锁”或同义转述，也不保证跨字段、跨文档或未显式写出lease的等价原因均能命中。0三词同窗不是语义去重证明；报告结论保持“exact prior未建立”，最终根因/合同/普通触发由实际源码读者和Root判断。

## 清单与边界

[metadata manifest](metadata-manifest.json)列9个原件pin：8份实际原窗口/对象，1份旧交叉review仅导航；产品 `files=[]`。第一次宽rg输出4092tokens超过2700预算，原warning记在[诊断](diagnostics.json)，中段未见内容不算读过；后续原CHAT窗口与对象均完整显示。未恢复其旧失败Promise/其它动态方向。

[结束核对](ending-checks.json)9个原件及共享batch均同字节。一次compound扫描在自身读时也核原5850 inventory的字节均无漂移，但不冒称结束时再次全量核对或认证未来Git。见[初始pin](metadata-before-pins.json)、[round11 pin](round11-before-pins.json)、[canonical JSON pin](chat-canonical-pins.json)、[验证范围](validation.json)、[冻结检查](freeze-checks.json)、[自排除receipt](reviewer-receipt.json)。
