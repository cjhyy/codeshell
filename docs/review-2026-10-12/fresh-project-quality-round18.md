# 第十八轮：R37离线新建与fresh native项目身份独立反证

Completed。主审只读生产代码、第三轮fixture、原始和latest最终收据；新增测试/进程/模型/网络实验0，新增正式发现0。保留R37/P2，限定由同一设备刚新建、未首轮落盘的native Session，不扩大为所有离线切项目或已保存会话。原始与latest源码关键7文件diff为空；双基线动态结果来自既有第三轮5测试43断言的日志，本轮不重复累计。

## 正式入口和保护

实际手机版入口挂DesktopApp，DesktopControls [163](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/DesktopControls.tsx:163)的项目root按钮没有online禁用或handler拒绝；DesktopApp [293](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/DesktopApp.tsx:293)将该参数交实际controller wrapper，更新workspaceOverride/本地draft并调用useRemoteApp.newSession。第三轮fixture调用的是renderSidebar返回的这个真实app action，**没有点击完整DesktopControls DOM/native手机界面**；正式按钮到action是源码衔接，没有误用零参数的当前项目newSession。

useRemoteApp [1457](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/src/hooks/useRemoteApp.ts:1457)不检查online；先清boundSession、更新目标项目/CWD，再发session.create，未处理send=false。正常sendChat [1270](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/src/hooks/useRemoteApp.ts:1270)确实拒绝offline，所以影响不是离线当场执行；它在**重连恢复online后**才发生。pendingCreate没有保存完整待重发目标，连接恢复仅room/projects和已有bound session resync，原B create不会补发。

生产设备状态由orchestrator [291](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote-orchestrator.ts:291)按device保留；viewer退役只撤命令/恢复grant。handleClientEvent [295](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote/handle-client-event.ts:295)优先显式sessionId→旧device selectedSessionId，chat.send [354](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote/handle-client-event.ts:354)按新请求空ID落入旧A。session.create只mint设备状态和ACK，不执行模型/落Core state，因此A在发首条任务前保持未持久化是正常可达状态。

MobileExternalRuntimeCommands [56](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/mobile-remote/external-runtime-commands.ts:56)保留正确保护：已持久化native会话若无当前viewer accepted selection，分类到受保护路径，prepare拒绝；已经退休的external producer身份也不因磁盘删除回落native。唯有newlyMintedNative && !exists的fresh例外可以不要求旧viewer grant；chat handler传sessionId===st.sessionId正好满足这个例外。生产测试external-runtime-commands.test.ts:394同时断言existing native需当前selection、fresh-device-native仍开放；本轮只读该测试，未声称重跑。

## 既有动态证据和边界

[第三轮fixture](reproductions/web-round3/mobile-lifecycle-review.test.tsx)第四项实际useRemoteApp/Desktop controller→实际handleClientEvent→实际MobileExternalRuntimeCommands→实际prepareAgentRunMetadata。A/B自有健康目录且注册/信任解析为测试适配器，metadata校验本体和workspace context执行；Socket、设备状态/host context、worker bridge是明确替身，没有真实浏览器WS重连、ProjectStore注册服务、完整Main/worker/Engine/model。它止于真实metadata校验后的agent/run请求和受控runAccepted，不是实际编辑文件或执行模型。

[原始最终日志](reproductions/web-round3/mobile-lifecycle-review.test.tsx.log)与[latest最终日志](validation/latest-a66f4ef2/repro__web-round3__mobile-lifecycle-review.test.tsx.log)均有OFFLINE_CREATE_WRONG_PROJECT：手机显示B、重连create帧0、出站agent/run为A且realMetadataValidation=true；文件总5/43为五个不同既有发现共享，不给R37再加5测试。源码diff一致不能代替这些已记录的双基线运行。

P2依据是普通操作可以把用户明确为B写的首条纯文本送到A的合法执行上下文。未证明越权访问、恶意根绕过、未提交数据删除、真实模型副作用或任意已保存session误执行，均不得加进影响。设备刚新建A未发第一轮→断线→B新建→新viewer恢复→发送是较窄窗口，仍不是攻击或直接调用私有方法的假触发。

## 恢复与修复

在线后再次正式选择B新建，等待其create ACK后再发，可恢复目标身份；此恢复接线是源码依据，本轮没有新增点击/运行。若错误任务已经派发，修正当前选择不撤回旧副作用；既有Stop/历史仅是相邻能力，不能声称能自动撤销或找回内容。没有永久不可恢复结论。

建议禁用需要服务端确认的离线新建，或持久保留完整create意图，并在同意图ACK前阻止首条发送。消息应绑定已确认的create/session身份。保留server fresh-native bootstrap及已存会话/producer/根权限保护，不应为修B创建丢包而放宽旧selection authority。

与R33创建ACK前背景stream抢绑定独立：R37不需要任何背景stream；与R03/R41不确定回执独立：缺的是创建目标确认，而不是已接收聊天任务的去重或离开保护。R04/R55迟到导航、R72归档marker也不是同一修复点。本轮无需新增表征或改变分级。

**Completed：保留R37/P2；正式新增0、执行新增0。**
