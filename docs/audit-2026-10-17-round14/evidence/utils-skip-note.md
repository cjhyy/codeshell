# 首次失败与停止边界

`utils-slice-columns` 的首次执行先把 combined stdout/stderr 原样落到 `utils-slice-columns.first.raw.log`，随后保存 `utils-slice-columns.first.exit.json`，才读取日志。guarded Bun 返回 1；日志为 0 pass / 1 fail / 1 error，未完成零失败 JUnit gate。

失败是我编写的 fixture 相对 import 多写一层：fixture 位于 `docs/audit-2026-10-17-round14/evidence`，却引用 `../../../../packages/core/src/utils/sliceAnsi.ts`。Bun 在加载时找不到该路径，目标源模块未加载，任何测试体都未执行。这是审查 fixture 错误，不是产品 bug。

按用户“有问题的跳过”和根任务规则，整个 Slice 动态方向立即 SKIP。原 fixture 保持失败时字节；没有修正路径、重跑、用别的入口/运行时/自写等价算法挽救验证。所有 slice 现象只作为源码候选，不能把 fixture 内尚未执行的断言当成实际结果。

`utils-cache-format-controls.test.ts` 在 Slice 首跑前一并写入，但从未执行；事后静态看到它也使用同样的错误相对 import。保留未执行材料，不修正/运行它，也不把其中预期与断言作为实证。其 memoize/semver/toolDisplay 方向没有动态结论。

独立的仓库现有 `packages/core/src/utils/format.test.ts` 直接按真实库存路径首跑，是已读的叶级 format/intl 基线，不导入 Slice，也未验证/修复失败方向。6 pass / 6 expect / 0 fail / 0 skipped；只覆盖现有 sub-second duration 案例。
