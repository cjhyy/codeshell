# 正式61：完整问题列表、覆盖迁移与MCP项目覆盖

本轮 **1新增正式问题（MCP-R61-01/P2）、0残留本轮候选、0新关联计数**。累计 **119条历史正式记录：46P2、73P3**，另有42条历史候选；这些不是当前未修复/未解决计数。[全部119条](ALL-ISSUES.md)、[历史候选42条](HISTORICAL-CANDIDATES.md)、[机器目录](recorded-findings-catalog.json)、[覆盖与剩余范围](COVERAGE.md)。

新增问题：正常接受的`team.docs` MCP名称，在项目能力on/off路径被拼成点分配置键，落盘成嵌套对象；读回mcp record(enum)时拒绝该值。影响可扩至当前项目的validated settings读取失败。仅静态确认，未运行复现；成功写入、普通当前configVersion=2及无高层显式删除标记等条件在[正式证据](findings.json)、[Root159](evidence/root-dotted-mcp-decision/report.md)、[独立161读回复核](evidence/mcp-dot-readback-review/report.md)保留。

155曾据旧plugin/Skill同helper原因排除，158/160有限核对发现旧completed修复只覆盖该旧名称合同，不能自动保护当前仍合法的MCP入口。原意见全部保持冻件；Root只晋升同一线索一次，没有给158/161再加ID。[155](evidence/capability-control/report.md)、[158](evidence/dotted-capability-review/report.md)、[160历史归属](evidence/mcp-dot-history/report.md)。

并行有限审查还包括[156外部会话上下文表](evidence/session-context-store/report.md)和[Root157作用域/激活生命周期](evidence/root-composition-lifetime/report.md)，未建立新普通反例。上下文表为内存live ref映射，不把它当磁盘持久化承诺；生命周期只审普通所有权链，不认证任意factory/native关闭。旧覆盖、选段、完整显示、hash/导航与测试声明分开保留在[源manifest](source-manifest.json)，不能相加为新增唯一覆盖。

[154保守迁移](evidence/coverage-migration/report.md)更新原4643路径为355full/354selected/3934unknown；4288不能标full，不是全仓精确剩余量。只适配规范46–60，不把61选段自动并入；Root独立重绑4643当前源码与Git字节。旧失败方法/首输出/metadata修正留存。[162用户清单核对](evidence/user-status/report.md)独立核118旧记录、42历史候选和同过滤4644路径，未重新判断旧问题现状。

共享历史导航6244份MD/JSON、4350476递归JSON value scalars、含archive/排61+；overlay93/service177/project132/session25/lifetime78/activation65，cap100，service/project各只保存前100。机器访问不是读完所有历史；160另做有限新鲜去重导航/28窗口阅读，不声称新颖性穷尽。原输入结束无漂移，不补改首query。

本轮产品/helper/import/fixture/test/schema/真实配置/模型/native/业务网络执行均0；无产品修复。测试声明不当通过数，失败动态方向继续跳过。Root159元数据范围越界和路径显示错误、155/156各首导航/显示诊断如实保留；后续仅修metadata，不假造原始stdout/stderr。[执行口径](validation.json)、[Root元数据诊断](evidence/root-metadata-diagnostics.json)。

读取基线`659b6b2ce5888723a40ce046cbbf643382cb130b`，冻结后main`659b6b2ce5888723a40ce046cbbf643382cb130b`；337份原件逐字节复制、667条收据检查、27冻结锚点。226个混合源/指令/历史metadata pins不是同数新增产品全文。[复制回执](evidence/prep-copy-receipt.json)、[冻结](evidence/freeze-checks.json)、[全部字节索引](evidence-index.json)。仅提交本轮文档，保留主目录已有改动、不push，总审查目标active。
