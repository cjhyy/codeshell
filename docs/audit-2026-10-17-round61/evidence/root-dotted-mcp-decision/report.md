# Root159：点号MCP项目开关的静态正式判定

**1 formal /0 candidate /0 new related：MCP-R61-01 /P2。** 同一155/158线索只登记一次。当前基线659b6b2；没有运行产品函数、Zod、测试、fixture、真实设置、Host、native或网络。

正常名称`team.docs`经McpSection的非空/重复检查，以literal record key进入mcpServers；schema不拒点号，projectMcp据原名生成`mcp:team.docs`。CapabilitiesOverview261–271将原id发给preload1119–1123，main3840–3847只查id是string及三态枚举，再由Desktop114–120调用项目覆盖。Core service161–164却把完整token拼成点分配置路径；manager83–91/144–155拆点，572–584与872–890直接把嵌套对象写入项目settings并invalidate，没有shape validation。

应写的`mcp["team.docs"]="off"`变为`mcp.team.docs="off"`。manager1109–1139的merge保留对象，schema57–78的mcp record(enum)拒绝`team:{docs:"off"}`，getForScope701–709直接parse抛错。普通load393/validateMerged501–502和Desktop makeService51–54也读取验证后的settings；UI随后load会遇到错误。独立161补核普通JSON parser/sanitize、current configVersion=2迁移与普通load，支持此P2影响，未借旧silent-inherit文字代替当前验证行为。

反证边界保留：overlay effectiveProjectOverrides的catch只能保护它自身，不覆盖service.list107–109的直接getForScope，也不覆盖Desktop makeService先settings.get；全局MCP路径174–179写whole record，不能泛化成所有MCP开关。只断言普通当前版本配置、写入成功、没有更高层显式删除该子树；未认证所有迁移、所有读取方或配置target授权。

原archive1–7明确已完成并保留修复前问题，36–45只描述plugin/Skill点号名称。旧修复拒绝这些名字，不能覆盖当前仍合法的MCP producer。155原0/同helper排旧观点保持冻件，158后修正为同项candidate，160有限历史核对未建立相同当前MCP入口记录；这不声称全史根因穷尽。Root将当前入口单独登记一次，不改变原118记录。

[分类与完整条件](classification.json)、[逐源选段](source-manifest.json)、[实际正文01](source-read-01.txt)、[正文02](source-read-02.txt)、[正文03](source-read-03.txt)、[正文04](source-read-04.txt)、[元数据诊断](diagnostics.json)。所有产品都是selected，完整显示/旧重复/导航与hash不升级full。原首个范围越界元数据错误及后续路径显示错误如实保留，无产品首失败或重试。
