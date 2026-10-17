# Root 元数据导航备注

以下为工具第一响应的人工转录或简述，不是新的产品验证，也未为修复它们重跑产品。Bun 首跑收据另存，不与这些元数据响应混合计数。

1. `rg` 的一组源码检索误包含 `packages/core/src/llm/client.ts`，工具 exit2，提示 `No such file or directory`。随后的实际 `rg --files packages/core/src/llm` 库存确认文件是 `client-base.ts`；其源码读取是导航订正，未进行任何 import/test。
2. Node `createRequire` 锚定实际 `packages/core/package.json` 的一次组合 `resolve("openai")`、`resolve("openai/error")`、`resolve("openai/package.json")` 查询，整体参数求值在最后一项失败，exit1，未输出前两项结果。错误文本：`Cannot find module '/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/node_modules/openai/package.json.js'`，code `MODULE_NOT_FOUND`，Node `v25.8.1`。这是 package export 的元数据解析响应，不是产品/SDK import 或 Bun resolver 失败，也不能据此断言依赖缺失。此方向 SKIP：0 SDK/Bun 尝试，不重跑 resolver，不读取所指 SDK 路径，不用替代 SDK 验证。独立的零 runtime-import friendly 叶子和轻量异常类没有这个依赖。
3. 合并原始日志与宽历史上下文输出总量超过工具上限，显示截断。Bun 的12个测试与完整小日志都已显示；全历史匹配数据完整保存 JSON，但未显示的历史上下文没有被当作逐条已读。后续报告区分计数与阅读。
4. 查找已知归属的 `/tmp/codeshell-audit-20261017-round21-finalize.py` 时一次 `rg --files /tmp` 还遇到其它 `tmp-mount-*` 的 Permission denied；未进入、修改或继续查询那些目录。该已知文件路径随后正常只读取得，内容仅用于当前文档集成模板。此处不是产品或测试失败。
5. 初次外部搜索关键字中一条拼写为 `site.platform...`，另一条是官方域名关键字；搜索结果混入第三方页面。仅采用已直接打开的官方 `developers.openai.com/api/docs/guides/error-codes`，第三方内容不作证据。外部事实是精简人工转录，非整页存档。

没有改 fixture、重跑失败方向、修复产品、安装依赖、共享 dist 重建或恢复旧失败路线。
