# 会话标题读写与列表更新静态审查

结论：正式问题 **0**、候选 **0**、关联 **0**。本次检查普通 rename、空字符串清除 override、列表优先级与并发保存的源合同，未确认新的正常反例。产品、helper、测试、真实文件/会话、网络、模型及 Git 执行均为 **0**；没有修改产品。

存储层 [source ranges](source-manifest.json) 显示每实例队列把后续写入接在前次结算之后，并把拒绝隔离给该调用；`listTitles` 等待本实例队列后重新加载。写入同步临界段内先读最新 map，再检查可选 `expectedTitle`，非空赋值、空值删除 override，`finally` 释放锁。这里仅核调用顺序/值规则，未验证底层锁、原子文件系统操作、跨进程并发或权限有效性。

Hub 的普通 PATCH 传入比较基线，冲突映射为409；list/GET 用 customTitle > durable title > preview > 默认值。Web 编辑器从 customTitle 捕获基线，409保留草稿，只有显式读取才更新基线，成功写入触发 reload。Desktop 的历史页等待 rename IPC 写入成功后回填页面和 rename callback；空 override 立即回退 durable title。两入口合同不同，未凭 Desktop 不暴露可选 CAS 就推断缺陷。`useSessionHistorySync` 的回调实现选读，App hookup 未在本次重读；session 实体删除/归属与 archive 机制也不由 title-clear 规则认证。

旧证据见 [R48 canonical](prior-canonical.json)、[旧有限报告](prior-report-metadata.json) 和 [R22 原对象/窗口](prior-r22-metadata.json)：same-SHA 既有 selected/手动标题保护/双来源观察保留，不能称首次或全局新覆盖；R48 prep65 与本次为同一作者。共享 [history projection](history-projection.json) 只提供路径/SHA导航：5676 MD/JSON、含冻56排57+、recursive values及archives，423命中仅前100，0parse错误（批次由 Root 归档）。该批投影晚于首次叶子正文，不倒填前置时点；没有从无命中推断新颖，也未再次全史扫描。

范围：8产品 selected 行合计 **443**，测试声明 selected **42**（不执行），总 **485**；去重 display **950**。store物理189行显示不等于语义全文；selected/body/nav/hash、边界和旧重叠逐项列于 manifest。未发现需晋升的普通反例；这不是整个 title/会话/生命周期系统正确性证明。见 [分类](classification.json)、[首次诊断与限制](diagnostics.json)、[ending](ending.json)；11源码/指令 pin与4个可比元数据输入 SHA 均保持，R22 MD为如实 late hash，不称初末一致。 [自排除交付收据](artifact-receipt.json) 记录冻结集合。
