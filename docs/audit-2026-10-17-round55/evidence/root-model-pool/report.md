# Root126：ModelPool与正常连接参数合同

有限结论 **0新增正式问题、0候选、0新增关联**。普通注册/模型参数投影、真实producer与Engine消费链未建立新反例，不认证所有模型能力、SDK、账户、cache权限或实际请求行为。

[初始pin](initial-pins.json)在正文/行导航前，model-pool.ts325行13195B SHAa49da…。[历史batch](history-batch.json)同5433历史范围纳54排55+，path/SHA命中150保存前100、0parse错误；机器命中不等于全语义阅读。实际先读前35个有限命中（过滤大coverage项），核[两个原canonical对象](canonical-metadata.json)：R4只有SHA，R10 inspected/read scope不标完整文件；R10 catalog.md15的缓存推断与来源旧因明确排除。原范围可能重叠，不称首次或从未阅读。

[范围清单](source-manifest.json)列5个完整产品文件（model-pool325、connection bridge80、provider catalog75、resolver74、reasoning schema46）及runtime/Engine必要选段；另1完整现有测试声明43行及2测试选段111行。产品语义719行、测试声明154行，共873；正文实际显示947行，差集只相邻展示。其它rg-n测试标题/import/call locator只导航，不增加语义行；Engine5082行未全文阅读，冷会话restore相邻显示不纳本次语义。所有support/test在行导航前[pin](consumer-initial-pins.json)、[test pin](test-initial-pins.json)，[摘录](source-excerpts.json)在实际显示后保存，不倒填首次pin。

正常合同与反证：ModelPool保留alias/modelKey、显式maxOutputTokens/context和extraBody，未指定maxOutputTokens不捏造8192。真实modelEntriesFromConnections按catalog protocol映射client family，复制preset限制，reasoning另走discriminated object而不在extraBody重复发；false转{mode:off}仍truthy，toLLMConfig条件不丢off。provider catalog没有extraBody字段，不能凭不存在的字段声称丢失；普通headers合并顺序在源内明确，外部authCommand未执行。

Engine启动/热切换以toLLMConfig替换模型身份而保留独立clientDefaults；runtime重建池先clear再登记并选defaults/first，未知binding消费处明确报错。具体consumer范围与边界保留，不把return reference/任意重复alias等无真实producer猜想报bug。现有声明支持缺params没有reasoning、on/off对象、cap及extraBody传递；没有借声明推定通过。缺key的所选连接明确被resolver拒绝；本轮未建立正常mixed-state fallback新反例，不恢复已失败SDK方向。[分类](classification.json)逐条保留。

[验证](validation.json)产品/helper/import/fixture/test/模型/凭证/网络/native运行均0，无产品失败重试。[结束检查](ending-checks.json)10个源/测试pins及原5433历史成员字节全同。首扫描stdout/stderr/exit保留，exit0。Root125/126是同一作者两个有限任务，不说成独立双人复核。旧统一覆盖未重算，6full标签包含测试声明，不能加到304作为新全仓完整数。
