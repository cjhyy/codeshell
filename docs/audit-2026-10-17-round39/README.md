# 第39批：MCP改名的配置保留

本批将第38批未完成的字段边界补齐为 **1项P3静态正式问题、0候选、0新关联**：[MCP-R39-01](mcp-rename.md)。普通full editor改名会丢失超时、重试或inlineImages等受支持但未由表单编写的选项；同名保存不受此原因影响。

冻结父提交为`42683054b1eea00d76e3ed18817766be3047c110`。新分支先在origin/main创建，并在未被任何worktree占用时按祖先关系和CAS推进到本地main后单次切换，没有中间旧源码checkout。前置材料3413时点不变；正式历史3509包含冻结38的96份新增MD/JSON，无共享漂移。

整合前main刷新到`037c2afbb05f2fcb3b2f3f3588be2b4a980032a1`。9条incoming路径仅作库存，未与父报告source pins相交，不代表已审新修复；release TODO一份文件的字节变化另存[检查](evidence/history-post-refresh-checks.json)，不重写原历史时点。

只记录问题，未改产品。父报告29个观察范围含11条navigation-only，另183个发现pin仅hash；1561观察行不能当1561新产品语义行。Root为4文件123选读行，另沿用旧helper全文事实并仅核hash，不将重读和hash绑定当新增覆盖。原5.53MB metadata capture保持原字节，仅核hash，未冒称全文阅读。

**0产品、函数、语言fixture、测试、React/表单、真实设置、MCP连接、命令、native及产品业务网络执行，0pass/expect**。版本控制fetch属于另列的Git元数据操作，不是零网络流量声明。正常手改支持入口、可编辑名字、保存与merge分支均有源码合同，未声称实机运行结果。历史去重局限于实际查询和选读上下文。

[问题数据](findings.json)、[候选](candidates.json)、[验证](validation.json)、[源码](source-manifest.json)、[范围](coverage.json)、[聚合复核](evidence/review-aggregate.md)、[新增冻结材料补查](evidence/history-new-frozen-delta.json)、[证据索引](evidence-index.json)。整体审查继续，旧失败动态方向保持跳过，未push。
