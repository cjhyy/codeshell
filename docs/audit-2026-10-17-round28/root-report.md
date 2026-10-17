# Round28 小型 JSON / 路径 / 状态函数静态审查

**0 formal /0 candidate /0 new-related，0动态执行**。全文读 canonicalJson、store-paths、sessionStatus 及各自测试源码；选读 report/candidate 的普通序列化调用与 App 的状态徽标 consumer。精确 SHA、阅读范围、首 pin 时序保存在 [source manifest](evidence/root-source-manifest.json)。CODESHELL/AGENTS 另计指令；三份 before-read source pins 已持久化，其余首次持久 hash 明示 after-read、initial null，不回填不存在的时点证明。

[canonicalJson](../../packages/optimization-lab/src/contracts/canonical-json.ts:7) 逐层排序 object keys，标量明确只接受 JSON 类型与 finite number；plain/null prototype 对象和 dense 普通 array 有显式合同。descriptor 检查拒绝 getter/非enumerable，symbol/extended/sparse array 与祖先 cycle 被拒；finally 删除祖先项，所以共享普通子对象不被误判为 cycle。`-0` 序列化成0由 [既有测试声明](../../packages/optimization-lab/src/contracts/canonical-json.test.ts:16) 明确接受，不能仅凭“distinct inputs”注释登记一个 hash碰撞缺陷。report/candidate 选段使用其返回文本作普通JSON/摘要，当前没有具体符合合同的输入被错误编码的证据。未调用 serializer、crypto 或反射检查，也不把静态测试期望称为通过。

[store paths](../../packages/optimization-lab/src/store-paths.ts:7) 先对项目路径 realpath 后再摘要，labRoot 组合 codeShellHome。它有真实FS/extension/home依赖，故本轮只读14行与test定义，没有运行路径、symlink、operator HOME 或 store/custody 流程。代码明示依赖和测试意图不足以证明真实平台行为正确，也没有新普通输入反例可登记。

[sessionStatus](../../packages/desktop/src/renderer/sessionStatus.ts:16) 依序查询 asking/busy/unread membership，正好符合公开优先级 asking >running >unread >none，且不缓存或修改sets。[App:678](../../packages/desktop/src/renderer/App.tsx:678) 选段构造bucket asking集合，再为每个会话调用该helper；选段不等于完整审批/后台session路由审查。已有7个测试声明覆盖优先级和其它bucket，但本轮0测试、React、UI或事件运行，未用它们证明实际状态传播。

[全历史去重](evidence/root-dedup.json) 覆盖 docs/bugs 的 **2677=1262MD+1415JSON**，506929 string values /740424 scalar values，169 exact archive/_archive 目录路径，0 parse errors；排除本轮，保留完整库存SHA。canonical25/storePaths21/status3是regex occurrence总数，cap80下均保存；大量只是先前库存path。status的旧R18导航/旧设计文字说明曾提及它，所以coverage索引“无structured manifest row”不能解释为历史从未阅读。没有新增发现需要升级或重复计数，关键词也不构成语义穷尽证明。

本报告只补实际full/selected阅读，不改变原Lab prep的15pins覆盖，也不将其48个inventory hashes算全文。所有测试和fixture只是源码阅读；[validation](evidence/root-validation.json)的runs为空。R27首次失败夹具/日志保持原样，未修、未重跑或改用其它执行方式；当前整个仓库的审查目标继续active。
