# 第十六轮 Server/Web 命令取消与连接归属恢复

Completed。正式新增 **0**。冻结产品 `a66f4ef291f304ee4df9da8095a90671d9a8f140`；产品、主报告、goal及build/dist均未改。已读CODESHELL、当前68项与flow，并避开R03/06/09/10/17/31/34/36/38/41/57/68既有根因。

本轮选择实际 MCP HTTP 连接测试的取消、HTTP断线、登录归属和重试作为未泛化到其它命令的边界检查。另只读审查Hub WS agent/cancel及错误路由，不以没有新增缺陷表示所有相邻路径都已完整验收。

## 最终正常证据：真实认证 + 实际 MCP HTTP 协议

证据目录 `docs/review-2026-10-12/reproductions/command-recovery-round16/`：

- `mcp-owner-controls.test.ts`：guarded Bun wrapper，**1 pass / 0 fail/skip / 2 expect**，有 `Completed Bun shard: 1 tests, 0 skipped; 0 failures.`
- `mcp-owner-controls.mjs`：经仓库 `scripts/run-isolated-node-smoke.mjs`运行的owned Node v25.8.1 fixture，**22 native断言**；在该一个wrapper test内，不另算Bun测试/expect。日志 `mcp-owner-controls-native.log`，原始JSON `mcp-owner-controls-observed.json`。

实际使用 `createHubAuth`/HubAuthStore，通过真实 `/api/v1/auth/setup` 与 `/login`建立两个有效cookie/不同owner，真实配置文件和 `createHubMcpConfiguration`。isAuthorized/ownerId为生产相同的auth.authenticate回调（`headless-server.ts:586–590`），没有ownerGate、假身份或人为认证延迟。HTTP入口先执行真实auth.handle、认证和origin admission，再调用实际MCP handler；MCP上游也是同一个owned loopback HTTP listener上的合法initialize/tools/list协议fixture，不启动stdio进程、真实MCP服务、模型、CLI或外部账号。

这个装配运行了共享auth/MCP模块与同样的admission callbacks，**没有启动完整startHeadlessServer/Main、worker、Web UI或真实浏览器**；它不代替完整Hub集成验收。上游MCP protocol server是自编内存HTTP fixture，不执行工具，仅返回一项tools列表或有界等待initialize以固定取消顺序。

### 动态结果

1. **注册前请求体取消正常。** 原生Node HTTP先发送合法headers与JSON的第一个字节，令实际 `readJson`等余下body。这是真实请求体尚未传完的等待，不是延迟owner回调。显式cancel-probe返回200/`cancelled:false`；随后实际destroy原HTTP请求，handler结束、socket destroyed，**上游initialize次数仍0**。tiny JSON通常很快，本例只固定真实可达的body上传边界，未声称普通用户普遍会遇到这个持续时间。
2. **注册后owner取消正常。** 一个真实认证owner的MCP probe启动本地上游后，同owner第二次probe获429。另一真实登录owner的cancel返回false，不取消原操作；原owner取消返回true，原probe回应200/`status:"cancelled"`，上游连接实际关闭。
3. **断线释放后可重试。** 已启动probe的HTTP客户端断开，实际上游response close；随后同owner重新probe成功，200/`status:"ok"`。
4. **退出登录按owner取消。** 已启动probe时，真实auth logout→onRevoke→api.cancelOwner关闭其上游；待回包原请求与旧cookie新请求均401。另一真实登录继续probe成功，未受该owner撤销影响。onRevoke到MCP的装配同生产 `headless-server.ts:193–197`，没有重新把R38的前端logout等待问题列一次。

以上使用1500ms探测上限，成功执行约1.2秒；未等待生产默认10秒，也不从此声明全局超时/所有代理行为。实际probe资源门禁为 `mcp-configuration.ts:482–483`，注册/close监听 `:484–508`；owner取消 `:599–605`。正常response JSON错误/取消结果本轮按真实HTTP解析。

## 已剔除候选：人为异步owner迟到后开始probe

原始诊断在 `diagnostics/`：

- `artificial-owner-delay.mjs.txt`、`artificial-owner-delay.test.ts.txt`
- `artificial-owner-delay-native.log`、`artificial-owner-delay.test.log`、`artificial-owner-delay-observed.json`

诊断给ownerId注入人工gate，使probe在 `mcp-configuration.ts:477–478`暂停；另一HTTP cancel找不到尚未注册的probe返回false，原请求断线后释放gate，随后仍进入本地MCP probe并占owner槽至再次取消。该诊断确实运行成功（1 wrapper/2 expect +20 native断言），但**它没有证明当前生产的同一等待窗口**，不属于正式缺陷或最终正常证据总数。目录中的文本后缀不是活动test，不能塞入主runner当已证缺陷。

关键反证：Hub `headless-server.ts:588–589`虽使用async callback，`auth-http.ts`的authenticate仅返回 `store.authenticate(token)`；`auth-store.ts:161–174`是同步read/mutate/锁路径，不在owner解析过程中await真实网络/文件I/O。返回已完成Promise后仅有微任务继续；不能仅凭语法的await就注入一个可被后续HTTP事件越过的长I/O窗口。Desktop facade的owner callback同样取已授权请求identity。本轮没有证明当前production出现人工gate对应的异步操作，因此剔除，而非用类注入点的防御性不足增加发现数。

如果未来某Host把ownerId实现改为真正延迟的外部授权，补initial closed/aborted检查及命令级cancel tombstone可能值得考虑；这是未来接口防御建议，**不是当前产品的确认bug**。模型连接probe已有requestId tombstone（`configuration.ts:376–413`），读作设计对照，不据差异直接判MCP有缺陷。Web `HubMcp.tsx:194–215`是await显式cancel后abort原fetch并显示cancelled；该正常用户入口不使人工ownerGate变成真实生产事实。

原始诊断日志还含自编上游fixture误将非POST请求当JSON的empty-body提示，仅该诊断server的harness行为，非产品失败；最终正常fixture对非POST返回405，原始成功日志保持干净。没有将旧诊断通过与最终正常wrapper再累加。

## 其它只读排除与范围

- Hub `headless-server.ts:207–240`将pending响应路由与runningSessions/owner分开，tab close清请求路由但明确不取消已经提交的run。`routeWorkerLine:467–497`在相关响应到达时清运行和owner，并只把响应发原tab；不能因tab离开仍运行就判资源泄漏。仅源码/既有fixture核对，未重跑这套worker生命周期。
- active run有 `isRunning`特殊放行新session cancel，`authorizeServeRequest:1572`使尚未写首个state文件的正常任务可被取消。既有headless-lifecycle.test.ts已有这一控制；本轮不重复计入，不制造一个必须先持久化才能Stop的假问题。
- 保存配置的临界区 `headless-server.ts:542–553`先拒绝preparing/running/pendingworker/tasks。只看后面的configuration-changing错误门禁不能宣称正常活跃任务的cancel必定被保存配置阻塞；本轮未构造可达反例。
- Paired native `run.stop`与external stop按会话authority分开（`handle-client-event.ts:487–510`）；CLI room错误callback属于R08、既有未确认回执/审批恢复属于旧编号，本轮未重复。
- 未把无id的通用错误回包、未来异步授权、防御性TODO或主动断开后仍完成已接受任务泛化为新问题。没有复现真实worker/模型执行，因此没有新增关于取消实际工具或CLI进程的结论。

## 隔离、便携及最后计数

命令从冻结checkout根目录运行：

```sh
node scripts/run-bun-test-shard.mjs --timeout 25000 docs/review-2026-10-12/reproductions/command-recovery-round16/mcp-owner-controls.test.ts
```

仅用cwd定位repo、已建dist和owned临时目录。guarded Bun wrapper检查HOME，maintained native isolator另建私有HOME；native fixture在任何Core/Host导入前安装精确loopback origin的HTTP/fetch guard。所有客户端和MCP上游在一个自有origin；不宣称OS网络sandbox或全面direct-net限制。finally终止自有requests/upstream/sockets，await api.close/server.close，删owned文件；成功exit0与Completed在finally返回后发生。10s/15s fixture/wrapper预算未命中，未验证任意hung descendants的进程树强杀。

最终本agent **新增正式0；当前正常便携1 Bun文件/1测试/2 expect/0fail/skip，内含22 native断言另列**。原始人工ownerGate诊断不计。只在a66f执行；auth-http/auth-store/mcp-configuration/mcp-probe/HubMcp两基线diff为空，无0.9.33新增API依赖，但未冒称旧基线动态复跑。产品git status仍仅root已有 `?? docs/review-2026-10-12/`。

## 主审便携复核

主审已把最终脚本复制到初始84740与新a66f冻结快照，分别通过项目规定的guarded runner；两份完成日志及metadata均已归档。本附录前文的“原始只在latest运行”仅描述专项作者原始实验，不能覆盖这次独立双基线复跑。没有产品改动、build/clean、真实模型/账号或额外完整Electron实验。
本专项1文件1个Bun测试2个Bun expect；内部Node另22断言，两基线分别通过，正式新增0。人工ownerGate诊断只归档，不进入默认复现收集。
