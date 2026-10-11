# Round22 owned Browser Stop native fixture — launch 前核对

时间：2026-10-12 SG07:08。当前只写 `/tmp`、读冻结 source，**没有执行 prepare、转译、Core、Electron、Chrome、worker、模型/CLI 或网络**。两份入口 `node --check` 仅语法通过，属于支架检查，不计 native 成功或产品测试。

## 入口与编译/加载路径

- 外层：`/tmp/codeshell-review-20261012-browser-stop-round22/browser-stop-native.mjs`。
- owned Main 模板：同目录 `owned-main-template.mjs`。
- 复跑命令（先审，不先执行）：

```sh
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-review-20261012-browser-stop-round22/browser-stop-native.mjs
```

- prepare-only 选项只生成 owned stage，不 launch Electron，不 evaluate 产品；会保留私有目录与 prepare receipt，供 root 只读检查：

```sh
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-review-20261012-browser-stop-round22/browser-stop-native.mjs --prepare-only
```

Native launcher 复用 maintained `run-isolated-node-smoke.mjs` → `makeIsolatedElectronHome` → `prepareConfinedElectronFixture` → `launchCodeShellElectron`。不运行 generated product Main entry，owned Main 独立加载。依赖全部来自当前冻结树的锁定安装，不 install/npx、不下载、不运行原 browser-library-probe。

仅 actual preload 用锁定本地 esbuild 0.27.7 转译成 private HOME 内 CJS：API 配置 `entryPoints=[frozen/packages/desktop/src/preload/index.ts], bundle=true, platform=node, target=node20, format=cjs, external=[electron,playwright,puppeteer-core,puppeteer-core/*], outfile=private/actual-preload.cjs`。这个准备阶段可能启动已安装 esbuild 的本地编译子进程，与 Electron Main 的 runtime child deny 分开。没有产品 build/clean/dist 写入，Core/Host 不在准备阶段运行。

Actual Core 和 Desktop modules 使用同一进程内 jiti 2.7.0，**全部 `await jiti.import()`**，由绝对冻结 source 路径加载，保留 import.meta.url 与 prompt/data 相对资产位置；`fsCache=private/jiti-cache, tryNative=false, moduleCache=true, tsconfigPaths=false`。明确 alias Core root/internal/extension、Server worker、cdp root、Link root 到本冻结 src 文件。Desktop owned entry只重新导出实际 runtime/driver/adapter/dispatch/intercept/metadata/fallback/DEFAULT_POLICY 等，不 single-file bundle runtime，不从另一套 Core dist 注册 provider。记录 `jiti.cache` 中 workspace 加载路径并最终断言无 product `/dist/`、无 operator checkout。

两个 Main callback 从 actual `agent-bridge.ts` 按唯一完整 source markers 提取，只 TS 转译，不改函数体：`maybeHandleBrowserAction` 与完整 `agent:msg` IPC callback。工厂显式返回闭包，再 `.call(receiver)` 绑定；不构造完整 AgentBridge，不执行 constructor/WorkerBridgeCore。`core.canSend/hasChild` 均为 true，代表逻辑 live in-memory backend；没有 OS worker，sendLine 只把同 JSON-RPC 送到实际 AgentServer 的 owned transport。实际 Core AgentServer、ChatSessionManager、Engine 与 ToolRegistry/Executor均运行；唯一 provider 是明确注册的全内存 `OwnedClient`，只有 snapshot/click/completion固定响应，没有 SDK、HTTP 或 CLI请求。

## 私有环境和三层 guard

1. outer maintained isolator scrub provider credentials、HOME、应用配置。nested maintained Electron confinement 再 scrub inherited Host配置，并在 Source/Core import前执行 guarded-runtime exact-origin bootstrap，要求 CODE_SHELL_HOME/TEST_HOME正确。允许的 Node HTTP origin为 `http://127.0.0.1:9`，没有业务 HTTP endpoint或连接。
2. owned Main 在 app.ready前设置独立 appName/userData/sessionData；bootstrap后检查 HOME/TMPDIR/TMP/TEMP。三个 temp变量都指向已建 `private/tmp`；Core import前 `process.chdir(private/owned-project)`，因此 project-scoped settings/skills扫描只读 owned cwd，而非 repo或 operator项目。Node fetch、http/https request/get也显式拒绝并逐次记 highLevelNetworkAttempts，net.connect/createConnection/Socket.prototype.connect、tls.connect拒绝并记 networkAttempts；child_process spawn/fork/exec/execFile及同步变体、utilityProcess.fork全拒并syncBuiltinESMExports，均在产品模块import前。最终 receipt分别要求两种network和child attempt数组为空。没有另外执行外联/child负向探针，不能称这些deny已全部动态负测。
3. defaultSession和owned target partition在load前安装Chromium webRequest guard，只允许两个精确owned file URL。HTML CSP 禁connect/图片/对象/外部资源；仅owned inline script/style。window.open拒绝、导航拒绝其他URL；后台窗口依据 actual `buildWindowOptions`，contextIsolation/nodeIntegration/sandbox/webSecurity/backgroundThrottling遵正式选项。actual preload只装于owned controller，不装于target。Maintained Playwright在外层建立自己的动态local CDP控制通道，与Main/renderer业务guard分层，不冒称禁止了Chromium必要helpers或该控制通道。

## 正式可达条件与证据标准

Session由实际 SessionManager在private path持久化，origin=desktop、kind=work、workspace.root=private project，**无 project 绑定的合法legacy Session**。没有声称已经动态覆盖现代bound Session；未绕R79缺WorkspaceContext门禁，实际Engine必须正常产生snapshot/click才算实验有效。正式 Core wireInteractiveSession安装 actual BrowserBridge；provider固定工具响应仍走真实Engine builtin tool → Core request/pending → source-extracted actual Main callback → actual dispatch → actual DesktopBrowserRuntime/InAppBackend/BackgroundRuntime → actual Electron adapter → actual Puppeteer driver → real owned Chromium DOM。

Browser profile由actual `active-guest.registerSessionBucket(sid, "__no_repo__::"+sid)`注册为同正常Host legacy bucket；Runtime只替换owned targetPool，不替换partitionForProfile，实际InAppBackend经actual partitionForSession解析。该注册由owned Session目录建立，未构造真实AgentBridge handleAgentRunMetadata或renderer run，不能称完整Host authority admission。AgentServer.sessionDiskRoot与owned Engine/SessionManager storageRoot一致，避免默认磁盘reader读另一位置。

默认策略明确用 actual `DEFAULT_POLICY`（allowedDomains=[]的正式默认）；不是绕开实际敏感/域名门禁。按钮名称 `Owned action` 无敏感词、无凭据/支付/删除。实际owned BrowserHost test seam只创建两个hidden窗口和ownedfile目标，不打开真实网站。正式 BrowserHost导航policy不作为file测试入口覆盖；直接`loadURL(owned file)`是owned载体夹具，不声称文件URL是产品给模型的常规导航选择。

`frame.waitForFunction` 和 `wc.debugger.sendCommand` 只作observational wrapper：原样调用真实Puppeteer/CDP，不插入barrier、不改变predicate或输入；wait wrapper只在原Promise上观察settlement，透传同值/同异常。每个Frame只装一层wrapper、复用时更新label，不把wait次数当动作次数。按钮初始disabled；actual snapshot合法获得ref；actual readiness等待disabled消失。所有旧Input事件必须在 Stop后enable时发生，不能只是旧操作回包。Core settle、owned enable和实际Input另有单调事件sequence，避免同一毫秒的严格时间比较造成支架假失败。

主要场景依次断言：

- 正式工具click仍在真实ready等待、button.disabled=true、hits=0、Input命令计数0、Core busy且pending=1。
- 实际product preload `window.codeshell.cancel(sid)` 经原生Electron IPC → 实际完整Main callback → actual AgentServer Methods.Cancel。ACK={ok:true}；真实ChatSession run signal aborted、Engine abort结果已settled、Core busy=false/pending=0；此时disabled仍true、hits0、Input0，Main旧click仍等待、driver signal未abort。
- 只有在Core已settled后才由owned test启用本地DOM按钮。要求旧实际Input命令随后出现、真实click handler hits=1、Main late browser success；Core拒绝迟到approve、模型调用数不增加/不复活旧turn。
- 正常控制1：同真实page构造有AbortSignal的实际PuppeteerBrowserDriver，其ready等待被abort，enable后不input、不增加hits、page保留。
- 正常控制2：Stop后合法新用户turn通过fresh actual snapshot+click完成，证明tasktarget保留本来正常；完成后再Stop不回滚既有hit，也不发送新input。`releaseActualTarget/resumeActualTarget`测试seam已准备但本脚本未调用，不能记作动态覆盖。

该实验即使成功也不是产品App/full Desktop/真实worker stdio E2E；actual Core 与实际Native Browser动作在同owned进程，stdio由内存adapter替代、完整AgentBridge构造和真正React Stop button未挂载。正常UI Stop接线另有只读source证据。

## 关闭与账本

每次独立输出source manifest、native observations、cleanup receipt。成功只按standalone native Node assertions计，不加Bun。首次加载/prepare/断言失败若发生必须保存原始source与receipt，再修；不能吞失败或记成功。

Native finally不论 Core/runtime shutdown是否失败，都另行尝试 app.close；shutdown有10秒上限。确认ownedMain close收据后才删privateHOME；必要只对本次owned child PID执行TERM/KILL并标记failure，不操作operator进程。若不能确认close，则保留HOME并失败。preparation顶层失败单独cleanup并记录；unexpected postprepare失败保留HOME防删仍运行进程状态。Main/Puppeteer/Chromiumhelpers正常创建本来就是nativeapp所需，不写“没有任何子进程”。maintained assertWorker(false)的empty spawned-worker file不是动态spawn负向探针；无worker的依据是本ownedMain显式child/utility deny、ensureWorker throw、只构造in-process Core transport，且没有产品Main/WorkerBridgeCore构造。

当前尚未execute/prepare/launch，正式新增finding0、测试计数0。支持进一步核对的只是自然await可行性，未依optional AbortSignal本身认定产品Stop合同；与架构Stop signal→tool handler合同、Core pending清理、lease保留设计分开解释。

## SG07:28 执行后的状态补记

上文为 SG07:08 的 prelaunch 记录，保留当时状态。root/web预审最终guard/module图后，先root审 prepare-only生成物，再root明确授权native。最终作者第7次独立运行 Completed66 Nodeassert/exit0；前6次支架加载/模型schema发现/回包断言/预算失败均保留、未算产品问题或成功；源和完整账本见 `/tmp/codeshell-review-20261012-browser-stop-round22.md` 与 `.../browser-stop-round22/final-author/`。最终launcher SHA11bc7a9cf31d53a69c55191b89fe08d621e4857621175841bb13a446d97c320d，Main SHA1f9213c591383ae16b4ac41adaabcce8be298fcf143503909eb067cc7dbaf26b。

保持上述guard/模块加载/运输边界；修正的业务支架前提为正式desktop Host、provider按requestBoundaryId区分main/aux、真实ToolSearch select加载deferredBrowser schemas、合法maxTurns8。所有修正先归档失败，Host/ToolSearch/预算均经root审核授权；没有修改availability/生产handler。Main源码仍冻结，最终prepare资产privateHOME已随app.close(code0)精确回收。prepare-only HOME亦在root核完后精确移除并保存独立removed收据。产品build/clean/源码写入0、真实worker/model/CLI/operatorChrome/外站0。
