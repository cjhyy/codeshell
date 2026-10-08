# AgentModule Phase C：资源生命周期验收

日期：2026-10-09。基于 `origin/main` 的 `28f69b8e` 实施；没有改变当前 0.9.26 版本。
本次交付覆盖生命周期 Phase C；模型请求边界 Phase D、跨 Session 成本归集继续留在 TODO。

## 实现与所有权

`EngineRuntime.lifetime` 是共享 host owner。每个真实 Engine 建立独立 engine scope，
每个使用过的 Session 建立 session scope，每次 run 建立 run scope。没有 Runtime 的 SDK
Engine 也拥有独立 scope，调用方可通过 `EngineConfig.lifetimeScope` 提供外层 owner。

`LifetimeScope.dispose()` 返回同一个 Promise。子 scope 先于父资源释放，同层按获取逆序，
异步 disposer 完成后才进入下一个；一个失败不阻止后续释放，最后返回 `AggregateError`。
已关闭 owner（包括正在关闭的祖先）拒绝新增资源，已释放子 scope 从父 owner 脱离。

实际迁入 scope 的资源包括 Engine 本地 tool registry、模块/SDK hooks、settings/plugin
reload hooks、MCP owner、模块 private services、session services、run 的 GoalStopHook、
file-history hook 和权限 controller detach。Runtime 继续独占共享 model pool、registry、
MCP 连接和 sandbox cache，不为每个 Engine 复制共享资源。

Runtime 关闭会先取消并等待 active Engine run，随后释放 session/run/module 资源，最后释放
共享 host 资源。若 Engine 或 host activator 仍在初始化，关闭会先释放其已获取 owner，
触发其自持取消操作，再等待 factory 完成；迟到返回的资源立即释放，后续 activator 不再启动。
private-service 任一 factory 失败会立即回滚已获取资源，其他并发 factory 的迟到值也会释放。

`ToolRegistry.registerTool`、`HookRegistry.register` 和 protocol query registration 返回
绑定单次注册身份的幂等 disposer。旧 disposer 不会删除同名的新注册；重复使用同一 handler
或 tool definition 也不会混淆 owner。hook reload 不再按名字前缀删除其他 owner 的 hook。

## 声明、激活与隔离

Compiler 复制并冻结最终声明，保护数组、嵌套对象、Map/Set，包括 `forEach` 与 `valueOf`
的可变集合逃逸路径；不会冻结或修改作者的输入对象。private service 必须显式声明
`scope: "engine" | "session"`，非法 scope 在任何 factory 执行前报错。

`activateHost` / `activateEngine` 可返回异步 disposer，也可通过 `ctx.own` 获取资源。
激活上下文不暴露 mutable registry，不允许激活时补充新声明。private services 按其 owner
创建一次；工具 executor 只能收到声明该工具的模块自己的 private service。

Observer factory 仍然 fail-soft。失败 observer 的部分 query 立即撤销，其模块的 host
activation 跳过，其他模块继续工作。observer 只可注册自己声明的 query；捕获的 callback
在 owner 关闭后不能留下 late registration。已声明 protocol query 经通用路由分发。

TCP disconnect 只释放当前 transport 的 observer/query/module scope、bus 订阅和 approval
ownership。其他连接继续使用共享 ChatSessionManager / Runtime / Session。完整 host close
则等待所有 Session，包括已从 resident map 删除但仍在 `closingSessions` 的异步 disposer，
并拒绝新 Session acquisition。idle eviction 的 Main-root migration 在旧 owner 释放后再交接。
Quick Chat 临时 Engine、cold-resume storage probe 和 bootstrap seed Engine 均会释放。

## Host 消费者

- `AgentServer.close()`、SDK `createServer().close()`、`createInProcessClient().close()`
  返回可等待的 Promise；legacy 单 Engine host 同样释放 Engine。
- EngineRunner 与 headless CLI 在结束/退出前等待关闭。stdio 信号和 parent EOF 等待 Session、
  Engine、module 与 Runtime 资源；TCP 进程退出同样等待这些资源。
- TUI REPL 释放 seed 和一次性 cron Engine，退出等待 AgentServer 与 Runtime。
- Desktop worker 使用同一 stdio 入口；独立 automation 和 dream 的 Engine 在 `finally`
  释放，browser lease 最后释放。

## Golden 的有意变化

只增加两项已有行为的声明证据，工具、preset、prompt、hook、profile、validator 顺序均保留：

1. Pet 现有 `agent/getPetProjectionSnapshot` 从 observer 的隐式动态注册变为显式 query 声明。
2. coding 原 `createToolService` 改为 `privateService`，golden 增加 `scope: "engine"` 元数据。

`tests/fixtures/composition-golden.json` 保留审阅过的拓扑；本次没有为通过测试盲目重生成 fixture。

## 验证与边界

- 较广 Engine/protocol/hooks/executor 回归：1027 项通过。
- 独立 review 的 pending activation / late observer / evicted owner 修复后，protocol、
  composition、相关 Engine 与生命周期回归：386 项通过。
- Package release smoke：9 个 tarball、47 个 typed entry；严格 NodeNext declarations、
  runtime imports 与 packed owner-auth lifecycle 均通过。
- 全 workspace typecheck、Desktop 完整 build、engine-bypass guard 与任务文件 ESLint 通过；
  headless CLI 既有一条 `no-useless-assignment` warning 没有由本次引入。
- `tests/module-lifetime-consumers.test.ts` 通过编译后的 Core/coding/Pet 入口验证 TUI、Desktop
  worker、headless composition 和 async close；`tests/module-lifetime-worker.test.ts` 另用真实
  Node 子进程运行已编译 stdio worker，加载 coding/Pet 与异步资源 probe，发送 metadata RPC，
  关闭 parent stdin，并核对 seed/service/Engine/host 的完整释放。
- Golden、已编译消费者、SDK、包边界及 Desktop worker/automation 配置合计 43 项通过；
  stdio factory 原有 5 项另在保持 stdin 打开的终端中通过，避免测试入口在 EOF 时先退出。

这些验证使用合成模型配置和本地临时目录，没有调用付费模型，也没有启动 Electron GUI 或
在交互式终端手工操作 TUI。模块应将自己的可取消工作注册到 owner；任意永不完成且未提供
取消手段的第三方 factory 无法由 scope 强制终止。运行中模块热替换仍不在本设计承诺内。
