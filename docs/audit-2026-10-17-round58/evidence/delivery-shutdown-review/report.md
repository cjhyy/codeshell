# Delivery shutdown 与 lease：独立静态复核

支持作者单一CHAT-R138-C1的 **P2静态因果**，Root拟CHAT-R58-01仍为同一项。此包 **0 formal / 1 同项候选复核 / 0 new related**；最终新颖性与正式晋升由Root结合144决定。产品/helper/import/test、真实进程/FS/账户/网络/native和Git执行均0，未改产品或旧包。

正常链已闭：同配置CLI取得gateway.lock，以inbox.json构造队列；合法纯文本A先持久化，handler resolve后由detached process(A)异步消费。实际Mimi messageId缓存路径仍await petChat/start/result，未带CLI shutdownsignal；request有自己的timeout，watchEvents则能在idle poll收到abort后返回。Telegram正常handler也只等enqueue后推进offset，后续poll可在abort时返回。因此gateway/watch两任务结束不等于消费完：gateway finally只调用void stop()，stop仅置stopped/清timer；CLI finally随即release，所核CLI末尾仅exitCode而无process.exit。此为静态可行路径，不凭一个pendingPromise就宣称实测旧进程存活。

lease用wx创建后关闭fd，release按token删除文件；活pid检查只在已有文件EEXIST分支，释放后没有额外owner持有期。正常第二进程P2因而可取得同路径lease并load同inbox，接收且持久化B。旧P1在A成功或失败后仍执行withMutation/persist，没有stopped/lease检查；mutation只串行该实例，persist把其pending/completed整快照序列化并rename，不reload/CAS。目录/regular-target检查不比较新一代内容。 [精确范围](source-manifest.json)、[摘录](source-excerpts.txt)与[时间线/条件](classification.json)保留真实producer→consumer。

影响须限定：旧snapshot可从磁盘撤回已被P2接受并持久化的B，但B可能仍在P2内存，之后persist可以修复；**若P2在修复前退出，下一次本地inbox恢复才缺B**。不说每次新消息必丢，也不把重复A当问题。外部平台是否重投、最终端到端永久损失没有验证；offset/handler代码是静态接受合同，不是实际平台ACK实验。active通知handler可能延迟lease释放，属于排除的另一分支。没有依赖坏DTO、附件降级或同一Queue对象stop/start。

亲读[旧原因](prior-cause-inputs.json)：SWC02是adapter命名空间去重，SWC03是spool故障memory-only仍确认，C8是单目标retry被越过，CHAT-R11-01是通知progress首次load拒绝缓存，均不是本次handoff后的旧快照写。 [旧版本对象](prior-source-objects.json)保留bound既有范围与queue/CLI pins，不能从hash偷认全文或称首次；这些对象晚于定向源读，不回填前置门槛。共享 [history投影](history-projection.json)为5850 MD/JSON、含冻57排58+、4251467 value scalar机器导航，delivery79/bound68全部保存，不能当本人全史语义穷尽；其他shutdown旧因由144/Root分账。

9产品selected **900**行，display union **1434**；测试正文/声明/执行均0，指令同SHA沿用2，semantic full0。 [diagnostics](diagnostics.json)记录原始首次inventory stdout/stderr/exit0、无metadata失败/输出截断，并透明保留最后cache-miss补读时序。[ending](ending.json)11源/指令pin与8限定元数据输入SHA均同，未独立重核全5850库存。见 [自排除收据](artifact-receipt.json)。
