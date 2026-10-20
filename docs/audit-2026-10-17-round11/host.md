# Host 普通目录与同步生命周期复审

冻结源码：`b8b776d56e5982e59b18de0262d5c49367746625`。本范围 **0 项新确认问题、0 项新候选**。只写审查记录和证据，没有修改产品代码。

`packages/host/src` 只有 runtime、host-requests、公开入口和两份测试，没有 model/tool catalog 实现。阅读了全部非测试源码及 `runtime.test.ts`，并核对 Desktop、serve、Panel task 三个实际 HostRuntime 创建点；大消费者文件仅核对创建段。声明、登记原子性、运行状态门禁、反向清理、同步错误聚合未发现新的普通数据缺陷。

## 已验证行为

[定向 fixture](evidence/host-lifecycle-controls.test.ts) 直接导入冻结源码 `runtime.ts`。其两个依赖均为 type-only import，不加载 Core、Host request 模块、adapter 平台或 worker。所有 adapter/service 都是本测试内同步数组回调。

- 空服务目录：adapter start/stop 各一次，重复 start/stop 幂等。
- `capabilities()` 返回数组被调用方修改不会改登记表；运行前和停止后 `supports()` 为 false。
- adapter.start 内调用 stop：状态终结、后续服务不启动、adapter 不重复停止。
- service.start 内调用 stop：只清理已到达服务，按相反顺序停止，后续服务不启动。
- service.stop/adapter.stop 内重入 stop：每项仅停止一次。
- 多个同步 stop 抛错：逆序保留全部 service 错误和 adapter 错误，停止后不能重启。

[首次 raw combined log](evidence/host-lifecycle-controls.first.log) 为 **6 pass / 0 fail / 22 expect / 0 skipped**，guarded runner 确认 `Completed Bun shard: 6 tests, 0 skipped; 0 failures.`。先保存首次 stdout/stderr 与退出码后才阅读；没有失败后修支架、重跑或替代验证。命令及原始日志 SHA-256 见 [首次收据](evidence/host-lifecycle-controls.first.receipt.json)。这些通过用例是正常生命周期控制，不是 bug 复现，也不代表真实 native 生命周期。

## 查重与排除

[全历史查重](evidence/host-dedup.json) 遍历现有 docs/bugs 下 **1,601 份 Markdown/JSON**，包含 **169 份 nested archive/_archive** 文件；JSON 按 leaf 解析，无解析错误。当前 round11 排除。115 个词项匹配主要是历史覆盖、架构、引用及既有候选，均未当成新发现。

`runtime.ts:50` 保存 caller-owned service 引用的想法已经在 [round3 HL-C1](../audit-2026-10-17-round3/host-link.md) 记录。当前三个生产创建点仍构造私有对象，没有后续 service/handler 突变生产者，且没有明确的登记快照契约；未做人为突变实验，不重复登记为新候选。README 明确生命周期同步，因此没有以 async void 回调制造缺陷。

初次历史库存错误把不存在的顶层 archive/_archive 传给 rg，工具 exit 2 且路径列表过大被工具截断。该静态导航失败的 [标注转录](evidence/host-static-inventory-skip.md) 已保留；不存在路径方向跳过。后续独立去重只从实际存在 docs/bugs 根收集并解析嵌套档案。此事件没有运行产品或测试，不计 failed Bun shard。

## 覆盖界限

host-requests 仅阅读普通数据形状与映射清单；authority/approval/security/auth/credential/custody/watchdog 行为均不作为本次验证目标，未调用 dispatch/intercept。没有启动真实 worker、Engine、模型、provider、插件 native entry、外部进程或网络，没有访问用户数据。三处当前生产 HostRuntime 创建点都没有传入 start/stop 回调，因此 fake adapter 控制只证明公共同步生命周期行为。现有 runtime.test.ts 混有请求/approval 测试，本次未执行整文件。未运行构建、typecheck、lint 或 full suite。

[源码 manifest](evidence/host-source-manifest.json) 记录 11 份源码/配置与冻结哈希、当前一致性及读取范围；[validation](evidence/host-validation.json) 给出精确计数。
