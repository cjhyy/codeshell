# 第十六轮整合报告最终只读语义核验

Completed。只读核对主目录 `/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/docs/review-2026-10-12/` 下的 README、flow-coverage、latest-baseline、reproductions/README、project/settings/link/command 四份 round16 专项、两份 quality，以及两基线 metadata 和本轮最终日志；并阅读关键生产调用链和已归档 fixture。**新增测试运行 0、断言执行 0、native/模型/账户/网络实验 0；没有创建代理或改产品/主报告。** 文件读取及计数核对不计为测试执行。

**结论：通过；没有发现阻止收录或 checkpoint 的实质语义冲突。** R69/P2、R70/P3 的范围、恢复、安全边界和独立性一致；Link/MCP 新增正式 0 的正常对照没有被包装成完整提供方或全应用验收。

## 编号、计数和基线归属

README 正式表只读计数为 **70 行、P1=1、P2=47、P3=22**，无重复编号。初始 `validation/reproduction-results.json` 和 latest `validation/latest-a66f4ef2/reproduction-results.json` 各 **72 文件、221 测试、0 skipped、全部 code=0**，与 README、flow、latest-baseline 和 reproductions/README 一致。

逐一阅读第十六轮两基线的四份最终 wrapper/shard 日志：

| 专项 | Bun 文件 | Bun 测试 | Bun expect | wrapper 内另列 |
| --- | ---: | ---: | ---: | --- |
| Project root repair | 1 | 3 | 27 | 无 |
| Settings lifecycle | 1 | 1 | 2 | owned Bun helper 27 手工 assert |
| Link recovery | 1 | 5 | 73 | 无 |
| MCP owner controls | 1 | 1 | 2 | maintained-isolator Node 22 assert |
| 合计 | **4** | **10** | **104** | 不额外增加 Bun 测试/expect |

各基线四日志均有 `Completed Bun shard` 且 0 failures/0 skipped；settings helper 两日志各写 27，MCP native 两日志各写 22。原人工 owner-delay 诊断单列 validation 文本归档，不进入这 4 文件或 10 测试。

四专项前文保留作者原始 latest-only 实验叙述，结尾独立“主审便携复核”明确说明后来在 84740 与 a66f 分别重跑。两 quality 也区分“审计仅阅读收据”与“主审已运行”，因此没有把静态源码 diff 相同冒充作者的双基线执行，也没有把独立审计记为新增测试。后来的主审双基线收据并不与原始 latest-only 相冲突。

## R69：保留 P2，修复不能削弱根权限

归档 fixture 实际挂完整 ProjectGroup/authority hook、真实 Main registration、ProjectStore/SessionCwdIndex/SessionManager，以自有目录 rename 产生真实 ENOENT。选择健康同项目 primary A 的实际 repair button 进入后端；target 在 ProjectStore:358 已通过 mounted 校验，拒绝来自 367→886 对仍登记旧 secondary B 的全 roots preflight。失败发生于 370 owner 分支之前，生产可达证据充分，同时没有动态执行 resident owner 分支。

文稿正确限定：旧 secondary 仍登记且物理缺失、健康 primary、普通 session、cold/no-worker durable 迁移；错误可见，失败没有 state/index 的部分 commit、成功广播、历史或文件删除。没有扩大到全部项目目录修改、dirty worktree、活跃模型或 Windows/network-volume 实测。

恢复原目录到原路径再点实际按钮成功；另一个不恢复旧路径的归档→移除坏 root 登记→恢复→迁移控制仅以真实 Core/Main 服务组合执行。README、flow 和专项都保留了“完整归档/管理/历史 UI 仅静态接线”的限制，未称永远无法修复或只能重启。现有 root_removed 正常控制和新 dir_missing 失败明确区分。

修复建议保留 Main 稳定项目/session/target 身份、健康 target 挂载验证、owner fence/CAS、symlink/identity 防护和成功后广播；没有建议简单删除 requireMountedProjectRoot 或把失效 source 继续授权给 worker。P2 对应正式提供的合法 repair 功能确定被阻断，多步骤且不明显的 service workaround 不使其自动降为 P3。与 R23 Panel 批量空列表、R24 tombstone 后 cold release、R58 renderer 注册根门禁的修复位置和触发独立。

## R70：保留 P3，仅未保存的自定义指令

实际 SettingsPage 自定义指令加载完成后再编辑；同一 blur flush 先清 pending 后异步真实 store 拒写，修复自有文件后不再编辑的 blur/back 都不写，卸载重开旧值。重新编辑后可成功保存，正常离开和原 target capture/cancel 控制通过。

所有整合文稿均限定 `agent.appendSystemPrompt` 未持久化的新稿：当前页面仍能复制或重新输入，不能说旧成功文件被删除、永久 writer 卡死、普通编辑必失败或所有 hook 字段均动态验证。EISDIR 是具体真实故障注入；EACCES/满盘没有分别实测。Bun helper 的 unhandled rejection 没有被称为 Electron pageerror、崩溃或应用退出。

与 R43 同属保存反馈家族，但恢复契约和修复位置独立：TokenTab 显式 Save 保留稿，可同一按钮重试；此 autosave hook 丢失 pending，没有同值 blur/back 重试，需要保留原 target/value 与失败状态。P3 分级与异常存储前提及尚可复制/重新编辑的恢复一致。

## Link 正常对照：实际组件/服务，提供方与 transport 可控

专项和归档脚本一致：实际 LinkConnectionDialog、源码 controller/StepView、native authorization manager、LinkService 与真实 CredentialStore 写 owned 用户存储；Dialog 外壳、window.codeshell transport、token validation/remote catalog、OAuth open handle 是明确替身。主 App、完整 Main/preload/IPC、实际提供方、浏览器 OAuth、CLI 安装均没有被声称动态运行。

五项正常证据仅覆盖启动回包迟到关闭、begin 失败显式重试、已 commit 丢回包后的只读 status 恢复且不重放 secret、正式 cwd key 重挂取消旧 validation，以及 manager 迟到内存 window handle/异 owner 取消保护。项目上下文共用 user store，文稿没有误称多项目可见的新连接为串写；Link CAS/conflict 也没有被混同 R42 Cookie 覆盖。

正文中的“GET 核对”应按这里的 controller `status → window.codeshell.links.authorizationGet` 本地 transport 状态查询理解，**不是本轮另做 HTTP GET/原生 IPC transport 实测**。专项已明确本地 transport 边界，整合摘要也使用组件/service 替身措辞，没有实质过度声明。

## MCP 正常对照：真实认证/HTTP，拒绝人工 owner-delay 缺陷结论

实际 HubAuth setup/login 两个真实本地 cookie、实际 MCP 配置 handler、相同生产 auth/admission callbacks 和 owned loopback HTTP MCP initialize/tools-list fixture 形成协议正常对照。完整 startHeadlessServer、worker、Web UI、真实 MCP 服务/工具或外部账户未运行，四份摘要均保留该边界。

真实请求体未传完的 readJson 等待可达，body abort 不启动 probe；注册后 owner 取消、client 断线后重试、真实 logout owner 隔离均由最终 fixture 和 22个Node手工断言日志（Node v25.8.1）支持。生产 auth owner 当前同步 store/microtask 路径不等于人工 macrotask gate；诊断因此明确剔除，不是“测试通过便认定”的新增缺陷。也未把已接受 run 在 tab 关闭后继续工作泛称泄漏。

guard 描述限于导入前 exact-origin HTTP/fetch、本轮自有资源和 maintained native isolator；不冒称 OS sandbox/direct-net 全面 confinement 或任意 hung 子进程强杀。两基线各22个Node手工断言已包在一个 Bun wrapper test 内，计数正确。

**Completed：最终语义通过；新增测试/实验执行 0，主报告及产品改动 0。**
