# Panel Agent Task 模型目录审查

冻结基线：`d86db33012dffd5d1849e76b869fa15eb260324f`。本方向新增 **0 项确认缺陷、2 项候选**。首次 guarded shard **12 个测试、36 次断言通过，0 失败、0 跳过**；全部为本批聚焦测试，未运行现有 Desktop 测试入口，也未执行 Host、Engine、模型请求或界面。

## CATALOG-R17-C1：目录 default 与 Core 的有效默认值回退不同

实际 [目录 leaf](../../packages/server/src/panels/agent-task-models.ts#L75) 仅在 `defaults.text` 命中本次输出连接 id 时返回 `defaultModel`。有一个正常 text connection，但 `defaults.text` 未设置或仍指向已移除 id 时，实际调用都返回一个模型行，且没有 `defaultModel` 属性；同一连接配上精确的默认 id 则返回该 id。见首次 [fixture](evidence/catalog-pure.test.ts)、[原始输出](evidence/catalog-pure.first.raw.log) 和 [exit receipt](evidence/catalog-pure.first.exit.json)。这些是实际纯函数结果，fixture 没有模拟执行 Host 分支。

[Panel 合同](../../docs/panel-apps.md#L373) 写明返回 effective `defaultModel`，省略 `agent.task.start.model` 应继续使用有效 CodeShell 默认值。静态读到的 [Engine](../../packages/core/src/engine/engine.ts#L936)、[共享 Runtime](../../packages/core/src/engine/runtime.ts#L94) 和 [CLI 解析器](../../packages/core/src/engine/resolve-llm-config.ts#L37) 在默认 id 缺失或失效时会选择首个可用/已注册连接；[schema](../../packages/core/src/settings/schema.ts#L265) 允许没有 `defaults.text`。服务器 [任务入口](../../packages/server/src/panels/agent-task-host.ts#L348) 则直接取 `input.model ?? catalog.defaultModel`，为空即抛出“配置并选择可用的默认模型”。这使“目录有模型却没有默认值”具有具体消费者，而不是仅展示差异。

保留候选：现有 [Desktop 测试](../../packages/desktop/src/main/panel-app-agent-task-models.test.ts#L48) 明确期望失效 default 被省略，可能代表 Panel 有意要求显式选择。配置省略默认值和目录输出在本批已执行，但普通 UI 新增连接会 [主动填入默认值](../../packages/desktop/src/renderer/settings/useModelConnections.ts#L215)；本批未运行设置加载、CLI、Engine、Host 或任务工作进程，不能声称已经实际触发完整任务失败。需要统一“有效默认值”合同与现有测试政策后再定性，不计确认缺陷。

## CATALOG-R17-C2：目录 trim 改写了实际连接身份

最小普通输入为手动目录编辑器可填写的自定义 provider id `" local "`。实际 [validateEntry](../../packages/desktop/src/renderer/settings/catalogEditor.ts#L53) 返回 `[]`，实际 [buildInstance](../../packages/desktop/src/renderer/settings/textConnections.ts#L78) 生成 `id` 和 `catalogId` 都是原样 `" local "`；实际 [catalogModelOptions](../../packages/desktop/src/renderer/settings/textConnections.ts#L169) 也保留原始 picker key。把这些实际 helper 生成的普通内存对象传入目录 leaf 后，输出 id/default 变成 `"local"`，不再等于输入连接 id。去掉首尾空格的对照保持身份一致。

根因位置为 [boundedText 的 trim](../../packages/server/src/panels/agent-task-models.ts#L27) 及其在 [connection id、catalog id、model](../../packages/server/src/panels/agent-task-models.ts#L60) 上的使用。同一机制的补充表征也已实际执行：两个真实 helper 创建的不同 id `" local "` 和 `"local"` 在目录中被折叠为一行；preset value `" one "` 经真实 buildInstance 保留并在真实 picker 得到 `Padded preset`，目录却把 model 改成 `"one"`，随后精确 preset lookup 失配，label 回退成 `"one"`。这些补充均归入同一候选，不另计问题。

普通生产路径静态证据：[编辑器 id onChange](../../packages/desktop/src/renderer/settings/ModelCatalogPanel.tsx#L583)、[preset value onChange](../../packages/desktop/src/renderer/settings/ModelCatalogPanel.tsx#L732) 都直接保存输入；[save](../../packages/desktop/src/renderer/settings/ModelCatalogPanel.tsx#L215) 原样传 draft；[schema](../../packages/core/src/model-catalog/types.ts#L17) 的 id 和 preset value 限制长度但没有 trim；[saveCatalogEntry](../../packages/core/src/model-catalog/save-entry.ts#L123) 验证后保存 parsed data。Core [findCatalogEntry](../../packages/core/src/model-catalog/index.ts#L101) 精确匹配 catalog id，[池条目](../../packages/core/src/engine/model-connections-pool.ts#L61) 用 `inst.id` 作 key，符合 leaf 注释“connections 是真实 pool keys”与 Panel 文档“返回 id 可用于选择连接”的合同。

保留候选：本批实际执行的是目录和三个纯 UI helper；React 编辑器、IPC 保存、schema.safeParse、Core 池注册/选择与 Panel 工作进程全部仅静态阅读。实际 [任务服务](../../packages/server/src/panels/agent-task-service.ts#L183) 也 trim 入参 id，可能意味着 Panel 对首尾空格身份另有刻意限制；仓库缺少覆盖此配置跨边界行为的明确政策。因此不把静态推导的“返回 id 无法选中原池条目”写成已执行的任务失败，也不认定真实网络模型接受带空格 model value。

## 验证与覆盖边界

唯一实际命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round17/evidence/catalog-pure.test.ts
```

三个 fixture imports 都是绝对路径 leaf，server 目录源码无 imports；两个 Desktop helper 仅有 type import。前置检查只读取实际文件与冻结 Git bytes，见 [preflight](evidence/catalog-preflight.json)，没有依赖路径猜测或 resolver 探测。首次 combined stdout/stderr 直接写入 raw 文件、exit 保存后才检查内容；没有失败修复、重试或替代运行。通过测试刻画现有行为，并不表示候选已修复。

对照覆盖精确默认 connection id、多个连接顺序、auxText 与 text 区分、无 label 的 preset、自定义 model fallback、非 text/失效 catalog 过滤、重复 exact id 的首项保留、Unicode label 和输入不变性。没有 null catalog 元素、真实 credential/provider availability、浏览器/原生进程、SettingsManager、Host、扫描器、server barrel 或用户文件实验。

Desktop [re-export](../../packages/desktop/src/main/panel-app-agent-task-models.ts#L1) 指向 server `/panels`；现有测试入口仅静态阅读，避免通过该大 barrel 导入 Host。服务器 [catalog provider](../../packages/server/src/panels/agent-task-host.ts#L136)、[models 方法](../../packages/server/src/panels/agent-task-host.ts#L510)、Desktop [catalog callback](../../packages/desktop/src/main/index.ts#L697) 和 [bridge 分支](../../packages/desktop/src/main/panel-app-bridge.ts#L2111) 都仅静态定位。此处不是完整 Panel/模型链路验证。

## 去重与元数据

[去重脚本](evidence/catalog-dedup.py) 递归读取此前 `docs/`、`bugs/` 下全部 MD 和 JSON，包括 archive/_archive，排除本批。共 **1,134 个 MD、804 个 JSON**，JSON **239,449 个 string leaves / 335,081 个 scalar leaves**，解析错误 0。三个查询分别匹配 17、29、12 次，最多保留 120 个上下文；匹配次数不是新缺陷数。见 [完整库存/命中](evidence/catalog-dedup.json)。命中主要是已有目录路径库存、Panel 文档、旧 Core 回退说明和无关文本空格问题；没有找到这两个具体 Panel 目录机制的既有缺陷记录。关键词检索不证明全语义去重穷尽。

一处猜测的 shell glob 未匹配，另一处 receipt 生成前的前向链接检查失败，均为元数据错误，不是测试/import 失败；完整首次响应转录与后续独立真实库存、文件检查边界见 [navigation skip](evidence/catalog-navigation-skip.md)。已跳过那条猜测路径，receipt 顺序仅修正元数据，没有运行任何替代产品验证。

[机器验证摘要](evidence/catalog-validation.json)、[空 findings](evidence/catalog-findings.json)、[候选明细](evidence/catalog-candidates.json)、[源码 pin/阅读范围](evidence/catalog-source-manifest.json) 与 [artifact receipt](evidence/catalog-artifact-receipt.json) 分开记录冻结字节、静态阅读和实际执行；pin 存在不代表整文件或所有传递依赖均已验证。
