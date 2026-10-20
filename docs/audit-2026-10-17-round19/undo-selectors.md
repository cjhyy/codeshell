# 第十九批：撤销目标纯选择器补查

冻结源码：`5f5cf69df8526470700712a4dc2d5ae6bd2da132`。本分区 **0 项确认、0 项候选、0 项 related**。旧架构资料已经描述这些函数，本批补实际小对象对照，不称为此前未读模块。

动态只调用 `packages/core/src/session/undo-target.ts` 四个纯选择器。它对 `file-history.ts` 的 import 为 type-only，没有加载 FileHistory 或读写任何文件。fixture 的 `owned:` backup 字段和中文/空格 filePath 仅是内存标签。唯一首次命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/session/undo-target.test.ts docs/audit-2026-10-17-round19/evidence/root-undo.test.ts
```

[combined raw](evidence/root-undo.first.raw.log) 与 [exit](evidence/root-undo.first.exit.json) 先保存再检查：**29 pass / 49 expect / 0 fail / 0 skip，Completed、exit 0**。25 个既有测试加 4 个 focused；补查 frozen owned 对象不变性、clock reversal 时 turn 优先、三个 pending redo 的最低 turn 与新 live turn 对照、中文/空格路径标签以及 epoch 前有限 timestamp。最后一项仅验证公开 legacy selector 的数值合同，不声称它由当前 TUI 普通调用。没有随机/压力输入或整套文件系统集成。

`file-history.ts:138–185` 的 snapshot producer、`:306–315` 的 plan getter、`:850–889` 的当前 plan 选择只静态核对；TUI `utility-commands.ts:43–160` 当前使用 whole-session selector 和 `getLatestTurnUndoPlan`。因此当前 TUI 最近一轮行为不能由本批 `latestTurnUndoTargets` 测试替代证明。`latestUndoTarget` 未找到当前 TUI/Desktop 生产调用，不把它对 undone 的处理提升为用户缺陷。旧 created-only undo 记录已经存在；当前 plan 源码读取只是排重背景，没有重测旧缺陷或登记修复。

[历史查重](evidence/root-dedup.json) 扫描 prior docs/bugs（含 archives）**1,161 MD + 889 parsed JSON = 2,050 文件、260,970 字符串叶子、363,859 全 scalar 叶子、0 parse errors**。61/55/15/5 次四类匹配与每类 120 段上下文上限分开，关键词不是语义穷尽。先前 round4 的 earlyInput escape 线索与 round9 usage 方向排除：当前启动调用查询仍未找到 early capture 调用，未执行 stdin/TTY。其他相邻 usage、continuation、cwd、semver、output coverage 仅静态读取选段或叶文件；不因这些阅读恢复旧依赖或 authority/custody 动态方向，也不计新增覆盖成功。

[preflight](evidence/root-undo-preflight.json) 核对实际库存路径及 frozen Git bytes，没有 resolver 或 node_modules 位置假设。[source manifest](evidence/root-source-manifest.json) 列出阅读范围，整文件 SHA 不代表全文件所有分支审查。[导航 skip](evidence/root-navigation-skip.md) 保留一次猜错旧文档名的首次响应；没有 Bun/产品失败、重跑或替代验证。

本批未执行 FileHistory、真实 undo/redo、磁盘恢复、当前 plan、TUI renderer、Engine、native/Git 产品命令、真实模型/账户/网络/用户资料、PTY、权限/auth/security/custody/watchdog 实验；没有 build、共享 deps/dist 重建、full suite/typecheck/lint/E2E 主张。
