# 复现证据

这些脚本包含缺陷表征和用于排除误报的常规契约验证；其中缺陷表征测试通过代表复现成立。修复产品后，部分断言应当失败；它们不是永久的产品回归断言，也不属于默认 `tests packages` 测试集合。

在仓库根目录安装冻结依赖并完成构建后运行：

```sh
node docs/review-2026-10-12/run-reproductions.mjs
```

入口逐文件调用项目 guarded runner，隔离 HOME、应用状态和提供方凭据，并检查完整 JUnit 结果。单个文件也可传给 `node scripts/run-bun-test-shard.mjs --timeout 30000`。网络 fixture 只使用受限本地模拟源，不调用真实模型。不要改成直接运行 `bun test`。

导入路径已改为相对仓库路径。原始专项分析中的 `/tmp/...` 是审查时的原始证据路径；本目录保存了相应脚本和最终日志的副本。

`root/active-snapshot-journal.json` 是真实 native Hub/worker 使用本地模拟模型产生的首次运行响应，工作目录是已清理的临时 fixture。对应测试同时覆盖生产客户端恢复函数和服务端 baseline 裁剪。
