# 第二十轮：R75 Electron 存储 scope 补证

结论：**0 新发现，R75/P3 不变；补上真实 Electron defaultSession + 同一 file URL 的 localStorage 共享、storage event 和 reload 契约。** 本轮为独立 owned Electron / 纯 HTML probe，不是产品 App、ModelPill 或实际 hook 的原生 E2E。实际产品组件接线仍引用第十八轮已在两冻结基线通过的 3 tests / 46 Bun expect；本轮没有重跑该组件测试，也不重复累计。

本轮最终成功 1 次 standalone 原生验证 / **31 Node assertions** / Completed / exit0；3 个存储场景不是 Bun tests，不增加主报告 finding 数或 Bun 文件/测试/expect。较早一次 launch harness 超时为0断言，另列保留。

## 生产窗口门禁的只读反证

基线为冻结 a66f4ef291f304ee4df9da8095a90671d9a8f140，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已重读 CODESHELL、第十八轮模型报告、当前主报告及 maintained Electron/native smoke 隔离代码。没有构建、清理dist或修改产品/主报告/goal。

- 正式 `main/index.ts:5835–5836` 的 `window:new` IPC调用 `createWindow()`。`createWindow` 的主窗口 `webPreferences` 在 `:1370–1378` 未设置 partition 或 session；`:1390–1391` 明确跨窗口共享 session，`:1447` 和 `:1466` 的主renderer处理器也设置到 `session.defaultSession`。
- 所有主窗口在 `main/index.ts:1492–1498` 加载同一个 VITE_DEV_URL 或同一个打包 renderer/index.html 路径。BrowserPanel guest独立partition是另一路径，不能把guest分区当作主窗口storage分离的门禁。
- 已安装 Electron33.4.11 的官方类型说明 `electron.d.ts:17510–17515`：未指定 session/partition时用default session；`sessionData`说明 `:1651–1653` 要求在ready前设置私有路径。本轮仅采用上述主窗口相关选项：contextIsolation=true、nodeIntegration=false、sandbox=true、webviewTag=true；没有产品preload。
- 产品 `useBucketOverrides.ts:30,36` 在初始化时读模型图、effect整图保存；`transcripts.ts:247–254,268–279` 为共享key `codeshell.overrides.model` 读取/整图setItem，没有跨窗字段合并。`App.tsx:340` 的实际lookup是override缺失时回默认模型。上述仍为源码/既有实际组件证据；本轮纯HTML不加载这些模块。

## 安全的最小原生夹具与范围

使用 maintained `scripts/run-isolated-node-smoke.mjs`，再使用 maintained `makeIsolatedElectronHome` 和 `prepareConfinedElectronFixture` 的真实私有HOME/env scrub/guard bootstrap。**没有运行后者生成的 product Main入口**；明确给 `launchCodeShellElectron` 传入独立 owned `owned-storage-main.mjs`。该文件只导入 Electron、Node内置模块和 maintained network guard，既不导入 Core/Host，也不加载产品Main/preload或React bundle。

owned Main在任何await前检查 `app.isReady()` 为false、设置私有userData和sessionData；随后导入预先生成的guarded-runtime，再注册ready callback。maintained Playwright loader对ready有受控启动门，此检查按其API状态记录；启动后还从实际Electron读取并断言两个路径均为private目录，不仅凭env推断。Main最终appName为 `codeshell-owned-model-storage-round20`。maintained launcher包含自己的keyring bootstrap，但本夹具不调用safeStorage、SecretStore、登录/配对或任何提供方接口。

Main exact-origin Node guard为 `http://127.0.0.1:9`，没有连接该端口；raw net.connect/createConnection和tls.connect另外拒绝。Chromium defaultSession及分区control各装webRequest guard，只允许精确owned HTML file URL，页面CSP禁止外部连接/资源/弹窗。Node child_process spawn/fork/exec及同步变体、utilityProcess.fork全部拒绝。最终这些拒绝边界的attempt记录为空，说明未尝试调用；本轮没有另做外网或子启动负向探针，不能把“安装了guard”写成已动态验证全部逃逸路径。

parent不导入Core/Host；parent的maintained Playwright CDP动态loopback控制通道与Main/renderer的业务network guard分开。只有owned Electron Main、renderer和正常Chromium helpers；“没有CodeShell worker”不等于没有任何OS子进程。

## 原生收据与三个场景

实际版本：Electron **33.4.11**，内置 Node **v20.18.3**，macOS；外层maintained Node runner与Electron内置Node分层。最终owned Main PID60835，真实初始两个主窗口如下：

| 实际身份 | A | B |
|---|---|---|
| BrowserWindow id / webContentsId | 1 / 1 | 2 / 2 |
| Renderer PID | 60850 | 60855 |
| `webContents.session === session.defaultSession` | true | true |
| 实际location.origin | `file://` | `file://` |
| 实际页面 | 同一精确owned-storage.html绝对file URL | 同左 |

实际URL为 `file:///private/var/folders/1d/6__4f4y51g90nblfptt8s9v80000gn/T/codeshell-model-storage-round20-2HTCRf/owned-storage.html`，完整身份和路径保存在native-observations.json。本次Electron实际返回origin `file://`；不能用origin字符串相同推导所有file路径共享存储，本实验只验证同一精确file URL。

1. **两个已打开默认session窗口的旧图整写。** A/B均先读取空图。A保存 `{A:alpha}` 后，B的真实localStorage读取已见A，同时收到真实storage event（key与newValue保留在JSON）；B自身先读的普通JS map仍为空。B用自己的旧map保存 `{B:beta}` 后，A的真实localStorage只剩B，A活JS map仍有alpha。实际reload A后，页面初始化读取B-only。纯HTML复制的 `map[bucket] ?? fixture-default` 表达式返回default。这里动态证明的是原生共享存储、JS快照与reload；**不是实际useBucketOverrides在Electron运行**，也没有提交模型任务。A从新图再次选择alpha可恢复A+B。
2. **正常晚开窗口。** 清理owned测试key并reload A后，A先保存alpha，再打开defaultSession窗口C。C的首次读取包含A，随后整图加入B保留A+B；真实reload A后复制lookup仍得到alpha。这个正常控制说明需要另一已打开窗口持旧图，不是任何双窗口操作都必丢失。
3. **独立partition正常边界。** 同一HTML但显式非持久独立partition的窗口D，session不等于defaultSession且初始为空。D保存自己的control值不改变默认session的A+B图。最终有三个defaultSession窗口和一个control窗口，均为owned。该control证明确有分区保护可用，但正式主窗口没有配置它；不是建议直接给每个项目换partition，产品还需保留其他共享状态和迁移语义。

Main/renderer guard收据：Main PID/home hash/exact-origin一致，spawned agent-worker记录空；Node childAttempts=[]、direct networkAttempts=[]；Chromium请求记录非空，共7条，全部是允许的同一ownedfile；无renderer pageerror/render-process-gone。没有声明guard负向探针执行过。

关闭收据：`cleanup.json` 的 completed=true、failure=null、assertions=31、closeReceipt={code:0,signal:null}、isolatedHomeRemoved=true；await app.close后await进程close再删privateHOME。额外只读ps对本次已知Main/renderer及首次失败Main PID均无匹配，不操作其他进程；该事后进程检查不加进31断言。outer isolator也exit0。

## 证据分层与对R75的影响

| 层级 | 已证明 | 未声称 |
|---|---|---|
| 生产源码 | 正式多窗口入口使用defaultSession和同一加载路径；实际hook整图保存、无跨窗同步；实际App override/default lookup | 单靠源码推出真实Electron共享存储已执行 |
| 既有第十八轮组件fixture | 实际ModelPill→switchActiveModel→useBucketOverrides→save/loadOverrideMap，两个React roots/sharedMemoryStorage；真实hook重挂fallback，发送参数适配器记录default；两基线各3/46由root执行 | 实际Electron localStorage/实际模型运行 |
| 本轮原生fixture | 两真实BrowserWindow/defaultSession/同file共享localStorage与storage事件、旧普通JS图整写、真实reload和晚开/partition controls | 产品App/实际ModelPill或hook原生E2E；真实provider/Engine、费用或执行中模型改变 |

组合证据补足R75原先仅静态的Electron存储边界。支持保留 **P3模型选择持久偏好丢失/可重新选择恢复**；不升P2，不增加新finding，不扩permission/goal。实际分区与同file边界只在latest这份owned Electron33/macOS实验运行；dev HTTP origin/其他file路径、平台或其他Electron版本未动态覆盖，也不把本次无产品依赖的原生实验包装成两产品基线分别执行。

## 冻结文件、复跑、计数和首次诊断

最终冻结文件均在 `/tmp/codeshell-review-20261012-model-native-round20/`：

- `model-storage-native.mjs`：cwd portable独立脚本。
- `native-electron.log`：最终Completed/31断言。
- `native-observations.json`：原生身份、storage events、三个场景、network/home/child收据。
- `cleanup.json`：ownedapp正常close及privateHOME删除。

从冻结repo根目录运行：

```sh
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-review-20261012-model-native-round20/model-storage-native.mjs
```

不需要build或启动产品应用。成功运行只计 **1个standalone native fixture / 31个Node断言**，三个场景不当成Bun tests。本轮Bun0，真实产品组件测试新增执行0，finding新增0。launch前独立只读预审执行0已核隔离/边界并建议三项收据保护，均已加入；最终原生结果尚由root独立读审，不冒称预审代理已核最终收据。

首次失败诊断完整保留：`first-launch-harness-failed.source.mjs`、`first-launch-harness-failed.native-electron.log`、`first-launch-harness-failed.cleanup.json`。该次0断言，electron.launch20秒超时；maintained Playwright loader（已只读安装源码）在entry评估完成后才释放其app.whenReady Promise，自有entry顶层await whenReady导致harness互等。改临时entry为 `.then(async...)` 注册后返回，不改产品或安全边界。失败launch的owned PID60204事后不存在、privateHOME已删；不把启动夹具失败列为产品发现或成功验证。

Completed — 新发现0；latest owned Electron最终成功1次 / 31 Node assertions / exit0；首次launch诊断1次 / 0assert另列；产品组件既有3/46分账；只写/tmp。

## 主审便携执行与独立核对

作者最终latest一次31断言单列保留。主审将完全相同的cwd便携脚本复制到latest docs后，另用maintained native isolator执行一次：**31 Node assertions / Completed / exit0**，Main PID62446；三默认session窗口及一control、实际storage event/reload/晚开窗口结果一致。源SHA256与作者冻结源相同。两次运行分别报告，不包装成一套62断言，不增加Bun或finding数，也不声称旧产品基线已另跑原生App。

主审最终[脚本](validation/model-native-round20/model-storage-native.mjs)、[日志](validation/model-native-round20/native-electron.log)、[观察](validation/model-native-round20/native-observations.json)、[清理](validation/model-native-round20/cleanup.json)；[作者原始材料](validation/original-model-native-round20/)，含第一次0断言启动harness失败及launch前只读预审。主审[独立核对](model-native-quality-round20.md)明确本轮只补原生存储契约。

复跑入口（repo根目录，无需build）：

```sh
node scripts/run-isolated-node-smoke.mjs docs/review-2026-10-12/validation/model-native-round20/model-storage-native.mjs
```
