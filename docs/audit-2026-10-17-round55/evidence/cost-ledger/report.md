# Cost-ledger普通估价：有限静态审查

**0正式 / 0候选 / 0新增关联。** 完整读取当前 pricing.ts48行，并核其普通 usage producer→ledger settlement消费分支，未建立正常输入的新反例。外部最新价格、实际账单、账户、provider请求或持久化机制均未验证；所有产品/helper/import/test/fixture/timer/network/native/model/Git执行0。

内部合同与反证：pricing.ts6明确bundled estimate，未找到price时返回pricing/cost为null而不是默认价。direct provider只查bundled MODEL_PRICING，OpenRouter用完整vendor/model ID查snapshot；cache价明确标estimated。模型表的cacheRead/cacheWrite由内部统一pair推导，不能把它当作实时价格或发票承诺。Anthropic普通usage将read/write cache计入prompt总数，OpenAI-compatible计数从details映射；pricing再从prompt剔出已缓存部分、分别乘对应估价，未发现这条正常合同的二次计入。client-base115–126→context101/115–124→store.normalizeUsage52–76/settle248–254把报告usage保留并调用estimateReceipt；store225–227保留model字段。没有用任意坏DTO或假设实际provider价格制造问题。

[旧canonical范围](canonical-locator-metadata.json)与[R9原对象](r9-canonical-metadata.json)表明pricing原R9仅selected/excerpt，不能叫历史未读/首次。本次pricing full48亦不增加“独有首次覆盖”声明。summary.ts81行同SHA `4ef61d2b…` 在原49 root-summary-review `/files/0` 已明确full1–81；本包在正文前排除，当前body0，不声称重新验证其汇总合同。旧COST-R9-01是未绑定standalone CostTracker丢完整model ID；原R49远程空singleton假设被实际in-process绑定反证，已读两份原MD共49行，均不重报或恢复旧运行。

[共享历史投影](history-projection.json)引用Root冻结batch（5433份MD/JSON，纳54排55+，3997418 recursiveJSONvalue scalars、archives包含、0parse错）；pricing合并path/SHA命中79全存，summary145仅前100。该batch是path/SHA导航，不冒充旧因语义穷尽；本review定向亲读原canonical对象/上述旧报告，未再扫全史百万scalar。原batchSHA/时间见[引用](shared-history-reference.json)，Root另行归档原件一次。

[准确范围](source-manifest.json)：1full+9selected产品，共208产品语义行；2既有测试文件选读24行声明；合计232语义、442唯一display行。导航、IO/clock/auth/client边界、重复显示和旧作者阅读不加成语义覆盖。既有unknown-price/Anthropic cache断言仅作声明反证，未执行任何测试。summary与未启用index barrel为hash-only，指令文件本次仅核同SHA并复用先前阅读。

[首诊断](diagnostics.json)保留自有metadata presenter语法首错、错误source目录定位和正常no-match；修正仅用于metadata展示/文件名导航，不是产品重试，截断0。[ending](ending-checks.json)核16个源/指令pin、6份选读原metadata及共享batch全同；不声称独立重验共享5433份history全部字节。分类见[classification](classification.json)，运行边界见[validation](validation.json)。源阅读已结束，仅写exact tmp，未改产品或121冻件。
