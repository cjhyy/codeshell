# Round 15 injection：只读交叉复核

Reviewer：`config_migration_round15`。冻结基线 `ae777b3fce6fc9986e69ceb62802f3bb3f6aa478`。只读复核 `injection.md`、两个聚焦 fixtures、首次 raw/exit、capture script、validation/candidates/findings、source manifest 与 artifact receipt。零新测试、产品导入、Engine/协议/UI/网络/native 执行、产品修改或 Git 写入；只写本复核。

**无阻断意见；保留 0 formal / 2 candidate 的等级。**

- STEER-R15-C1 的实际动态证据只有真实 enqueue/remove/consume helpers。fixture 手工使用与 Engine 静态默认分支对应的 ``steer-${queue.length}``，没有导入 Engine。静态 `engine/engine.ts:1155–1177` 确实有缺省 id、queue-length fallback 和 active-run gate；协议 `server-run-controls.ts:184–189` 透传 id。报告明确没有证实普通 host 省略 id、没有执行默认分支或真实 run，不能提升为已确认的用户消息丢失。不同 host id 的单项撤回、FIFO drain、输入外层数组保持控制与日志一致。
- IMAGE-R15-C1 的实际 parser 首次日志证明逆序但数量相同的手工标签没有抛错，以及正常 block 后相同逆序尾巴留下文本。源码 `parse-task.ts:142–175` 的数量检查与非重叠 regex 支持此观察；`attachments.ts:250–255` 正常 encoder 静态生成完整 blocks，不证明能产生该逆序输入。报告保留 malformed wire / 无普通生产者的限制，不声称真实 PNG、decode、provider 或用户图片丢失，等级恰当。
- 缓存 identity 与 relocated user-context 保留策略由当前既有测试明确约定；报告没有将 equal-content 用户消息、消息重排、重复注入对象或 shallow attachment metadata 另造新 bug。literal image opener 的拒绝也被既有 parser 测试锁定；旧 WEB-R14-C1 是另一套展示标签和已跳过方向，本轮没有复原该 Web 路线。
- 两份首次权威 raw 与 exit 为 **15 pass / 39 expect** 和 **20 pass / 58 expect**，均 `Completed Bun shard`、exit 0、0 failure / skip；合计 **35 pass / 97 expect = 24 existing + 11 focused**。capture script 拒绝覆盖首次证据，raw 和 exit 在打印前落盘；没有 failed Bun shard 或 rerun 的证据。测试通过不表示候选修复、完整生命周期、静态 typecheck 或全仓通过。
- 元数据核验通过：artifact receipt 中 **17 个 artifacts** 的 bytes/SHA-256 全相等；source manifest 中 **14 个源码/测试文件** 的冻结 Git blob SHA-256 与当前字节相等；本次扫描报告 **29 个本地链接**（包括指向 artifact receipt 本身的链接）均存在，带 `#L` 的行号不超过实际文件行数。receipt 的 `verifiedLocalLinks:28` 是其已有记录；本复核独立确认当前全部 29 条，无失效链接。没有重跑产品。

本复核按报告和相关静态片段判断去重/范围说明合理，没有再次进行全历史语义穷尽审查。源文件整文件哈希只固定快照，不代表本复核阅读整份 Engine、Desktop attachment 或协议模块。

## 复核自身的一次 raw 路径定位错误

首次合并 `cat` 已成功阅读报告、validation/candidates/findings 与两份 exit，但在尚未读取返回值前误猜 raw 文件名为 `*.first.log`。工具首次返回以下诊断，exit 1：

```text
cat: docs/audit-2026-10-17-round15/evidence/injection-cache-queue.first.log: No such file or directory
cat: docs/audit-2026-10-17-round15/evidence/injection-image-grammar.first.log: No such file or directory
```

这是复核元数据定位错误，不是 Bun、产品导入或断言失败。不存在的猜测引用已跳过；之后仅按已成功读取的权威 exit 的 `rawLog` 字段读取现存 `*.first.raw.log`，没有改 fixture、改产品、运行任何测试或重新生成 raw。此处明确区分 metadata 修正与产品验证重试。
