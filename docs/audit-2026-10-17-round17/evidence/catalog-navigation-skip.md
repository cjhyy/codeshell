# Catalog navigation metadata skip

这是首次工具响应的明确转录，未改写产品运行结果。

读取已库存的 `agent-task-host.ts`、Desktop `index.ts` 和 bridge 局部后，同一只读 shell 请求的末条命令曾包含猜测 glob：

```text
rg -n 'agent.task.models|agentTasks.models|agentTaskModels|defaultModel' packages/core/src/browser/panel-app* packages/server/src/panels --glob '*.ts'
```

zsh 在执行该 rg 之前返回：

```text
zsh:4: no matches found: packages/core/src/browser/panel-app*
```

`exec_command` 首次 exit code 为 `1`。前面的三个 `sed` 静态输出已返回；末条 rg 没有执行。该猜测 glob 立即跳过，不据此断言 Core 没有 Panel 实现，也不计为 failed Bun shard、resolver failure 或 test-body execution。

后续独立的 `rg --files packages/core/src` 库存返回实际 `packages/core/src/panel-apps/*`。本方向没有导入或运行这些模块；消费者只使用已真实库存的 server/Desktop 文件和 Core model/settings 文件作静态阅读。没有修复/重跑该猜测 glob，也没有替代动态验证。

## Receipt 组装顺序诊断

首次本地链接元数据检查在生成 artifact receipt 之前检查了报告中对该 receipt 的前向链接。Python 返回如下原始诊断；随后同一 shell 中独立的 mappers 库存命令成功，所以外层 shell exit 为 `0`，不是 Python 检查成功。

```text
Traceback (most recent call last):
  File "<stdin>", line 9, in <module>
AssertionError: evidence/catalog-artifact-receipt.json
```

这只说明尚未生成的 receipt 被提前检查，不涉及任何产品模块、fixture 或 Bun 执行。之后先生成 receipt，再完成纯文件链接/哈希检查；没有修改测试和 raw/exit，也没有产品重跑。
