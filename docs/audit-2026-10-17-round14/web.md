# 第十四批：Web 普通消息展示与 frozen room history

冻结基线：`badc2262a90966f6f903977b849adf1f22b55e9f`。本分区 **0 项正式 bug，1 项静态候选**。普通消息展示的首次聚焦 fixture 在加载阶段失败，已保留并跳过整个方向；未修支架、未重跑、未通过抽取函数或既有展示测试恢复验证。

## WEB-R14-C1：普通用户 XML 可能被误当成内部附件提示

状态：**静态候选，验证 SKIP，无严重级别**。位置：[userMessageDisplay.ts:85](../../packages/web/src/lib/userMessageDisplay.ts:85)、[userMessageDisplay.ts:97](../../packages/web/src/lib/userMessageDisplay.ts:97)。普通用户仅请求解释如下 XML，且没有真实附件或 `displayText`：

```xml
<attached-directory path="src">请逐字解释这个 XML 示例</attached-directory>
```

或者用户把 `<attached-image-paths>` 作为待解释格式、正文里只有示例路径。源码中的目录分支直接删除整个匹配块并添加目录 summary；图片路径分支不要求任何 image block，后续取 `Math.max(imageBlocks.length, imagePaths.length)`，因此源码推导出路径 summary。上述都是**静态推导**，不是本轮已观测输出；[准备的 fixture](evidence/web-user-display.test.ts) 中的预期字符串和 `console.log` 没有执行。

契约与正常生产链均只读核对。既有 [transcriptReplay.test.ts:104](../../packages/web/src/lib/transcriptReplay.test.ts:104) 明确要求保留 ordinary user-written XML，其 117–121 行只覆盖普通 `<attached-file>`；file 分支会验证 `absolutePath` 和 `origin`，目录与图片路径分支没有相同识别条件。正常用户内容由 [run-session-open.ts:178](../../packages/core/src/engine/run-session-open.ts:178) 写入 Transcript，`displayText` 可缺省；[run-output-user-message.ts:42](../../packages/core/src/engine/run-output-user-message.ts:42) 遇到 `<attached-` 会保留 content 交给共享投影。durable replay 在 [transcriptReplay.ts:132](../../packages/web/src/lib/transcriptReplay.ts:132) 调用该函数，canonical event 经 [streamReducer.ts:176](../../packages/web/src/lib/streamReducer.ts:176) 走相同投影。手机行组件只读消费 `item.text` 和附件名称：[MessageStream.tsx:92](../../packages/desktop/src/mobile/components/MessageStream.tsx:92)。本轮没有执行这些生产链。

真实 engine 目录格式还带 `entries`、`truncated` 并由 input-attachments.ts 生成；图片路径提示由 run-image-input.ts 与真实 image content blocks 配套生成。`data.displayText` 字符串会覆盖最终正文，因此有明确 clean displayText 的生产者不能被概括为正文必丢。候选只关乎展示字符串与摘要，不声称 transcript 原件、输入、图片文件或模型收到的内容丢失，不涉及授权或文件访问。

去重：[全历史匹配收据](evidence/web-dedup.json) 覆盖本轮以外 docs/bugs 全部 1768 个 Markdown/JSON 文件，1088 个 MD、680 个递归解析 JSON，185197 个 JSON 字符串叶子，0 解析错误。旧 [R84](../review-2026-10-12/legacy-history-round24.md) 是 legacy history **缺少**投影导致内部路径提示外露；此处是正常正文**被**现有投影误识别，触发条件与根因不同。旧报告和质量稿同时提醒保留用户 XML，没有将本候选登记为已复现 bug。本轮不重新登记历史图片展示、POSIX cwd 大小写或 `/` 根项目匹配问题。

## 首次执行与失败保留

| 首次执行 | 实际结果 | 原始证据 |
| --- | --- | --- |
| `packages/web/src/lib/roomHistory.test.ts` | 8 pass / 9 expect / 0 fail / 0 skip；guard Completed；exit 0 | [combined raw log](evidence/web-room-history.first.raw.log)、[exit receipt](evidence/web-room-history.first.exit.json) |
| `evidence/web-user-display.test.ts` | 0 pass / 1 fail / 1 error；未 Completed；exit 1；Bun 未打印 expect 总数 | [combined raw log](evidence/web-user-display.first.raw.log)、[exit receipt](evidence/web-user-display.first.exit.json) |

两组均仅通过 `node scripts/run-bun-test-shard.mjs --timeout 30000` 执行。[首次捕获器](evidence/web-run-first.py) 先把 combined stdout/stderr 与退出收据写入文件，再输出 receipt 路径供检查，并拒绝覆盖已存在的首次证据。没有测试重跑。

聚焦失败原因：自有 fixture 的相对 import 写为 `../../../../packages/...`，多向上一级，Bun 无法加载 userMessageDisplay.ts。它尚未执行任何测试体或产品断言，是**支架定位错误**，不是 Bun、依赖或产品错误。原 fixture 保留原样，整个 user-display 聚焦方向 SKIP，候选不能升级；准备源码中的其他控制、replay/reducer 验证和观察日志均未执行。roomHistory 是独立既有基线，成功统计只计 8 tests / 9 expect；失败加载显示的 “Ran 1 test” 单独归档，不能算成功覆盖。

## 覆盖与限制

只读 format.ts / format.test.ts 的路径归属、排序和时间展示；避免恢复旧 i18n 失败方向，本轮未执行 format 或翻译测试。既有 `/` 根路径、大小写问题已有历史记录，当前源码具备相关边界处理，不做重复复现或宣称本轮修复。roomHistory 只运行上述已有基线，检查 frozen 边界、连续序号、重复、翻页循环与空中间页；没有新 formal，也不把任意错误后重用 accumulator 或接近 MAX_SAFE_INTEGER 的伪造序号升级为普通场景 bug。

没有真实 localStorage、浏览器、DOM、手机 UI、Electron、HTTP/WS、Engine、provider、账户、外部消息或产品文件写入。没有产品修复、完整 suite、build、typecheck、lint 或 E2E 通过的主张。全部动态通过数仅来自 roomHistory 既有基线；其他生产者/消费者和契约均为静态证据。
