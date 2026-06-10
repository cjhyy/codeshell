# 手机/平板遥控 UI — 能力清单(对齐桌面端,成熟度目标)

- 日期:2026-06-10
- 目的:把"成熟手机页面"拆成可勾选的能力项,逐项实现。来源:桌面 renderer 真实面 + preload RPC(`agent/*`)+ sessions-service + 房间模型。
- 配套:`2026-06-10-mobile-ui-react-rebuild-design.md`(架构)、`...-rebuild.md`(计划)。

> 通路前提(已确认):`broadcastRaw` 把桌面 renderer 同款 JSON-RPC 流镜像给手机;手机动作经 `handleMobileClientEvent` 注入同款 worker 消息。所以多数能力是"补手机 UI 消费面 + 少量新协议",不动 core。

## A. 连接 / 身份(已部分,要做成熟)
- [x] A1 配对(扫码 token)+ 设备密钥(原样 secretHash,**不 hash**)
- [x] A2 重连(指数退避)
- [ ] A3 连接状态机 UI:连接中/认证中/未配对/在线/断开,清晰反馈(shadcn)
- [ ] A4 退出登录(清 deviceId,回配对页)
- [ ] A5 设备名展示

## B. 会话(核心缺口:看到桌面所有 session)
- [ ] B1 `session.list`:拉桌面真实会话(listDiskSessions:id/title/cwd/updatedAt/origin)
- [ ] B2 会话列表 UI:标题 + cwd basename + 相对时间 + origin 标(automation 标)
- [ ] B3 进入某会话:`session.history` 拉 transcript → streamReducer 回放
- [ ] B4 进入后接实时流(broadcastRaw 已发;按 sessionId 过滤)
- [ ] B5 新建会话(session.create,已有协议)
- [ ] B6 当前会话指示(顶部 session 名/cwd)

## C. 聊天 / 运行
- [x] C1 发消息(chat.send,已有)
- [ ] C2 消息流渲染:user 气泡 / assistant(text + reasoning 折叠)/ 工具卡(start+result)/ 工具摘要 / 系统错误
- [ ] C3 Markdown 渲染(复用 renderer 已装的 react-markdown + 代码高亮?——评估包体,初版可纯文本+等宽)
- [ ] C4 运行状态条:idle/running/waiting/completed/error(对齐 RunState)
- [ ] C5 停止运行(run.stop,已有协议)
- [ ] C6 输入框:autosize、Enter 发送(宽屏)、发送中禁用
- [ ] C7 流式增量平滑(高频 text_delta 批量 flush 不卡)

## D. 权限审批(核心:手机弹窗允许,等同桌面)
- [ ] D1 审批卡:toolName + description + 摘要(command/file_path/…)+ 风险 badge(high 红醒目)
- [ ] D2 approve / deny(approval.respond,已有)
- [ ] D3 deny 带理由(可选输入)
- [ ] D4 approve 作用域:once / session / project(对齐 desktop approve 的 scope)
- [ ] D5 路径作用域:file / dir / tool(对齐 pathScope;仅路径类工具显示)
- [ ] D6 AskUser 型审批:选项按钮 / 自由输入(answer);optionsOnly 时禁自由输入
- [ ] D7 等待审批时运行状态条转 waiting + 顶部提示

## E. 目标 / 子代理 / 后台(桌面有,手机补)
- [ ] E1 goal_progress 状态行(轮次/状态;display-only)
- [ ] E2 goalExtend(延长目标:加轮次/预算)——按钮(agent/goalExtend)
- [ ] E3 子代理状态行(agent_start/end + task_update,按 agentId 隔离;只读)
- [ ] E4 后台 shell 列表 + 输出查看 + kill(agent/backgroundShells)——P1,评估

## F. 能力控制
- [ ] F1 权限模式查看 + 切换:default/acceptEdits/bypassPermissions(新协议 permission.setMode;bypass 醒目确认)
- [ ] F2 模型查看 + 切换(agent/configure model;新协议 model.set)——P2
- [ ] F3 planMode 开关(run 带 planMode)——P2,评估

## G. 房间(手机专属,UI 重做)
- [x] G1 协议全(list/projects/create/open/close/send/history)
- [ ] G2 房间列表 UI:名 + cwd + 权限 badge(bypass 红)+ 在线/状态
- [ ] G3 新建房间(选 project:room.projects)
- [ ] G4 进出房间 + 历史回放(room.history)+ 实时(room.message)
- [ ] G5 房间内发消息(room.send)
- [ ] G6 关房间(room.close)

## H. 布局 / 成熟度(平板兼容)
- [ ] H1 单列手机布局 + 安全区(env(safe-area-inset-*))
- [ ] H2 平板两栏(≥820px:左 会话/房间 栏 + 右 聊天)
- [ ] H3 顶栏:品牌 + 在线状态 + 会话/房间切换入口 + 设备/退出
- [ ] H4 抽屉:窄屏会话/房间列表走抽屉,宽屏常驻左栏
- [ ] H5 暗色(沿用 renderer token);触摸目标 ≥44px;tap-highlight 去除
- [ ] H6 空态 / 加载态 / 错误态(各页)
- [ ] H7 滚动:新消息自动贴底(除非用户上滚)

## I. 工程
- [ ] I1 lib 单测(已:device/storage/pairing/risk/streamReducer 27 测)
- [ ] I2 新协议 type 两端共享(@protocol)
- [ ] I3 mobile tsc + build:mobile 全绿
- [ ] I4 删 mobile-ui.ts(全切静态后)
- [ ] I5 真机/平板冒烟(需用户;留清单)

## 优先级
- **P0(必做,本轮)**:A3-A5、B1-B6、C2-C7、D1-D7、E1、E3、G2-G6、H1-H7、F1、I1-I4。
- **P1**:E2、E4、F2。
- **P2/评估**:C3(markdown 包体)、F3、原生 push。

---

## 完成状态(2026-06-10 本轮)

**已做并验证(tsc + 45 mobile 单测 + renderToStaticMarkup 渲染冒烟 + 浏览器 boot 冒烟 phone/tablet 零错误 + 642 全仓测试绿):**
- A1-A5 连接/身份(useRemoteSocket 态机 + 退出登录 + 设备名)
- B1-B6 会话(session.list/history 协议+main+UI;进桌面会话回放;新建;当前指示)
- C1-C2、C4-C6 聊天(user/assistant/reasoning/工具卡/子代理/错误流;运行态;停止;composer)
- D1-D6 审批(工具/描述/摘要/风险红;允许拒绝;deny 理由;scope once/session/project;
  pathScope file/dir/tool;AskUser 选项+自由输入+optionsOnly)— 端到端协议对齐核实
- D7 等待态(StatusBar waiting)
- E1 goal 横幅;E2 延长目标(按钮,默认 +100 轮);E3 子代理行(按 agentId)
- F1 权限模式切换(default/acceptEdits/bypass + bypass 二次确认);F2 model.set 协议+main(无 UI)
- G2-G6 房间 UI(列表/权限 badge 危险红/从项目新建/进出/历史回放/发消息/关)
- H1-H7 布局(单列+安全区/平板 820px 两栏/顶栏/抽屉/暗色 token/空加载错误态/自动贴底)
- I1-I4 工程(lib 单测/协议 @protocol 共享/双 tsc+build 绿/删 mobile-ui.ts 690 行)

**未做(留给后续/需用户):**
- C3 Markdown 渲染(评估包体后;现为纯文本+等宽 pre,代码可读)
- C7 流批量(React key 稳定已是主要护栏;未测出卡顿,YAGNI)
- E4 后台 shell 查看/kill(协议未接,P1)
- F2 model UI / F3 planMode(P2)
- I5 真机/平板冒烟:需用户手机+桌面 Electron 跑起来扫码实测(浏览器 boot 已冒烟,
  WS 链路需真 main)。清单见 2026-06-06 §10.3。
