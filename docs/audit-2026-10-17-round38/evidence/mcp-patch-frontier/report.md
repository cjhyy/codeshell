# MCP settings DTO static review — future Round38 prep

单项静态意见 **MCP-R38-01 / P3**：普通 MCP stdio 表单可先保存一个含空格的非空 argument；重开同一条配置时，`args.join(" ")` 不保留 argument 边界，无修改再次保存会把该 argument 拆成多个。Root 统一判级/编号，本目录仅保存作者源证据意见。`mcpSettingsPatch` helper 本身在本次所读普通字段合同内未产生独立问题；0 单独 candidate、0 new-related。没有动态复现。

定位在 [McpSection.tsx:1122](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/McpSection.tsx:1122)。影响是无修改编辑保存改变结构化 args 数组；未声称已点击 UI、写入真实设置、连接 MCP、启动进程或观察到连接失败。建议以与解析器兼容的无损文本格式初始化 args，或直接使用结构化参数编辑器。

## 普通入口和最小源推演

条件限定为真实表单可编辑的用户添加 stdio server、合法名称、非空 command、普通可写 user scope。无需外来 malformed DTO，也不依赖模型、服务器或实际连接。以下是人工沿源码推演的值，未执行语言 fixture、splitArgs 或 React。

1. 真实 Args Input 在 [McpSection.tsx:1475](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/McpSection.tsx:1475)（1475–1481）把文本存入 args state，Save 在1746调用 submit。输入文本 `"project notes"`。submit1301–1313完成普通名称/stdio检查，1383–1384用 splitArgs生成数组。splitArgs1870–1893明确支持 quoted segments；1877–1880保留引号内空格，1882–1886只在引号外空白处分词。因此首个 DTO 为 `["project notes"]`，一个非空参数。
2. submit1401把 next交给 onSave；700–714的普通 full模式进入 saveEdit418–436。[mcpSettingsPatch.ts:43](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/mcpSettingsPatch.ts:43)（43–60）对 args 在59复制数组，不做文本分词。表单438–449亦把同一个 next存入 servers state并关闭编辑器，所以即使不依赖完整 reload链，也有普通的首存→再次打开 producer。
3. 用户 scope 的转发为 [settingsAuthority.ts:14](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settingsAuthority.ts:14)（14–25）→ [preload/index.ts:978](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/preload/index.ts:978)（978–979）→ [main/index.ts:6707](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/main/index.ts:6707)（6707–6711）→ [settings-service.ts:131](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/main/settings-service.ts:131)（131–160）。writer110–129在116序列化 JSON；deepMerge181–203替换数组，stripNulls205–214保留数组字符串。schema在 [schema.ts:377](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/schema.ts:377)接受 string数组。这里仅静态确认 DTO 的数组保存路径，没有访问用户配置目录、调用 validator/writeSettings 或审计 authority全生命周期。
4. 行上的 Edit 在McpSection649–668（661）设置 edit，700–706从 servers查找该条并传 initial。1122用 `(initial?.args ?? []).join(" ")` 初始化文本；`["project notes"]`显示为 `project notes`，引号已丢失。再次无修改 Save仍走1384及1874–1891，空格现在位于引号外，生成 `["project", "notes"]`。同一 patch路径可保存此变化。这是同一实际表单自身可生产的往返不守恒。

可选 reload的已读段也支持数组保留：settingsAuthority3–12→preload975→Main6664–6667→settings-service35–50，sanitizeStoredSettings224–233递归保留字符串数组；McpSection245–270读取设置/merged summary，1756–1769的 mcpServersFromSettings展开 raw对象，1774–1793保留记录。preload1379–1383→Main5440–5493，Main5481展开 cfg；[loadPluginMcp.ts:344](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/plugins/installer/loadPluginMcp.ts:344)（344–370）从 base展开、360不覆盖已存在 base key，333–342记载该合同。未展开 withHostMcpServers的最终委托实现，不据此断言全部 merge/连接生命周期正确；首存后的 renderer state已提供本问题所需 producer。

[static-value-flow.json](/tmp/codeshell-audit-round38-mcp-patch-frontier/static-value-flow.json)保留逐阶段人工推演，runtimeObservations为空。

## 有限 negative 与未完成边界

[mcpSettingsPatch.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/mcpSettingsPatch.ts)全文62行：字段白名单排除外层 map名称；缺失字段用 null tombstone；env/headers/envHeaders的删键用null；数组复制、false、空数组及空字符串值在所读 writer/schema合同下可保留。override字段较窄，与插件设置 schema的字段范围相符。现有 [mcpSettingsPatch.test.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/mcpSettingsPatch.test.ts)全文114行，仅阅读6个测试声明及其意图；未执行其 FS fixture、writer、import或任何测试。本 negative仅覆盖所列普通字段合同。

rename extras保持**未完成边界**，不计candidate：schema393–396包含connectTimeoutMs/connectRetries/inlineImages等 editor未编写字段；尚未完成独立普通producer/字段保留合同。最初猜测 loader丢字段已被1756–1769的 raw spread反证，透明保留该纠正，不升级、也不作完整 rename正确性结论。

## 去重与时间边界

完整 metadata库存含 docs/bugs下 MD与递归 JSON value scalar、归档；3318文件=1342 MD+1976 JSON，807880 string leaves、1193828 scalar leaves，169 exact archive/_archive路径，0 parse错误。排除当时 mutable37/future38，纳入已冻结36；inventory canonical SHA256为`c5e2c0bec2f174e8d132a1de1a7b644d72ca573aa1f4f41f3c489b0738f58b8f`。初始query196/286/0，cap100，保留100/100/0；只语义阅读初始前25 target contexts，不冒称全部 capped broad contexts已读。后续无cap focused exact-helper13、args-roundtrip84、rename-extra-fields0，全部97 contexts与10个McpSection历史object rows已读，初始库存到focused无漂移。

- May30 MCP旧记录涉及 header显示 `KEY=VALUE`/`Key: Value`分隔符，当前parser兼容、headers初始化明确传 `": "`；并非 args数组丢边界。
- CLI-R4-01 / TARGET-R26-R1在TUI registry先split(/\s+/)再join，压缩已有引号 command文本内部多个空格。现问题是独立MCP表单从结构化数组初始化为无引号文本；旧模块修复不会修复这里。旧首个fixture import失败仍SKIP，未重跑；[Round26旧报告](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/audit-2026-10-17-round26/review-target-report.md)全文28行已读以核对边界，其 dedicated initial pin晚于先前focused excerpts，因此初始读前pin诚实记null。
- PLUGIN-R8-01是plugin command tokenizer丢显式空quoted token；本意见仅非空、含空格参数，producer与修复点不同。其他SSH/shell安全引号、Git quotePath等泛匹配未作为同因或实验入口。
- 同SHA McpSection旧Round28行是hash库存；Round30实际selected1092–1112仅21行，未覆盖1122参数初始化。没有first-ever/unread断言，也未借旧测试pass证明当前行为。

相对future37 dated库存新增102份冻结文档（35的47+36的55），无删除；共享release-real-operations文档1项dated byte drift已独立保留。旧snapshot未改写。Root随后提供37整合context `bbad45be04dacfecb29cba04ed51caf167fe4e53`，只记为最终核对时的Root上下文，不改原prep短context `ee5c`、history时点或formalBaseline=null。本作者未执行Git验证。实际fresh正式history差集由Root另处理。

## 读范围、pin与验证

[source-manifest.json](/tmp/codeshell-audit-round38-mcp-patch-frontier/source-manifest.json)逐行记录9个产品/测试pin、3full/6selected、1207行（含另列rg单行导航），另读历史报告28行。CODESHELL/AGENTS只核此前已读指令的SHA，新增指令语义读0行。所有9个当前prep源initial pin先于本次内容阅读，initial/finish稳定；whole-file SHA不代表whole-file语义阅读。McpSection旁邻auth/probe文本虽显示，不构成权限/凭据行为审查。

Root提示短暂checkout后，另做 [final-source-check.json](/tmp/codeshell-audit-round38-mcp-patch-frontier/final-source-check.json)纯字节核对：9产品/测试、1历史报告、2指令共12项仍与原pin一致，原initial及13:20:17 finish记录未改；无新增产品语义阅读。

[validation.json](/tmp/codeshell-audit-round38-mcp-patch-frontier/validation.json)明确0产品/helper/schema/parser/语言fixture/React/browser/DOM执行，0测试/import、0真实设置目录/MCP连接/CLI/native/网络/模型/auth/权限动作，0Git、0repo写入。metadata两次history会话均已收取exit0；两处猜测目录不存在的rg exit2及普通symbol no-match作为导航诊断保留，不是产品失败，也未据此尝试旧失败执行路径。所有写入仅限本目录。该P3意见完全来自静态普通数据合同；其余全repo、所有设置字段与真实运行状态均不作无bug断言。
