# MCP rename supported-field retention — future Round39 prep

静态意见 **MCP-R39-01 / P3**（Root暂定编号、待独立反证）：普通用户添加的MCP server已经设置`connectTimeoutMs`、`connectRetries`或`inlineImages`后，在full editor只改名称并保存，会在新键下重建仅含表单字段的记录，再删除完整旧记录，因而丢失这些未编辑的受支持字段。影响限定为rename；同名保存的递归合并会保留它们。0单独candidate、0new-related，没有动态复现。

主要定位为 [McpSection.tsx:429](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/McpSection.tsx:429)（429–436）结合 [mcpSettingsPatch.ts:20](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settings/mcpSettingsPatch.ts:20)（20–34）。修复应在改名时转移原始受支持、非表单编辑字段，再应用可编辑字段patch；不能把UI source/editable等元数据盲目持久化。本任务未修改产品。

## 普通producer与可见消费者

这不是仅凭schema允许某字段就认定bug。[schema-export.ts:1](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/schema-export.ts:1)（1–11）明确把手工编辑user/project settings列为受支持用法，导出schema用于编辑器补全与验证。[schema.ts:393](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/schema.ts:393)（393–396）支持有界timeout/retries与inlineImages；[schema.test.ts:5](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/settings/schema.test.ts:5)（5–31）声明对有界启动字段的保留及越界拒绝测试意图，未执行。

普通场景是用户通过这一支持的配置入口，为已有用户添加stdio server设置合法值，例如`command:"tool"`、`connectTimeoutMs:90000`、`connectRetries:0`和`inlineImages:true`。这是人工源推演的合法数据示意，没有写入配置文件、运行schema或构造并执行fixture。

实际读入路径为 [settings-service.ts:35](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/main/settings-service.ts:35)（35–50、224–233）读取/递归保留对象字段；[settingsAuthority.ts:3](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/settingsAuthority.ts:3)（3–12）→preload975→Main6664–6667→McpSection245–271。MCP列表IPC在 [main/index.ts:5447](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/main/index.ts:5447)（5447–5485）使用base记录，展开cfg并把base server标为`source:"settings",editable:true`。mergePluginMcp350/360保留已有base key；[host-mcp-servers.ts:89](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/tool-system/host-mcp-servers.ts:89)（89–98）亦不覆盖已有名称。McpSection1756–1769展开raw，不先丢这些字段。

可达的真实full editor链为McpSection68–69的editable判断、877–887的Edit按钮、661的edit state、700–714的initial/full模式与saveEdit调用。Name输入框1436–1442在full模式可改；1207–1209排除原名后的重复名检查、1303–1311允许合法新唯一名称与非空command。无需插件override、HTTP鉴权或手工malformed DTO。

## 改名如何丢字段，以及同名合并反证

McpSection1375–1395从各个表单state新建next，保留enabled与工具策略，并按transport生成command/args/env或HTTP字段；不展开initial，也不生成上述三个受支持字段。mcpSettingsPatch1–16、20–34明确只列editor可author字段，43–60仅遍历该名单。previous只用于54–57的env/header删键，不转移其他字段。

saveEdit429–436把此patch写到`[next.name]`，并在改名时写`[originalName]:null`。普通user scope由settingsAuthority14–25→preload978–979→Main6707–6711进入writer。settings-service131–156读取原记录并merge，110–129序列化JSON；这里均只读源码，未执行IPC、validator、writer或真实目录访问。

[settings-service.ts:181](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/main/settings-service.ts:181)（181–214）从旧record展开：**同名**情况下197递归合并，所以未出现在白名单patch中的connectTimeoutMs/connectRetries/inlineImages仍保留。这是有力反证，不能报成所有编辑保存均丢字段。**改成不存在的新名**时，新key没有可合并的旧record，199仅插入stripNulls后的白名单patch；187–188同时删除旧key。新记录不再有这些原先合法、未编辑的设置。

这是名字变化导致配置字段转移不完整，不是“字段白名单本身错误”。名单仅涵盖UI可author字段有明确设计意图；同名合并正依靠原record保留UI未编辑字段。没有在所读代码中找到“只改名称应重置启动或结果选项”的reset合同。仅建议保留已支持且未编辑字段，不保证任意未知键、插件override或所有配置字段都须转移。

消费者边界亦真实存在：[types.ts:1165](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/types.ts:1165)（1165–1176）声明timeout/retries默认值及inlineImages的opt-in语义；mcp-manager1137–1146校验并读取前两者、缺失时用默认值；mcp-connection-config44–49保留这些配置值。这里止于文本/DTO默认读取边界，没有调用connect、任何模型或图像处理，也未验证进程启动、重试或连接结果。只声称设置字段丢失及源定义的缺省回退，不声称观察到超时、连接失败、模型行为或数据损坏。

## 测试意图与历史同因检查

mcpSettingsPatch.test.ts全文114行的6个声明覆盖删map key、transport切换、disabled/空值、override名单、容器不共享；McpSection.lifecycle.fixture1–35/245–270中rename254–266只断言单次原子patch、old:null与command保留；lifecycle.test.ts全文34行列13个scenario的test.each。schema.test所读首33行声明2个启动配置case；另一个connection-config测试声明只在字段导航行出现。总计10处测试声明语法、13个lifecycle列举case，均未执行；原fixture的React/DOM/进程调用只是被读文本。

完整history metadata gate重新枚举docs/bugs MD与递归JSON value scalar、含档案，纳入已冻结37、排mutable38/future39。3413文件=1352MD+2061JSON，887511 string leaves、1329022 scalar leaves，169 exact archive/_archive路径，0parse错误。inventory canonical SHA256 `1905d1ba4d14facbb18126b18b7defbd97a89a1e04a736482f17a61486795fad`。exact-fields12、mcp-rename9、field-retention4，无cap，25contexts全读。

后续McpSection/mcpSettingsPatch query全库存保留147 contexts、无cap、对initial inventory漂移0；不声称147全部语义读完。宽69-object metadata输出误纳大型旧audit日志字符串并被截断；原始capture与首诊断保留。随后按直接file/path字段缩为12个objects，已核其中5条May30旧headers显示分隔符记录与hash/selected来源行；这些旧记录并非本问题。另完整读focused108–146的39 contexts，其余保持有限导航。输出截断诊断见[metadata-diagnostics.json](/tmp/codeshell-audit-round39-mcp-rename-fields-frontier/metadata-diagnostics.json)，不拿截断输出冒充完成。

旧September11结果说明原子rename、disabled保留与显式删除标记，未覆盖这三个非表单字段；旧测试通过文字只作为历史声明，不作为当前运行证据。旧Round4 inline image压缩/归档问题属于result/context序列化，修复点不同。Round28 hash inventory与Round30同SHA selected1092–1112/21行不能证明此前全文语义已读，亦不能证明未读。已知Round38 MCP args往返问题是数组→文本初始化→分词的独立修复点；本次完整history明确排除了当时mutable38，未把38扫描冒称含冻37，也未重报其发现。原38目录保持冻结。

当前inventory相对原future38的3318新增95份冻结37文档，0删除、0共享文件byte变化；详见[history-delta.json](/tmp/codeshell-audit-round39-mcp-rename-fields-frontier/history-delta.json)。未修改旧时点库存。metadata匹配与所读有限上下文未发现精确同因；不声称全部历史被逐字语义阅读或从未有人审过。

## 范围与冻结边界

[source-manifest.json](/tmp/codeshell-audit-round39-mcp-rename-fields-frontier/source-manifest.json)列29个语义/导航产品测试pin：6full、12selected、11navigation-only，共1561观察行；183个其他product pin只hash。所有当前initial pin早于本次对应源码内容阅读，finish一致。whole-file哈希不表示whole-file语义覆盖；与38重复读取明确不是首次或全局新增独立覆盖。CODESHELL/AGENTS是此前全文阅读的指令SHA carry-forward，新增指令语义行0。连接config旁邻identity及所选段的auth/credentials/锁/probe文字不构成那些机制的审计结论。

原prep上下文仅Root提供的`bbad45be04dacfecb29cba04ed51caf167fe4e53`；formalBaseline=null、未执行Git绑定。所有写入仅本tmp目录。[validation.json](/tmp/codeshell-audit-round39-mcp-rename-fields-frontier/validation.json)明确0产品/helper/schema/parser/import/语言fixture/测试/React/browser执行，0用户设置目录访问、MCP/连接/server/process/网络/native/模型/auth/凭据/权限动作，0Git、0repo改动。两次metadata scan均已收取exit0；旧失败执行方向继续SKIP。独立复核与全局最终分类归Root；本报告只支持单项有限P3静态意见。
