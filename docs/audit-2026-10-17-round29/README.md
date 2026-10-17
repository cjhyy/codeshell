# 第29批：队列、回放与消息状态静态审查

本批 **0新增正式问题、0候选、0新关联**；未修改产品。冻结提交 `b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`，整合前main `b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`。审查仍在继续，不代表全仓完成或没有其他bug。

- [Core队列与Web回放](runtime-report.md)：取消、晚到结果与历史liveness合同。
- [房间历史与消息映射](room-report.md)：分页完整性和普通工具事件DTO。
- [Stop目标选择](stop-report.md)：override/active/running优先级及真实入口。
- [输出恢复与流信封](root-report.md)：私有候选提交、输入锚点及legacy事件。

全部为静态阅读，**0产品/测试执行、0pass、0expect**，旧失败方向继续跳过。源码范围、首次hash时序和限制分别保留；原prep阅读没有重复计数。全历史去重含归档MD及递归JSON值，共2765文件，关键词上下文不是语义穷尽。

[分类](findings.json)、[候选](candidates.json)、[旧关联分类](related.json)、[验证](validation.json)、[源码绑定](source-manifest.json)、[覆盖口径](coverage.json)、[材料索引](evidence-index.json) 可复核。独立复核见 [Root/runtime](evidence/review-root-runtime.md)、[room/stop](evidence/review-room-stop.md) 和 [Root材料检查](evidence/root-qc.md)。
