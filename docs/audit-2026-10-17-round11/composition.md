# 组合配置与冻结数据审查

冻结源：`b8b776d56e5982e59b18de0262d5c49367746625`。本方向 **0 项新确认、0 候选**。2 个首次 guarded shards 共 **9 pass、444 expect、0 fail、0 skipped**，其中 6 项既有 baseline、3 项新增普通控制。未修改产品。

## 实际验证

[新增 fixture](evidence/root-composition-controls.test.ts) 直接运行真实 compiler、freeze、preset resolver、prompt projection 与 snapshot，所有输入声明均在内存中；dummy 工具和 query callable 的执行计数保持 0。

- 普通嵌套工具描述和 schema 字段编译后与作者输入分离，作者后续修改不改变编译值；返回的声明被冻结，作者的模块/对象没有被顺带冻结。
- 模块自带普通 preset 可成为默认值，明确选择已存在 preset 正常，未知名称被拒；修改返回的 prompt-section record 不影响编译声明或下次投影。
- 有序模块/query/prompt 元数据保留 owner 与输入顺序；snapshot 按设计不包含 callable 实现或 prompt 正文。

[首次 raw log](evidence/root-composition-controls.first.log)为 3 pass / 18 expect，退出 0/Completed。既有 `snapshot.test.ts`、`core-module.test.ts` 验证默认声明投影、相同输入 snapshot/digest 一致、模块顺序影响 digest、结果 frozen、snapshot 没有函数；[首次日志](evidence/root-composition-existing.first.log)为 6 pass / 426 expect。raw combined stdout/stderr 与退出收据先保存后检查，没有失败或重跑。

## 静态范围与未升级观察

阅读 compiler 的 module/order、普通 keyed contributions、preset shadow/default/reference、hook metadata、protocol metadata 和诊断投影；冻结拷贝、runtime preset/section helpers 与 snapshot 实现也已阅读。activation/lifetime 与现有测试只读，没有运行实际资源激活或 authority/permission/custody 实验。Engine 相关接线只查源码位置，没有运行 Engine、Host、provider 或真实工具。

Snapshot 是显式 topology projection；prompt/schema 正文和 handler 实现被有意排除。不同正文对应相同 topology digest 不构成本批新缺陷。对于 null-prototype dictionary、复杂 Map key 等非普通声明形态，没有建立当前正常 module producer 与更强接受/拷贝契约；只记源码观察，不制造 fixture 或登记 bug。类型/导出路径的猜测失败也不能用来推导外部 SDK 承诺。

两次静态导航中包含不存在的猜测文件，已保留[准确工具响应转录](evidence/root-navigation-skip.md)并跳过相应 export/preset type-file 方向。第一条含管道的工具整体 exit 0，单个 rg 路径仍失败；第二条最终 sed exit 1。没有换文件名恢复这些方向，不把它们当产品或 Bun 失败。

[历史查重](evidence/root-dedup.json)覆盖所有历史 `docs/`、`bugs/` Markdown 和 parsed JSON，含 archive/_archive，排除 round11。既有 instruction-order、composition/lifetime 和 authority 记录不重复，查重不等于全历史语义穷尽。

[验证收据](evidence/root-validation.json)、[18 份冻结源码](evidence/root-source-manifest.json)、[正式项](evidence/root-findings.json)与[候选](evidence/root-candidates.json)保留具体范围。默认 compiler 会导入内置声明，测试没有执行其工具/服务；选定源码 SHA 不是完整传递依赖保证。没有共享 dist/依赖重建、全仓 build/typecheck/lint/test 或真实平台验收声明。
