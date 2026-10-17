# Round27 聚合独立静态复核

支持 **1 formal（AGGREGATOR-R27-01 / P3 static）/1 candidate（COMPOSE-R27-C1 / SKIP）/1 old-related（ROOT-R27-R1 → HL-01）**。已读README、RootQC、assembler/verifier源码、分类/validation、作者报告和四份独立review，并核当前清单、字节、原副本及链接；没有执行产品、测试、import、fixture、VM、React/browser、native、Git、网络或Root assembler/verifier。只新增本文件，没有修改冻结作者材料；本review不是产品测试通过或全仓完成声明。

formal的普通输入与值流成立：本review另选读worktree公开isolation/cleanup合同、launch cwd、keep/auto保留、changed-files normalize/完成事件、aggregator输出、Card与文件打开消费段。支持`isolation:worktree, cleanup:keep`及auto有改动保留，不依赖外部CLI自行迁移、失败清理或人工畸形DTO。完成事件的正确child cwd在display路径输出中丢掉；Card使用主聊天cwd，经openWith与bucket传入FilesPanel相对路径join，静态得到父工作区请求。原marker cwd仍存在、同cwd和root外absolute路径有反证，不能称内容删除。多root同relative path/key的后果同因果，只计一项。旧dock主session workspace解析错误、旧research外部CLI迁移造成launch snapshot陈旧，与此正确known child cwd在renderer才消失不同；Root与独立formal review均正确保留该边界。

candidate也准确：COMPOSE文字反例与Edit unique-old合同为源码推导，outer唯一包含不证明同位置；此前失败的Root focused fixture没有进入三个测试体、owned model或console JSON。既有16个compose tests和54expect实际运行，但整shard仍exit1、1fail/1error，0clean completed、0rerun，没有Completed。原raw为2272B/SHA `3419b38917c264fa865bcca06aa7160da25216f1b056c713ceb57a42f6a33a48`，与exit/validation/收据相同；fixture2622B/SHA9f38f940…保持首次。错误是Root相对导入多退一层，不是产品缺模块。新formal完全靠独立静态链，不借此failed shard升级；RootCore/Link与其它静态作者均0产品执行。HL-01仍是相同text.trim生产者/identity消费者，不算新bug；旧失败方向未恢复。

**2026-10-17 11:14:29 UTC** 最终刷新窗口独立核：

- [source manifest](../source-manifest.json) **62 unique source/meta pins**当前文件byte/SHA与保存的frozen/current/main三列一致；**93 source checks**逐项与7份作者/reviewer清单交叉匹配，range均合法。93=Root9+frontier11+compose7+snapshot10+aggregator29+Rootformalreview12+independentformalreview15；重复文件、指令、旧合同与hash-only metadata不能计成93个新全文产品文件。本review只独立核当前filesystem字节和已保存来源，未读取Git对象；冻结Git blob和真实main状态仍由Root自己的来源检查负责。
- **20 prep hash-only checks**与当前字节一致。[4份copy](compose-prep-copy-receipt.json) 逐一与原/tmp exact source字节相同；原parentReportedHead5e、时间和inventory/hash-only readScope保留。新的冻结9b核验不能回填原作者未做的Git或read-start行为。独立formal reviewer原8个before-read pins、其余7个after-read first hash/nullinitial，及aggregator作者原8与新增after-read标记均保留，没有把finish hash包装成当时阅读证明。
- [worker integrity](../worker-integrity.json) **59 artifact checks=55 author（9+8+13+10+15）+4 copies**全部byte/SHA匹配。runtime raw、fixture、作者receipt未因索引刷新改写。原raw是实际合并stdout/stderr；locator/receipt更名并发错误另有人工diagnostic摘录说明，不假冒产品raw或产品失败恢复。

2596份prior corpus再逐文件重核当前byte/SHA全部相同；先前本作者还独立重算1250MD/1346JSON、468104string/676635scalar与Rootfrontier occurrence命中。精确archive/_archive目录component169与path substring archive174定义不同，但同一完整库存包含全部，非漏扫。各作者匹配单位、总数、context cap和excerpt限制按各自清单保留，不相加为问题数、不声称历史语义穷尽。

本时点 [index](../evidence-index.json) **88项集合与全部byte/SHA正确**（含index本身实际89文件），现有 **126个本地Markdown链接及行界**全部通过。只有README到本待创建review的链接在核验时预期暂缺；本文件随后创建会解开它，也会新增索引项。Root需要统一刷新最终index并跑其metadata verifier，不能把88当成最终stage文件数，本review未故意运行过期verifier。

[integration plan](integration-plan.json) 保存的initial、primaryBefore与before快照完全相同，记录main/frozen均9b、0source delta，与RootQC和source清单一致。本review不调用实际primary Git状态，不能替代临FF重新取样、incoming路径与dirty disjoint、cached/blob/raw逐字节、commit/primary检查。后续如有并行main或untracked变化，应保留真实新时点；最终stage/commit/FF与dirty保全由Root外部收据完成。

未发现本轮分类、计数、来源、影响边界、材料归属或现有链接的未解决阻断。Review ready；全仓目标继续active，产品未修复。
