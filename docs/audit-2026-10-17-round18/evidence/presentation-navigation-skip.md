# 静态导航失败（非产品测试）

首次工具调用中的实际命令含：

```text
rg -n 'coverage:|callType:|beginAttempt|beginRequest' packages/core/src/model-traces packages/core/src/models packages/core/src/engine/model-trace-scope.ts packages/host/src --glob '*.ts' | head -180
```

首工具响应逐字转录的诊断为：

```text
rg: packages/core/src/models: No such file or directory (os error 2)
```

该调用 shell 管道返回 0（末端 head），不是所有 rg 路径读取成功。未执行产品代码；不存在的猜测目录已跳过，不为它生成源码 SHA。真实 model-traces/types.ts、classification.ts、context.ts 经先前 `rg --files` 库存定位后分别只读检查。这些静态读取不恢复旧 Core model-trace backend / i18n 动态方向。以上是首工具响应转录，不伪称运行前保存的原始日志。

## 第二次只读历史导航失败

去重 JSON 已列出实际历史文件 `docs/audit-2026-10-17-round14/traces.md`，后续一次人工命令仍误写旧文件名：

```text
rg -n 'model trace|执行观测|Provider|逻辑快照|输入边界|Prompt' docs/audit-2026-10-17-round14/root-trace.md docs/audit-2026-10-17-round14/README.md
```

首工具响应（exit 2）转录：

```text
rg: docs/audit-2026-10-17-round14/root-trace.md: No such file or directory (os error 2)
```

跳过不存在的 `root-trace.md`，不为其生成源码 SHA。后续仅根据已经存在的全量历史去重库存阅读 `traces.md`；无产品执行、测试重跑或旧失败方向恢复。
