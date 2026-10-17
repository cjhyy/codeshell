# Product 配置到 managed run 的静态审查

冻结点 `c1d007ed0af1eca9b56b32fabbb0ea2401037ee1`。新增正式问题 **1 个 P3（PRODUCT-R23-01）**，候选 0，旧问题关联 1。此方向全部为静态证据，产品 import/constructor/test/model/network/native 执行均为 0，没有修改产品。下述示例用于说明普通公开 API 合同，没有实际创建任务或目录。

## PRODUCT-R23-01：公开工厂声明的 cwd 在提交默认值链中丢失

[ProductRuntimeOptions.cwd](../../packages/core/src/product/define.ts#L54) 明确是工作目录，省略时默认 process.cwd()；公开 [defineProduct](../../packages/core/src/index.ts#L635) 返回可直接 submit 的 manager。普通调用是在启动目录 `/work/launcher` 创建产品时指定 `cwd: "/work/target"`，随后 `manager.submit({ objective: "Summarize this project" })`，无需每次重复填写产品 runtime 选项。预期该 run 默认使用 `/work/target`，显式提交的 `input.cwd` 仍应优先。

实际源码 [defineProduct 的 RunManager 配置](../../packages/core/src/product/define.ts#L161) 完全没有读取 runtime.cwd。该函数只读取 runtime.runsDir、llm、permissionMode、sessionStorageDir；既不把 cwd 放入 manager 配置，也没有包装返回 manager 的 submit。完整 [RunManagerConfig](../../packages/core/src/run/RunManager.ts#L62) 没有默认 cwd 字段，完整构造函数不接收这个值；[submit:165](../../packages/core/src/run/RunManager.ts#L165) 只能用 `input.cwd ?? process.cwd()` 构造 snapshot。因此上述普通调用的 snapshot.cwd 会选启动目录，指定的 runtime.cwd 没有传递路径。

同一缺口也存在于另一个公开便利工厂 [CreateRunManagerOptions.cwd](../../packages/core/src/run/factory.ts#L34)：[createRunManager](../../packages/core/src/run/factory.ts#L95) 同样声明该选项，却完全没有读取 options.cwd。两种入口共用同一个缺失默认值链，合并为此一项；没有将另一个 API 重复计数。

下游没有从产品 runtime 恢复目录：[RunManager.executeRun](../../packages/core/src/run/RunManager.ts#L659) 把 snapshot 交给 runner；[EngineRunner 的 EngineConfig](../../packages/core/src/run/EngineRunner.ts#L187) 与 [client.run options](../../packages/core/src/run/EngineRunner.ts#L249) 都用 run.cwd。普通 `input.cwd` 显式提供、或启动目录恰好等于配置目录时，从源码可作为正常控制；这些控制也未执行。外部执行上下文可以覆盖部分 EngineConfig，但 defineProduct 返回的普通 manager 没有注入此类补偿，且 client.run 仍明确传 run.cwd。

影响限定为公开 cwd 选项被忽略、run snapshot 和后续配置沿错误默认目录传递。可能影响使用者对目标项目的选择，但本轮没有构造 Engine、实际工具、MCP、模型、权限、安全边界或文件读写，不把这些下游行为作为已观察影响。P3 的依据是可直接确认的 API 配置合同违背，不是镜像实现的测试断言。记录建议是在 manager 的提交默认值链保留工厂 cwd，并保持每次 input.cwd 优先；未实现修复。

## 旧机制与正常反证

旧 May 30 Product 记录不是本次 cwd 根因。[原始父对象摘录](evidence/product-selected-history.json) 保存了 `product/define.ts` 的 8 个相关对象及另一条间接提及 createRunManager 的 TUI 记录：主要是重复 disable 列表，以及 customPrompt/sections 优先级。针对 cwd 再扩展到 createRunManager/factory 与目录忽略词检索；旧 findings 中唯一 createRunManager 字样是 TUI runs 命令冗余 store 实例，不是目录默认值问题。旧 [file-history hook 忽略 options.cwd](../audit-2026-10-16/core.md#L44) 属另一个 hook 到 FileHistory 的路径，不能代替或合并这里公开工厂到 RunManager 的配置丢失。

`PRODUCT-R23-R1` 仅关联旧 May 30 `backlog_ided.json` 的 `_id:36` / `backlog_confirmed.json[46]`。当前 [ProductPreset](../../packages/core/src/product/types.ts#L37) 仍说 customPrompt 优先于 sections，而 [PromptComposer:315](../../packages/core/src/prompt/composer.ts#L315) 加入 custom_system 后，仍加入 [behavior:341](../../packages/core/src/prompt/composer.ts#L341)。这是旧同机制的当前静态上下文，不新定级、不执行 prompt/模型、不增加 formal/candidate。重复 disable 列表的旧推测也不新增：当前 enable set 先移除项目再下传 disable，单凭重复筛选不足以证明冲突。

其余配置的静态正常链已核：custom/append prompt、custom tools、hooks、MCP、turn/context 限额、permissionMode、sessionStorageDir 从 define 进入 EngineRunner；tags/metadata/concurrency/evaluator 进入 RunManager，submit 合并 tags/metadata 且输入优先。产品 preset 通过本地 product module 进入 RunManager composition 与 runner，不再据旧文档的全局 registerPreset 说明推断跨产品污染。没有执行这些配置、授权流程、模块 compiler、evaluator 或 custom tool，不将静态接线称作动态通过。

完整阅读 define/types/product index、RunManager、EngineRunner、run/types、Evaluator、factory。core 公共 index、PromptComposer 和历史说明仅选段；阅读边界及 frozen/current SHA 见 [source manifest](evidence/product-source-manifest.json)。源码内仅找到 defineProduct 的声明/示例和类型文档，未找到仓内真实产品构造调用；普通触发依赖公开 SDK 的明确选项合同，未宣称已观察外部用户。Core barrel 没有导入。

## 去重、验证与限制

[全历史扫描](evidence/product-dedup.json) 包括 docs/bugs 的 MD 和递归 JSON 标量，含 archive/_archive，排除本批；读取时 2301 文件（1213 MD、1088 JSON），335490 字符串叶、472091 全标量叶，0 parse error。exact 139 次保留 100 context，cwd 13 次、config 62 次；[补充扫描](evidence/product-cwd-dedup.json) factory 86 次、cwd_loss 7 次均低于 100 cap。大部分为库存、旧接线说明或无关目录记录；匹配数不是语义穷尽，父对象与相关旧报告另行有界阅读。[去重决定](evidence/product-dedup-decisions.json) 保留选择与排除，未只因关键词零命中就宣称新问题。

没有编写/运行 fixture，不曾使用 capture stub 或抽取函数，不运行现有 RunManager/EngineRunner 混合套件。首轮合并 broad 导航输出被工具截断，未将未显示历史或泛引用当成已读；后续按实际路径分段阅读。没有 import、constructor 或测试失败，没有 SDK/旧失败路线恢复，所有产品/测试执行计数为 0。[validation](evidence/product-validation.json) 与 [author receipt](evidence/product-author-receipt.json) 记录静态交付范围及 hash。
