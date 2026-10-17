# 工具目录、搜索与注册元数据审查

冻结源：`248d091202869c07274adedf4fd50403105f1b1f`。本方向 **0 项新确认、1 个未确认候选**。2 个首次 guarded shard 共 **17 pass、97 expect、0 fail、0 skipped**；其中 3 项为新增候选及对照测试，14 项为既有纯目录状态基线。没有修改产品代码，未执行 Git 写操作。

## TOOLS-R9-C1：同名 definition-only 注册仍保留前次实现（候选）

`packages/core/src/tool-system/registry.ts:85` 的 `registerTool(tool, executor?)` 更新定义和 registration ID（`:89–91`），仅在传入 executor 时更新实现（`:92–96`）。因此，先注册普通自定义工具和 fake executor，再对同名工具仅注册新定义，会产生新元数据与旧实现的组合。旧注册返回的 disposer 已不能移除新定义（`:97–99`），但旧实现仍在。

[首次 fixture](evidence/tools-registry-replacement.test.ts) 实际调用 Registry 和 ToolSearch：搜索返回 `Purpose: new metadata only`，随后 Registry 调用仍返回 fake 旧实现的 `old:next`，调用计数为 1。全部数据和 executor 均在内存；没有调用任何实际内置工具或外部服务器。两个正常对照分别证明：fresh definition-only 注册没有 executor，调用报 `No executor registered`；显式传入新 executor 后运行新实现，旧 disposer 不影响新注册，新 disposer 正常清理。

这仍是 **SDK API 契约候选**，没有计入确认 bug。`hasExecutor` 的注释（`registry.ts:150–152`）允许无实现的动态定义，且 `ToolRegistry` 从公共 SDK 导出（`packages/core/src/index.ts:138`），但没有找到“同名仅更新定义必须删除旧实现”的明确承诺。现有 Engine 自定义工具适配（`engine.ts:1062–1066`）要求 executor；所读 MCP 注册调用也显式传入 executor。只读源码和 fake executor 结果不能证明当前 Host 普通流程发生了错误调用，也不能排除 API 有意支持仅更新元数据的解释。

[原始输出](evidence/tools-registry-replacement.first.log)：3 pass、18 expect、0 fail、0 skipped；[首次退出码](evidence/tools-registry-replacement.first.exit.txt) 为 0。没有修复或重跑本候选。

## 已审查的普通数据行为

- ToolSearch 的 query 类型、非空及长度入口、大小写折叠、按空白分词、名称/描述子串排序、精确名称额外得分、`max_results` 默认与上限、`select:` 逗号拆分和去重、紧凑元数据和输出预算：已读实际实现与现有测试，未确认新缺陷。这不代表本轮执行了整份 ToolSearch 测试；其权限/MCP/真实浏览器方向未运行。
- RunToolSurface 的 eager/deferred 初始目录、精确选择和顺序、目录替换后的保留历史、晚到定义、冻结副本和嵌套 schema：运行了现有 `run-tool-surface.test.ts` 的全部 14 项纯内存数据测试，79 expect、0 fail、0 skipped。测试中名为 revocation 的场景只是替换内存目录，不构造权限分类器、Host 或工具执行器。[首次日志](evidence/tools-surface-baseline.first.log) 与 [退出码](evidence/tools-surface-baseline.first.exit.txt) 已保存。
- Registry 定义输出、同名注册/disposer、局部 fork 的 map、普通 metadata 与执行实现的关联：只对上述候选运行 fake executor，其余静态核对。路径元数据 validator 和轻量参数 validator 已阅读；路径策略、严格验证安全边界和权限语义没有开展实验，也不据此登记问题。
- 浏览器搜索优先分数仅静态阅读；没有打开浏览器、执行浏览器工具或启动任何第三方进程。源码依赖图的存在性不等于所有依赖模块都已审查。

## 去重、依赖与证据边界

[历史去重](evidence/tools-dedup.json) 遍历既有 `docs/` 和 `bugs/` 的 Markdown/JSON，包含 archive / _archive，排除当前 round9。JSON 逐层解析，不以压缩整行匹配替代记录审查。匹配到的旧 ToolRegistry/MCP 共享、热启用、ToolSearch deferred loading、冻结模型步骤和权限门禁材料作为背景；没有把这些已知内容再次计为新缺陷。关键词搜索不单独证明候选新颖性或正确性。

[依赖预检](evidence/tools-preflight.json) 用 TypeScript AST 核对字面量 imports，283 个源文件、636 个相对 import 无缺失；bare import 通过只做解析的 Node import-condition resolver 核对。既有基线入口另行核对。这不执行包入口、不安装或构建依赖。最初 regex 预检误读字符串并采用 require conditions，原草稿及[说明](evidence/tools-preflight-note.md)保留；纠正发生在任何测试之前，属于元数据纠正，没有失败测试重试。

两个 shard 均由 `node scripts/run-bun-test-shard.mjs --timeout 30000 FILE` 启动，先落盘未经修改的合并 stdout/stderr 和退出码，再检查输出。没有真实模型、网络、服务器、工具服务、用户数据、原生 UI、安装或 `dist` 重建；没有声明全仓测试、build、lint 或 typecheck 通过。[验证汇总](evidence/tools-validation.json)、[候选结构数据](evidence/tools-candidates.json)、[冻结源清单](evidence/tools-source-manifest.json) 和 [文件收据](evidence/tools-artifact-receipt.json) 提供具体范围。
