# 第十批：模型目录与缓存数据

冻结提交：`6966dc0f98d21dbc2ecced6cdd6467d17b81bc39`。本分项新增 **0 个正式缺陷、0 个候选**。3 个首次 guarded Bun shard 均完整通过：**55 pass、0 fail、0 skip、278 expect**，其中 51 个既有测试、4 个新增普通数据控制。另有 1 次静态读取命令失败，已保留并跳过该方向。

## 审查与验证范围

- 阅读 Catalog schema、参数 wire 投影、按 id/value 的 upsert、用户目录加载/合并/来源、保存/删除实现和模型缓存读写/TTL，以及连接到 ModelPool 的纯数据桥。静态阅读不代表执行对应 provider、凭证或保存路径。
- 实际执行目录 schema、merge、upsert、来源、参数投影及内置文本 preset 的既有测试；其中 user catalog 文件只位于测试自建临时 HOME。`builtin-text.test.ts` 的厂商模型窗口/vision 断言仅表示冻结仓库内部一致，没有重新核验厂商事实。
- 实际执行 cache 缺失、写读、畸形 JSON、TTL、建目录和首次 context backfill/显式覆盖控制，文件只位于测试自建临时目录。没有 HTTP 请求、provider fetch 或真实模型调用。
- 新增 [catalog-data-controls.test.ts](evidence/catalog-data-controls.test.ts) 验证 `false`、`0`、空文本、未设置值、同层多个 dotted path、schema 通过的 `vendor/model:revision` 替换、输入数组保持和参数文档格式。它们是正常行为控制，没有故意失败断言，也没有修产品代码。
- 冻结已包含 `304781e52c0ab18b79514d8e51c6dbf9da672421`（`fix(core): honor current model capabilities across tools and requests`）对所读模型目录/池的最近改动。本分项以冻结版本为准，不将先前 vision 行为当成当前缺陷。

## 未升级的观察

`ModelPool.reloadCachedContextWindows()` 在 [model-pool.ts](../../packages/core/src/llm/model-pool.ts#L145) 只填未设 `maxContextTokens` 的条目，并将推断结果写入同一字段。不能仅凭方法名认定缓存更新后必须刷新已推断值：源码注释明确保留 prior code path 的已有值，尚缺正常调用者触发与产品契约。推断来源丢失已有 [归档设计记录](../refactor/_archive/goal-judge-context-refactor-FINAL.md#L129)。因此没有新增 bug 或候选，首次 backfill baseline 也不证明后续 refresh。

`applyParams` 的父/子 wire path 冲突虽可由自造参数表构成，但未找到正常内置 producer 或重叠优先级要求；没有将接受的任意配置冲突升级成产品缺陷。

全历史查重覆盖先前 `docs/`、`bugs/` 中 audit/review/archive/_archive 的 Markdown 行和解析后的 JSON 字符串，排除本批。扫描 1,054 文件；[初始命中](evidence/catalog-dedup-initial.json) 和 [去除元数据噪声后的摘要](evidence/catalog-dedup-summary.json) 保留。`round9` 独立 CostTracker 身份估价问题未重复审查或重新计数。

## 首次失败与跳过

一次静态调用链读取误写了不存在的 `packages/core/src/engine.ts`，`rg` exit 2，后面的 `&& sed` 未执行。保留 [工具输出转录](evidence/catalog-static-read-failure.md) 后跳过 cache refresh 调用链方向；未修改路径重试，也没有替代读取恢复该验证。这是静态命令失败，**不是 Bun shard 或产品 bug**。

没有执行 `save-entry.test.ts` 的进程并发/链接路径组、凭证解析测试、真实 settings、真实 provider、Desktop/TUI 页面、共享 dist 构建或全套测试。保存/删除实现只有静态阅读，不声明其运行正确性。

## 材料

- [validation](evidence/catalog-validation.json)：命令、计数、范围、静态跳过。
- [目录 baseline 原始日志](evidence/catalog-existing.first.log) / [首次退出码](evidence/catalog-existing.first.exit.json)：44 pass、258 expect，6 文件。
- [缓存 baseline 原始日志](evidence/catalog-cache-existing.first.log) / [首次退出码](evidence/catalog-cache-existing.first.exit.json)：7 pass、10 expect，2 文件。
- [新增控制原始日志](evidence/catalog-data-controls.first.log) / [首次退出码](evidence/catalog-data-controls.first.exit.json)：4 pass、10 expect，1 文件。
- [findings](evidence/catalog-findings.json)、[候选与排除](evidence/catalog-candidates.json)、[冻结源码散列](evidence/catalog-source-manifest.json)、[产物收据](evidence/catalog-artifact-receipts.json)。源码清单限实际读取的直接文件，不宣称完整传递依赖覆盖。

所有首次测试的 stdout/stderr 合并流与退出码先保存后查看。无失败 Bun shard、无重跑；本分项没有产品或 Git 写入。
