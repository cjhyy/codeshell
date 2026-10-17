# Round28 覆盖广度选择 prep

只做当前文件库存、历史 source-manifest 元数据提取、关键词导航和少量纯文本选读；**0 产品/import/测试/fixture/VM/eval/Git/native/UI/模型/网络执行**。父报告 baseline9b 只是最初上下文，不独立证明当前Git HEAD；所有SHA为下述读取时点的 filesystem bytes。后续 Root 已报告32c633e58是Round27 docs-only集成，不把该口头信息冒充本作者Git核验。

## 数据与边界

- `rg --files packages -g '*.ts' -g '*.tsx'`（exit0）得到 **4087 文件 / 949503 行**。inventory/hash不是4087份源码语义审查。
- 从 `docs/`、`bugs/` 下名称含 `source-manifest` 的 **162份JSON**递归寻找明确path+64位SHA；0parse error。190个path没有有效SHA而不计入版本绑定。只有精确full标签允许计full，明确selected/ranges保持selected，hash/inventory/无范围保持pin-only，重复副本合并同claim variant，旧SHA不借currentSha256升级。
- 当前同SHA明确full claim **96**；selected-only **59**；同SHA pin-only **869**；仅旧版本 claim **27**；没有符合提取合同的source-manifest row **3036**。这是保守的结构化证据分类，**不是实际历史审查比例**；散落在正文/不同schema的覆盖可能没有被提取，旧作者full标签的真实性也未逐项复核。
- `coverage-index.json`仅列1051个有旧row的当前文件，完整4087个path/hash在`package-inventory.json`；没有旧row的3036可由差集得到。避免把同样的空claim大表复制两遍。`coverage-ranking.json`列242个短文件、零runtime-import文本提议，仍需Root读源码和实际消费者；过滤器不构成纯度、安全或新颖性证明。
- 当前短名单的全历史导航排除Round28，递归含169个exact archive/_archive路径：2677文件=1262MD+1415JSON，506929字符串/740424标量，0parse error。stream/dialog/status/aux/tone命中27/10/12/81/20，保留27/10/12/40/20。关键词只导航，不能据零source-manifest row宣布“从未审过”。例如stream有旧walkthrough，status有旧设计正文。

## 三个具体新frontier提议

1. **`packages/desktop/src/renderer/markdown/splitStreamingMarkdown.ts`，124行，SHA `1fbe136ecda36e905f0cde204ceaa20dfae4939f49c1519d95ca98101dc14995`。** 直接字符串分割、fence状态机，0imports；已有同目录test文件可先读。提议静态核普通stream producer和consumer的稳定前缀/activeTail合同。源码明确reference-style link/footnote known limitation，旧walkthrough也记过，不将这些边界当新bug。不要借本提议恢复旧parseDocument失败方向，不运行Markdown/React/parser。
2. **`packages/desktop/src/renderer/ui/dialogState.ts`，78行，SHA `b7a6b81ccff93ebdd63bd96816373ead1d94d9bc793588312f492f31ac4c28f4`。** 显式无React/DOM的queue状态helper，0imports；但resolveActive会调用传入resolve回调，提议静态核queue/promotion与真实hook消费者的时序合同。将来若需要验证也只能由Root另选owned fake callback，当前没有调用函数/Promise/UI。
3. **`packages/desktop/src/renderer/sessionStatus.ts`，26行，SHA `b5a119fa35ecd9cb594d04d1673f63fbc9e20a25e97304b45eb8fcfc94d8f4d5`。** 纯Set membership优先级resolver，0imports，现有test可读；提议静态核asking/running/unread普通producer和同bucket消费，一致状态优先级本身不是新bug。此处bucket仅作字符串membership，不开展身份/权限实验。

三者当前均无符合提取合同的source-manifest row；已全文只读文本作筛选（124+78+26），没有完成这些模块的bug审查、执行测试或观察行为。另看aux-key12与askUserTone46作为备选文本，aux已有较多历史正文，tone含multiSelect解释，因此未把这两者放进三项推荐。文本读完不自动成为正式发现，也不计产品执行。

## 文件与重现

`coverage-method.py`是元数据提取/排名方法，读取源码为文本/hash，不导入模块；`source-manifest-inventory.json`存162份输入JSON字节SHA，`shortlist-history.json`存短名单导航统计、有限上下文与compact prior path/hash。`package-inventory.json`保留最早当前源码快照；`coverage-index.json`、ranking各含方法限制。元数据扫描没有发生失败或重跑产品，未更改Round27或任何仓库文件。最终`receipt.json`只校验7份自有prep字节，self-excluded；不是测试或全仓完成证明。
