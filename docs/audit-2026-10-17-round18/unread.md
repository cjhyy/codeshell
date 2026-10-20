# 第十八批：普通会话未读集合

冻结源码 `65691923fa629970ac26dc04e35362a9c4ab57a8`。本方向 **0 项确认缺陷、1 项候选、0 项新增关联计数**。实际执行的范围是 `remoteAppSync.ts` 三个无依赖叶子函数，输入为自有 Set、普通会话 ID、数组与 generator。现有 `remoteAppSync.test.ts` 混合审批、replay 和 seq 测试，本轮只静态查看其未读段，没有运行该文件，也没有恢复其他已跳过方向。

## UNREAD-R18-C1 — 列表刷新可能清掉浏览器未查看的后台会话标记（候选）

- **位置**：`packages/web/src/hooks/useRemoteApp.ts:685–709`。`session.list.ok` 先对列表中的 ID 做 prune，再无条件 `clearUnreadSession(pruned, event.activeSessionId)`（692）；随后才按 conversation revision 与当前 binding 检查是否接受该 active ID 作为本浏览器导航（696–709）。该检查旁的注释明确提到列表可能反映另一标签页的 device selection，当前浏览器已选择的 conversation 应由显式确认/选择拥有导航。
- **普通触发假设**：浏览器已选 A、revision 为 1；合法后台 B 的 stream 标记 B 未读（`packages/web/src/hooks/useRemoteApp.ts:813–819`）；一次列表响应仍列出 A、B，但 active ID 是 B。导航条件为 false，浏览器保留 A，未读集合却先清掉 B。普通刷新入口为 `packages/web/src/hooks/useRemoteApp.ts:1501–1504`。列表 producer `packages/desktop/src/main/mobile-remote/handle-client-event.ts:513–534` 静态取 `st.selectedSessionId ?? runContext.sessionId`，不是 Web 当前 binding。本轮没有执行 producer，也没有构造真实设备、标签页、socket 或响应时序。
- **已观察证据**：[自有 fixture](evidence/unread-pure.test.ts) 最后一项只手工镜像上述纯 helper 组合与导航谓词：B 从未读集合消失，同时 navigationAllowed 为 false；原集合保持 B。它调用的确实是实际三个叶子函数。**这不是实际 hook 或跨标签页复现**；不能用这项结果证明完整正常生产时序一定到达该状态，因此保留候选。
- **对照**：已有标记、当前会话、空 ID 不产生新集合；新增后台 ID、删除确有标记的 ID 会 clone；所有操作不改变旧 Set；已知库存无变化时保留引用；数组、Set 与只消费一次的 generator 等价；对不存在的当前 A 做 clear 保留 B。用户显式选择时按所选 ID 清除的实际接线只静态核对了 `packages/web/src/hooks/useRemoteApp.ts:1506–1535`。
- **影响边界**：候选仅涉及当前页面的会话未读提示消失。不声称消息/历史丢失、错误导航、草稿移动、数据错发或持续不可恢复；后续 stream 是否重新标记取决于完整调用链，未运行。
- **去重**：完整旧资料未命中这三个 helper 名称。旧 R61 是 Desktop shared SessionCatalog 的跨窗口导航投影，旧 W11 是新建确认前后台 stream 自动绑定/草稿迁移；二者已读作排重对照，均没有复跑。本候选是已存在导航 guard 前的未读清除接线，不将上述旧条目再次计为新增，也不将旧记录当成本候选的动态证据。

## 首次验证与覆盖边界

仅执行一次：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round18/evidence/unread-pure.test.ts
```

**1 个 clean shard，9 pass、35 expect、0 fail、0 skipped，guard Completed**；9 项均为本轮自有 focused 测试，8 项直接叶子行为对照，1 项为明确标注的调用组合镜像。首次 combined stdout/stderr 先原样写入[日志](evidence/unread-pure.first.raw.log)，再写入[退出回执](evidence/unread-pure.first.exit.json)，之后才查看结果。0 重跑、0 failed Bun shard、0 元数据失败。

[预检](evidence/unread-preflight.json)只检查真实叶子源码/Git 冻结字节及绝对 import 目标，确认文件无 runtime import；没有猜测 node_modules 路径或 resolver。Bun 实际导入零依赖叶子文件，会初始化其纯声明/函数定义；没有调用其中 replay、epoch、approval、room seq 或 noteSessionSeq 导出。React、useRemoteApp、socket、history、UI、真实网络/模型/native、用户数据和权限流程均未执行；没有 broad build/typecheck/lint/full-suite 结论。

## 历史检索与源码固定

[去重脚本](evidence/unread-dedup.py)扫描所有旧 `docs`/`bugs` MD 与递归解析 JSON value leaves，含 archive/_archive，排除本批。共 **1995 文件 = 1148 MD + 847 JSON**，**253680 string leaves / 353952 scalar leaves**，0 解析错误；JSON keys 不计 string leaves。helper_names 0、unread_state 35、list_active_clear 4、selection_revision 3。每模式最多保存 40 个上下文；这些匹配计数是关键词检索结果，不是全仓语义无遗漏证明。详见[完整结果](evidence/unread-dedup.json)。一次补充 `rg` 输出受显示预算截断，完整去重结论取结构化结果与随后指定旧文档段落，不把截断输出当完整语料。

[源码清单](evidence/unread-source-manifest.json)逐文件固定冻结 Git blob SHA-256 与当前字节相等情况，同时标注实际执行、静态局部查看或指令用途。固定整文件哈希不代表整文件/传递依赖均已审查。[验证汇总](evidence/unread-validation.json)、[空确认列表](evidence/unread-findings.json)、[候选](evidence/unread-candidates.json)、[空关联列表](evidence/unread-related.json)及[工件回执](evidence/unread-artifact-receipt.json)可独立核对。只写本报告与 `unread-*` 证据；产品文件、依赖、dist 和 Git 均未修改。
