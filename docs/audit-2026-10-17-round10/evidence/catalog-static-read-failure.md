# 首次静态读取失败转录

以下为工具返回的原文转录，非 Bun 测试原始日志。首次命令使用错误的 `packages/core/src/engine.ts` 路径，`rg` exit 2，`&&` 后两个 sed 未执行。保留此材料后跳过 cache refresh 调用链方向；没有改路径、重跑或用另一方法恢复验证。

```text
rg: packages/core/src/engine.ts: No such file or directory (os error 2)
packages/core/src/llm/model-pool.ts:145:  reloadCachedContextWindows(): void {
```

工具 exit_code: 2。此失败不计为产品 bug，不计为 Bun shard。
