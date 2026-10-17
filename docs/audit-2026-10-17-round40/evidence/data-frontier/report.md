# Project option helper — future Round40 prep

本次有限静态结果为 **0新增formal /0candidate /0new-related**。唯一active leaf是 [projectOptions.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/automation/projectOptions.ts)，全文101行；结合实际AutomationDetail调用、现有测试意图及必要的no-project分类/中英文标签段，没有建立新的普通选项列表或显示合同问题。不是整个自动化、项目注册或全部UI无bug的结论。

最初只pin了stripMarkdown.ts；完整history先发现精确已知R2-05（移除代码围栏后再对正文应用强调正则），因此在读取该leaf产品内容前排除，0新增语义读、0重报、0执行。其当前SHA与旧绑定行一致，但旧manifest行只有path/bytes/SHA，无full/selected语义字段；不把这个行本身当全文阅读证明。旧报告和发现索引足以确认同因排除。之后只审一个active leaf，没有以此重开Markdown或旧失败方向。

## 所读普通合同

projectOptions1–14明确说明真实自动化详情的项目下拉：包含无项目选项、跟踪项目，以及当前cwd不在列表时的合成选项。55–84中无项目sentinel先加入；空path跳过、重复path按精确字符串去重；输入顺序保留；44–46以trim后displayName优先、否则用name。当前cwd不存在且不被既有no-project predicate分类时，加入其原路径，若对应已挂载root则显示项目名与root名组合。86–101把空/缺失或no-project cwd映射到sentinel，再把选择sentinel还原为清空cwd。这些是明确的字符串/DTO合同，不是跨平台路径归一化或真实注册准入保证。

实际消费者 [AutomationView.tsx:1092](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/automation/AutomationView.tsx:1092)（1092–1151）中，独立任务Select的value来自selectedProjectValue、items来自buildProjectOptions；onValueChange先用cwdFromSelection转换。resumeSessionId分支是继承项目文本，1096–1099优先boundConversation标签，否则使用同一options/value匹配。237–258、571–594仅阅读props/job/patch类型与局部上下文，没有调用onSave或展开后台执行链。

必要依赖 [pathMatch.ts:38](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/automation/pathMatch.ts:38)（38–66）是现有no-project分类predicate；不仅包含内部no-repo目录，也按其现有注释分类临时scratch前缀。本审查只确认leaf使用这一既有分类，不把它改写成“只有空串/内部目录才算无项目”的更强合同。真实项目注册接受哪些特殊路径、跨平台分隔符、项目/root后台解析及authority均未审计，也未据手造路径值提出问题。

中英文资源 [automation.ts:143](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/i18n/ns/automation.ts:143)（140–150、400–409）均提供auto.projectOptions.noProject。没有调用翻译器、读取真实UI语言状态或启动React。

[projectOptions.test.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/desktop/src/renderer/automation/projectOptions.test.ts)全文107行仅静态读13个it声明：选项顺序、displayName、当前缺失补项、已有路径不补项、空值、精确路径去重、空path跳过、no-repo分类、原primary mounted root标签、selected value和sentinel回空cwd。0测试/import/fixture执行，现有case意图不等同当前运行通过。

## 完整metadata gate和历史覆盖状态

重新枚举docs/bugs的MD及递归JSON value scalar，含归档、纳已冻38，排mutable39/future40：3509文件=1361MD+2148JSON，975542 string leaves、1464542 scalar leaves，169 exact archive/_archive路径，0parse错误。canonical inventory SHA256为`579548d35cf40be3c2be8141a5cb418ef2c65f4880413529837d07b45955dec8`。原Root上下文仅短值`42683054`；formalBaseline=null，未用Git验证完整commit。

初始stripMarkdown精确17contexts全读并据旧R2-05排除；宽泛ordinary-contract54/old-failed0无cap保留，但宽泛输出被截断，不声称54全语义阅读。新的active leaf查询对同一完整3509库存再查projectOptions/project.option/项目选项，24contexts及1个直接source object全部在有界输出读完，无cap，未发现该查询时库存byte漂移。

唯一直接source object是dated Round28 package inventory：当前projectOptions101行/3885B、SHA`bc14777959c7ae4f4e9c21a06cfcff08dccc9ba15436858b66147f218e1d13e0`的hash记录。另有命名整合文档对该模块的语义说明，表明此前有人关注过；旧测试receipt只提供历史运行元数据。没有找到明确full语义source row，不等于此前未读。没有借旧pass证明本次行为，没有首次/全局新增覆盖断言。详见[replacement-history.json](/tmp/codeshell-audit-round40-data-frontier/replacement-history.json)及[history-decisions.json](/tmp/codeshell-audit-round40-data-frontier/history-decisions.json)。

相对future39 dated库存新增96份冻结38文档，0删除、0共享文件byte变化；[history-delta.json](/tmp/codeshell-audit-round40-data-frontier/history-delta.json)独立保存，未覆盖旧库存。metadata候选ranking输出及无关旧leaf宽contexts的截断分别保留首诊断；不是产品失败，不用于补造finding或重新运行旧失败fixture。

## Pin、验证与限制

[source-manifest.json](/tmp/codeshell-audit-round40-data-frontier/source-manifest.json)列5个语义source/test pin，2full/3selected，385实际观察行（含另列2条导航），另有stripMarkdown仅hash排除pin。各源initial均先于本次对应内容阅读，finish一致。CODESHELL/AGENTS沿用此前全文阅读指令，本次仅结束时核对既有SHA，新增指令语义行0，当前prep独立读前pin诚实记null。whole-file SHA不代表whole-file语义覆盖，消费者其余内容未审。

[validation.json](/tmp/codeshell-audit-round40-data-frontier/validation.json)记录两次metadata scan会话均exit0；0产品/helper/语言fixture/import/测试、0React/browser/DOM、0真实项目/自动化动作、0native/CLI/网络/模型/权限/identity/凭据/auth实验，0Git、0repo改动。所有写入仅本tmp，Round39目录保持冻结。只对所读普通列表、标签、select值映射给出有限negative；后台路由/执行、真实路径producer、交互及所有设置领域不在此结论内。
