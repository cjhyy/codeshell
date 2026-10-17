# MCP 点号 project override：当前读回影响复核

**支持当前 P2 静态影响：保存后配置读回可被 schema 拒绝，不能只写成旧归档的静默 inherit。** 复核为0 formal /1同项candidate /0 newRelated，不另发ID，Root已采纳同项`MCP-R61-01/P2`静态确认，只计一次，未运行复现。基线 `659b6b2ce5888723a40ce046cbbf643382cb130b` 为Root上下文，Git0；旧158保持冻结，未读159报告/原日志。

普通链已亲读：UI261–279→preload1119–1123→main3840–3847→Desktop capabilities-service114–120→Core service151–165。`team.docs` 的正常名称准入沿已冻158源码结论；这次服务端只核 id 为string、state为枚举，没有点号保护。writer拼 `capabilityOverrides.mcp.team.docs`，manager84/149–154分段，572–585→872–891→834–844把嵌套值序列化写入并invalidate，**没有在此保存路径做settings shape校验**。此为成功普通写入条件下的源码推导，未实际写盘。

普通JSON parser只核合法object并递归去forbidden property names；merge1109–1139同样只滤forbidden/null并递归保留对象。因此生成的`mcp.team`对象不会变成允许的字符串。schema57–78、477要求`mcp: record(enum("inherit","on","off"))`，729–731直接parse；getForScope701–709在merge后直接validate，无catch，不能按旧overlay逻辑先变成inherit。

真实后续读：UI保存后load；Desktop makeService51–54/74–80先调用SettingsManager.get/load，普通load393→validateMerged502也会触达schema。Core list107–109直接getForScope也在overlay helper的catch之外。**反证保留**：effectiveProjectOverrides184–211确实catch并返回undefined，所以不称每个consumer都会抛错；但它不能保护这些前置读。

迁移反证限定：已亲读migrate-config91–147及manager405–437；正常已有当前`configVersion=2`的配置没有待跑step，原子树保留，不能自动修复该值。范围仅普通可读当前版本项目配置、成功写入且无更高层null显式删除该子树；不认证全部迁移、其他provider/Host、权限、锁或持久化安全。不报告实际错误文本、崩溃、所有项目启动失败或不可恢复损失。

[manifest](source-manifest.json)：9产品selected rows、599语义行，body显示1006、含导航逐文件union 1043；semantic-full0、指令hash-only2，测试声明/执行0。现有源重叠不称新增唯一覆盖。所有产品/helper/import/fixture/test/真实配置/网络/native/Git执行0；首元数据失败/截断均无，Root159的IndexError不归于本包。[分类与反证](classification.json)、[诊断](diagnostics.json)、[ending](ending-checks.json)、[receipt](artifact-receipt.json)。11个源/指令结束SHA全同；未重扫archive或全历史。
