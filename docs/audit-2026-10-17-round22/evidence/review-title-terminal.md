# Title 与 terminal 独立静态交叉审查

审查冻结点 `ab258c3f534b19014b2ed85da3111649f166ab86`。结论：两份报告的计数、执行边界和降级判断可接受；没有需升级的新缺陷或候选。本 reviewer 没有运行产品、import、fixture、测试、模型、renderer、IPC、native 或计时器，也没有修改作者材料或 Git。只新增本 review。

已读 `title-report.md`、`terminal-frontier.md`，检查其分类、source manifests、author receipts、first raw/exit、validation、dedup 决策与采集脚本。独立元数据检查结果：title 收据 13 个 artifact hashes、terminal 收据 19 个 artifact hashes 全部匹配；21 个 source pins 的当前字节、冻结 Git blob hash 和行数全部匹配；两份报告各 20 个本地链接存在，所有 `#L` 均在行数内。哈希核对不等于全文语义阅读，尤其 terminal 两份 Core types 文件仅为 hash-only。

Title 的真实 `session-title.ts` 54 行及 focused fixture 已全文静态读。raw 明确 12 pass / 34 expect / 0 fail，守卫 `Completed ... 12 tests, 0 skipped; 0 failures`，exit 0，raw hash 同时匹配 exit 与 validation。argv 只有 owned focused 文件；既有 `engine.session-title.test.ts` 不在执行列表。本 reviewer 选读了该混合文件的 import、五个叶子测试以及 late-state/Engine 场景：Engine/provider/持久化依赖真实存在，但它们均不是本批通过项。

fixture 动态只导入两个 type-only import 的真实叶子，以 owned `createMessage` 回调和同步 collector 验证请求配置、ASCII 截断、包裹引号/空值清理、usage 控制及两个无 timer 的 deferred Promise。同步回调失败、字符串 Promise 拒绝和 collector throw 都是人工边界输入；报告没有据此推定普通 provider 或计费缺陷。deferred 仅证明独立叶子返回与 collector 隔离，未被包装为 Engine 并发、异步改名或持久化验证。没有运行 UTF-16 surrogate 旧机制，也没有制造模型违反“≤6词/单行”等 prompt 愿望来升级 validator 问题。

静态选读 `run-finalize.ts:290–329` 后，确认 callback 仅传 `{ title }` 给 `updatePersistedSessionState`；旧整份 state 回写机制已被历史 goal persistence 文档收录，当前作者没有把它重新报错或声称动态修复通过。选读 Sidebar rename、`renameSessionLocal`、`useHostSubscriptions`、history sync、SessionsView commit、Main handler 与 Server store 后，`titleManual` guard 和独立 override store 构成真实普通反证。它们都只是静态接线，不能替代完整改名链实验。

本 reviewer 另补读作者 manifest 未单列的真实桥接文件：`packages/desktop/src/main/session-titles-store.ts:1–14`，全文静态读取，**无 import/执行**。该 adapter 从 `@cjhyy/code-shell-server/storage` 导入 `createSessionTitlesStore`，`setTitle` 转发到该 store，补全 Main handler 与 Server override 的接线证据。冻结 Git blob 与当前字节相同，SHA256 为 `5c7ea7233f145105a79886d570d0735e8d66c1a90ab9495f9ed054d85bc374d7`，680 bytes / 14 lines。此文件属于 reviewer 新增 source pin，未改变 title 作者的原阅读范围或 16-pin 收据。

Terminal 的 `terminal-ui.ts` 235 行和 `renderer.ts` 163 行已全文静态读，`run.ts` 选读 1–27、225–280。六个 runtime dependencies、顶层 chalk mutation、Marked 初始化以及 ora.start/版本查询足以支持当前动态排除；未抽取源码、替换依赖或制造消费者。实际 headless run 从 renderer.ts 构造 renderer 并转交事件，renderer 无 terminal-ui import。已检查普通名称与全部导出名称导航的 argv/输出；命中同名局部函数不是 terminal-ui 的消费者。限定的字面检索不能证明仓库外、计算或生成消费者不存在。

banner 的 56 与 `+4` 算式可静态推导短 ASCII 行内宽 60，但报告准确保留为 **1 条 unclassified static lead**，0 finding / candidate / related，未宣称已捕获产品输出或实测终端列宽。没有恢复旧 TUI Diff、sliceAnsi、JSON summary、i18n 等失败方向，没有把历史 Unicode/bytes/A12/流重试机制算成新项。

terminal 两份 Python collector 的 raw `.txt` hash/bytes 与 exit receipt 一致，exit 均 0；它们采集 Git/rg/JSON 元数据，不能加进 guarded shard、测试、产品 stdout 或 runtime 计数。其 source manifest 明确区分 2 full + 1 selected + 2 hash-only，本 reviewer 同意此边界。title 的 12/34 与 terminal 的 0 动态不会重复计数。两份历史扫描都递归处理 MD/JSON 全标量，保存的上下文上限和噪声已披露，未作语义穷尽声明。

Reviewer 元数据订正留档：第一次检查脚本错误地将 terminal 收据的 batch-relative `evidence/...` 解析为 repo-relative，发生 `FileNotFoundError`；第二次又误把 title 分类的 `{base, findings/candidates/related, note}` wrapper 当作裸空数组，发生 `AssertionError`。读实际 schema 后仅修正 reviewer 路径与解包逻辑，最终 32 个 artifact、21 个 source pins、40 个报告链接及 3 份 raw/exit 检查全部通过。未改作者文件、未运行或重跑任何产品。曾对 terminal 大型 commands 元数据打印有界字符前缀，该前缀未当完整阅读；随后按全部命令的 argv、exit、stdout/stderr bytes 结构化核对。
