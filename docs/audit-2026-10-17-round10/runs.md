# Run 存储、查询与检查点数据审查

冻结源码：`6966dc0f98d21dbc2ecced6cdd6467d17b81bc39`。本方向 **0 项新确认、1 个启发式语义候选**。2 个独立首次 guarded shards 共 **13 pass、35 expect、0 fail、0 skipped**，其中 4 项 focused observations/controls、9 项既有 baseline。未修改产品代码。

## RUN-R10-C1：否定测试状态被关键词检查点标为 tests_passing（候选）

`packages/core/src/run/CheckpointWriter.ts:42` 的正则在同一句中找到 `tests` 和 `pass` 就写入 `tests_passing`，没有区分中间的否定词。[实际 fixture](evidence/root-run-data.test.ts) 将合法 `assistant_message` 的文本设为 `The tests did not pass. More work is required.`；真实 writer 通过 fake RunStore seam 写出 `phase: tests_passing`。相同组件对正向 `The tests pass.` 也写出该阶段。原始否定文字仍完整保留在 checkpoint.summary 中，没有证据表明 run 状态或 evaluator 被改变。

本项**保留为语义候选，不计正式 bug**。本模块 `:32–35` 和历史架构说明明确阶段识别是 keyword-based heuristic；本轮没有找到承诺普遍理解否定语言、准确判定测试成功或由该 phase 驱动成功状态的更强契约。生产 RunManager 在 `:610–611` 将事件喂给 writer 是静态接线证据；并未执行 RunManager、Engine、evaluator、实际工具或 UI。建议在另行确定所需准确度之后评估否定文本处理，不据此宣布任务误报成功。

[首次原始日志](evidence/root-run-data.first.log) 为 4 pass、15 expect、0 fail、0 skipped；[首次退出收据](evidence/root-run-data.first.exit.json)为 0/Completed。测试断言当前输出和正常对照，pass 不代表语义候选已修复。

## 已验证与静态核对范围

- 普通 FileRunStore status 数组/单值、tag、offset/limit 的过滤分页组合；读取结果的本地修改不影响磁盘再次读取；正常 append/listEvents 保持顺序。使用自有临时目录，没有用户数据、损坏路径、权限或锁实验。
- CheckpointWriter 正向阶段识别、同一阶段去重、结构化 text blocks 拼接、最终 turn boundary 的 session pointer、touchedTools 和 periodic summary。输入事件符合公共 StreamEvent 结构；periodic 用例只证明 writer 对所列最终边界的投影，不声称生产每一个模型请求都会发 turn_complete。
- 既有 `FileRunStore.list-pagination.test.ts` 和 `RunQueue.test.ts`：9 pass、20 expect，覆盖普通分页、FIFO、dedup、pending cancel，以及纯 fake executor 同步抛错后释放队列容量。[首次日志](evidence/root-run-existing-baseline.first.log)和[退出收据](evidence/root-run-existing-baseline.first.exit.json)已保存。没有运行 append-lock failure/recovery、IDs、审批、RunLock、Heartbeat、RunManager recovery 或真实执行后端测试。
- 完整读取 RunStore、FileRunStore、RunQueue、CheckpointWriter 和 run/types；RunManager、公共导出、StreamEvent、TUI runs 与 Desktop run-history/runs-service 仅选读相关片段或现有测试。源码清单不代表每份文件已全读或执行。
- `getLatestCheckpoint` 在 createdAt 相等时没有额外 tie-order，但未找到必须返回某个相等时间项的明确契约。Desktop history 用当前 session state 投影 model/provider，也缺本轮可验证的每次执行身份 producer/consumer 语义；都只保留源码观察，不加 fixture、不计候选或正式项。

一次未库存的 renderer glob 导航失败，已保留[首个工具响应转录](evidence/root-static-navigation-skip.md)并跳过猜测方向。没有调整文件名或使用替代 renderer/UI 验证来恢复它；不把这个静态错误当作产品或 Bun 失败。

[历史查重](evidence/root-dedup.json)遍历全部历史 `docs/`、`bugs/` 的 Markdown 和 parsed JSON，含 archive/_archive，排除 round10。五月 append-lock poisoning、queue 查重性能、CheckpointWriter summary truncation、旧 recovery pagination/session-link，以及前批运营生命周期材料均排除，没有重复计数或恢复旧失败路线。负向文本语义未找到相同根因正式记录，但 keyword-only 识别本身已有设计说明。

[预检](evidence/root-preflight.json)单独记录实际解析的已安装 nanoid 文件及 SHA，未安装、构建或改写依赖。fixture 直接导入冻结源码，不导入共享 Core dist。没有真实模型、provider、网络、Native/CLI/Host 或全仓 build/typecheck/lint/test 声明。[候选结构](evidence/root-candidates.json)、[验证收据](evidence/root-validation.json)、[19 份冻结源码](evidence/root-source-manifest.json)保留具体证据边界。
