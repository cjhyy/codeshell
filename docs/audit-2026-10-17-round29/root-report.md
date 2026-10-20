# Round29 输出恢复与流信封静态审查

冻结父提交 `b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`；本方向 **0 正式问题、0 候选、0 新关联**。只记录源码反证和覆盖边界，没有修改产品。

[outputCoverage.ts](../../packages/web/src/lib/outputCoverage.ts) 168行与 [mobileOutputRecovery.ts](../../packages/web/src/lib/mobileOutputRecovery.ts) 161行完整阅读。coverage 的有界输入集合溢出会保留 incomplete 屏障，copy 独立复制集合；带游标事件不会自行消除历史屏障。这里遇到的身份、epoch和journal字段仅静态核对，不做权限、身份、认证或持久化实验，也不声称已经验证整个协议。

恢复代码 [93–161](../../packages/web/src/lib/mobileOutputRecovery.ts:93) 先构建私有聊天候选，分页有取消和总页数上限，历史投影不直接证明活跃状态。最终快照和输入锚点核对后才返回候选；持续追赶会保留候选与预算并抛出专用 continuation。实际 [mobileOutputClient recover选段](../../packages/web/src/hooks/mobileOutputClient.ts:155) 150–270行对 pending input、awaiting journal、catchup pending 分别处理，并在当前选择及锚点检查后才 commit。此选段没有建立“半份结果先发布”的普通反例；未通读 client 其余方法，未调用回调、计时器、reducer 或任何产品函数。

[stream-envelope.ts](../../packages/desktop/src/shared/stream-envelope.ts) 22行及 [parseStreamLine.ts](../../packages/desktop/src/main/parseStreamLine.ts) 63行完整阅读：非对象或缺失type被拒绝；legacy可保留payload而不捏造seq；snapshot要求sessionId并只保留有稳定id的steer，live可附加Main的seq/epoch。两个实际 [preload入口](../../packages/desktop/src/preload/index.ts:260) 在235–310行均使用同一normalize入口。没有把可选seq/epoch当作新bug，归档此前已有live seq与steer replay讨论，当前尚无新的普通路径反例。

[envelope测试](../../packages/desktop/src/shared/stream-envelope.test.ts) 49行和 [parse测试](../../packages/desktop/src/main/parseStreamLine.test.ts) 152行仅阅读，共17个现有声明，**0执行、0pass、0expect**。无产品导入、fixture、解析器运行、UI/native/模型/真实任务操作。失败方向保持跳过，不借另一入口恢复旧失败测试。

[源码清单](evidence/root-source-manifest.json) 9pins：普通产品/测试/消费者812声明读行，instruction217行；full与selected分列。envelope与parseStreamLine及preload的首次耐久hash晚于对应读取，initial保持null；另5个产品/测试入口先pin后读。whole-file SHA不代表大文件通读。

[历史元数据](evidence/root-dedup.json) 共2765文件（1275MD+1490JSON）、562917字符串/833428标量、169 exact archive/_archive路径、0解析错误，排除当前29。exact/recovery/envelope命中267/381/53，分别保留100/100/53上下文；关键词不是历史语义穷尽，也不声称首次审查。[历史判断](evidence/root-history-decisions.json) 保留旧因果边界。

[metadata notes](evidence/root-metadata-notes.json) 记录Root误将导航扩展到整个/tmp和一次猜错旧脚本路径；未将其当产品失败或覆盖证据。没有打开无关内容，没有任何产品重跑。[validation](evidence/root-validation.json) 与 [作者材料收据](evidence/root-artifact-receipt.json) 可复核。本轮negative仅表示所列范围未确认新问题，不代表全仓无bug。
