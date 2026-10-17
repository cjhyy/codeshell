# Round33 npm selector / installer metadata 前置

**0新增formal / 0candidate / 0new-related**。原parent4be4016b8661c6a10c60f4eb0f218552b4b7c5d0与prepOnly保持，不是后来正式baseline。NPM selector/元数据链未建立新缺陷；邻接CLI local missing-await是May30 raw[151]同文件同根因复见，不分配新ID，不宣称旧记录已经confirmed，也不继承其severity。

NPM普通合同：parseSource全文193中npm优先分类，scoped/unscoped按selector分隔符解析，省略latest；semver exact规范化，tag须符合明确grammar且不是range。installFromNpm selected195–249检查package name、精确版本canonical/equality并保留requestedSelector；309–346明确PhaseA固定resolved exact，传给local installer的source为npm:package@resolvedVersion、version为同值。install.ts48–55保存这些元数据。tag不被保留作自动跟踪不是缺陷：update140–147明确拒绝npm auto-update，checkUpdate35–40按其git-only合同对非remote返回false+reason。没有假设registry/HTTP真实结果，没有执行semver、解析器或任何产品函数。

真实CLI入口main145–165在156–157注册createPluginCommand；plugin.ts17–40公开接受npm source并await npm installer，remote分支45也await。Desktop service selected215–255/280–323只用于确认updateLocal与check wrapper的消费接线，不审权限/custody或真实catalog。NPM fetch、download、tar、projector、Skill与registry操作都止于源码调用边界，未运行或据此推断安全性。

旧CLI复见的当前静态证据：plugin.ts42–46 local分支直接取installPluginFromPath(...)而未await，callee install.ts26确为async Promise<string>，internal410–435直接re-export，runGuarded90–101只await其async callback；callback在日志后隐式结束而未返回/等待local installer。因此dir的数据流是Promise而非resolved path，installer rejection也未被接入该guard所await的callback链。NPM35–40/remote45正确等待作反证。这里只记录源码推导，未观察实际日志、进程退出/unhandled策略、安装状态或文件损坏。

[原archive记录](legacy-cli-await-record.json)提取docs/archive/review-2026-05-30/findings.json的$[151]：同一local/remote ternary、同一missing-await与Promise日志描述，旧行27–29对应当前42–46。原raw描述含“if async”，当前callee/guard证据仅补强该旧根因，错误捕获与日志传播不另拆新问题。该raw记录不是已核confirmed证明；R15/R24查重JSON对它的转引也不算新finding。

[来源清单](source-manifest.json)13个语义source pins，8full/5selected，共1300实际声明读取行；另3个hash-only pins/836行单列，不算语义覆盖。parseSource/type、local/remote installer、update/check与CLI只是静态文本；installFromNpm只选138/346，npm test42/194，Desktop service85/323，main21行、internal26行，不夸成完整安装链/权限/HTTP/压缩包审查。[initial pins](initial-pins.json)保留此前manifest中的原读前SHA和各组capture时间，文件本身为finalization前合并记录，非伪称所有追加pins都在首组时间已存在。全部16文件的initial/finish SHA一致；旧archive只有JSON value选读，dedicated pin在excerpt后，未补称首次语义读前pin。

[首份全history](history.json)按原时点排除mutable32/future33：2988文件=1304MD/1684JSON，645399strings/957193scalars，169exact archive/_archive，0parse；npm20/contract44/cli-await149/old-failed76，cap100保存20/44/100/76。后续补全149上下文前的稳定字节检查遇到1次纯metadata AssertionError：[首次诊断](history-recheck.first.json)精确保留可见文本，inner Python数值状态未单独留存故null，outer0来自随后rg，未伪造exit1。

[dated drift](history-drift.json)仅定位release-real-operations-2026-10-16.md在两次metadata读之间从150208B/SHA3a8e…变177252B/SHA6d6d…，首份history完整未改。随后 [current CLI快照](cli-await-history.current.json)独立捕获当前bytes及完整149 occurrences、无cap；[18个exact excerpt groups](cli-await-grouped-contexts.json)仅按相同文本合并展示位置，已读全部组及原row。新快照不倒填旧snapshot完整性，也不冒称全库存始终稳定。这是历史文档漂移诊断，不是产品失败或产品重试。

[分类判断](decisions.json)保留NPM有限negative、旧await重复排除及历史边界；[validation](validation.json) runs为空。17个parseSource既有test声明+2个NPM selected test声明仅源码意图，0执行/通过/expect；选段中出现HOME/fixture代码也未运行、未读真实用户目录。0install/update/check/network/Git/native/账户/权限/custody/产品函数/语言fixture/测试；旧Skill/frontmatter失败继续SKIP。关键词和有限语义选读不等于全历史或全installer无bug。
