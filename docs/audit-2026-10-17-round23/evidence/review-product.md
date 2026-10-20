# Product 配置缺口独立静态交叉审查

冻结点 `c1d007ed0af1eca9b56b32fabbb0ea2401037ee1`。结论：**可保留 PRODUCT-R23-01 为窄 P3，1 formal / 0 candidate / 1 old related**。不需要为确认本项补 capture stub、替身构造器或运行真实 manager。此 Product review 没有产品 import、constructor、fixture、测试、SDK、Engine、模型、网络、真实任务、工具、文件业务操作、权限/安全/native 实验或 Git 写入，没有修改 Product 作者材料；本 review 为独立新增材料。

明确合同是关键：完整 `ProductRuntimeOptions` 在 define.ts:54–55 声明 cwd 为 Working directory，省略默认 process.cwd；该文件还明确这是 external repos 的 primary entry，返回 ready-to-submit RunManager。完整 factory.ts:33–34 对另一个 public factory 有同一 cwd 合同。`core/src/index.ts` 的公开 Product/Run exports 与 core/package.json 的 `.` entry 支持这是导出的 SDK 接口。没有 deprecated、reserved、ignored 或“仅每次 submit 才能设置 cwd”的反向声明。因此不需要仓内真实产品构造 consumer 才能判定这个公开选项合同；报告也明确没有观察外部用户或实际构造。

已独立完整静态读取两个工厂。defineProduct 的完整实现没有读取 runtime.cwd，createRunManager 的完整实现没有读取 options.cwd；它们仅创建并直接返回普通 manager，没有包装 submit、附带闭包默认值或改变进程 cwd。完整 RunManagerConfig 与构造函数选段没有 default cwd slot，submit 的 snapshot 在 :165 明确使用 `input.cwd ?? process.cwd()`。假定普通有效配置成功建立 manager，且提交省略 cwd、工厂 cwd 与启动 cwd 不同，这条确定的数据流就会丢掉指定默认值；不用引入任何非法输入或假定模型输出。显式 input.cwd 与两个 cwd 相同的反例都已在报告中作为**未执行静态控制**披露。

两个工厂共用相同 RunManager 默认值缺口，合并一项合适；它们不是两个已运行复现，也不增加两次缺陷计数。RunManager.executeRun 把其持久 snapshot 交给 runner；EngineRunner:187、249 分别把 run.cwd 送入 EngineConfig 和 client.run options。review 选读 context 构造与 execute 调用，普通 manager 没有从工厂 runtime 恢复 cwd 的注入。外部 context.engineConfigOverrides 的确可以覆盖部分 EngineConfig，但这既不能恢复已经错误的 submit snapshot，也不是这两个普通 factory 的补偿接线。报告没有把 static 配置传递扩大为实际工具、FS、MCP、模型、权限或安全边界行为，P3 的影响描述足够窄。

本 reviewer 补全文静态读取一个 public re-export 桥接文件：`packages/core/src/run/index.ts:1–78`，其中 :78 从 `./factory.js` 导出 createRunManager / CreateRunManagerOptions，补全 public index → run index → factory 接线。78 lines / 1769 bytes，SHA256 `a2ac2c0f00acca8130aeae535bdd83ba9c95acf231b46a77fe338f9a8c48aff6`，当前字节与冻结 Git blob 一致。此为 reviewer 额外 source pin，不改变作者原来的 19-pin manifest 或完整/selected 阅读声明；没有 import 这个 barrel。

重复问题挑战也成立：现有 May30 parent objects 集中在 redundant disable 与 customPrompt/sections precedence；与“public cwd 声明后完全未被消费”不是相同根因。第一批 FileHistory hook 忽略 cwd 属不同 hook→history 接线。`PRODUCT-R23-R1` 的父记录 `_id:36` / confirmed[46] 和当前 ProductPreset/PromptComposer 选段对应同一旧 prompt precedence 机制；仅保留 old related，不新增 severity、不执行 prompt 或模型。review 没有把重复 disable 列表直接认定错误，也没有用历史 global registerPreset 说明覆盖当前本地 AgentModule 实现。

独立只读元数据核验：作者 **13 个 artifact hashes** 全匹配；**19 个 source pins** 的当前字节、冻结 Git blob、bytes、lineCount 全匹配，所列 selected ranges 无越界；报告 **21 个本地链接**存在，所有 `#L` 在行数内；分类为 1/0/1。validation 的 runs=[]，product/test/pass/fail/expect/existing/focused 全为 0，和 report/receipt 一致，没有编造 raw/exit 或把静态阅读当作通过测试。hash 核验覆盖完整字节，但 reviewer 的 RunManager/PromptComposer/历史 JSON 阅读是选定片段或父对象，不等于全文语义审查或全历史穷尽。

Reviewer 元数据订正：最初脚本误猜 `product-artifact-receipt.json`，实际库存文件是 `product-author-receipt.json`，触发一次 FileNotFoundError；随后按真实文件核对。一次合并 source 打印被工具截断，未把未显示的 EngineRunner/RunManager 片段当作已读，随后只读补取 cwd 配置、context 和 execute 相关区间。历史父对象采用有界 excerpt 检查，不声称完整审阅其大段 verify note。以上均为 reviewer 导航/显示元数据问题，没有产品或 fixture 失败，没有作者修改、stub、产品重试或历史失败方向恢复。
