# 本地 Sidebar Account 差异只读预审，第 22 轮

Completed。**本轮新增正式发现 0、可信待复现候选 0、新增测试/原生执行 0。** 已读 CODESHELL.md、当前主报告 R01–R80 与 flow-coverage。没有执行产品、单元测试、账号/OAuth/网络/CLI/model；没有 switch/stash/edit/build/clean 原工作区，也未修改主报告、目标或调度。

## 提交与适用范围

原工作区 `/Users/admin/Documents/个人学习/代码学习/codeshell` 只读核对：branch `main`，HEAD `6034df8a3f177609aeab09253bc525b0445ca5ac`，parent `84740d56e55517b004948a0a0e07649ad6fbf998`；首尾 `git status --porcelain` 均为空。该提交标题 `feat(desktop): add persistent sidebar account access`。只读 ancestry 查询确认 `a66f4ef291f304ee4df9da8095a90671d9a8f140` 不是其祖先。

**这份报告仅针对 6034 本地未合入的 6-path 差异，不把结论混入 84740/a66f 两冻结产品快照。** 审阅了完整 diff 及六份 source：Sidebar.tsx、新增 AccountSidebarEntry.tsx、新增 AccountSidebarEntry.fixture.tsx、新增 AccountSidebarEntry.interaction.test.tsx、i18n/ns/settings.ts、CloudAccountSettings.tsx。为验证正式接线，追读了现有 App/ResponsiveSidebar、Dialog、preload cloud-account API、Main IPC/服务组合/manager/store/HTTP adapter；这些关联文件不属于本提交变更。

## 正式入口与 scope 保护

新增入口确实接入产品，而非只有独立组件：App [AppSidebar.ts:1](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/app/AppSidebar.ts:1) 重导出实际 Sidebar，后者在 [Sidebar.tsx:522](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/Sidebar.tsx:522) 将账号入口放在侧栏底部；该位置不依赖项目/会话列表为空与否。AccountSidebarEntry [63](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/account/AccountSidebarEntry.tsx:63) 使用真实 Radix Dialog，97 嵌入原 CloudAccountSettings。账号表单仍可从 user-scope GeneralSection [81](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/settings/GeneralSection.tsx:81) 打开，embedded 默认 false 保留原设置页标题/说明。

“常驻”应理解为侧栏存在时的持久入口，不应扩为任何视图/折叠态始终显示：App [2170](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/App.tsx:2170) 仍受 sidebarVisible 控制，ResponsiveSidebar [36](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/app/ResponsiveSidebar.tsx:36) 对关闭的桌面侧栏返回 null，窄窗走 drawer。这是现有明确布局行为，未据注释措辞把折叠侧栏列成缺陷。

账号是 app-global 的云身份，没有读取当前 project/session 路径；符合组件“本地功能不要求登录、登录不自动共享电脑/项目”的说明。Main [cloud-account-ipc.ts:10](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/cloud-account-ipc.ts:10) 继续要求 live 主窗口、主 frame 和被注册的 Main Window，状态/登录/注册/GitHub/取消/退出均走现有门禁。CloudAccountManager.status [72](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/cloud-account-manager.ts:72) 只向 renderer 投影 state/origin/account id+username；token/receipt 不跨新增入口。没有从侧栏放宽 Panel/popout 权限或项目授权的新路径。

R42 是 Cookie 凭据新增时按 label 合成 credential ID 的碰撞。本提交没有改变那条新增 ID/权限写入链；此处云账号身份来自现有已校验 grant，不能把相同“账号”名称当作 R42 的新实例。

## 初始读取、实时更新与失败恢复

AccountSidebarEntry [22](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/account/AccountSidebarEntry.tsx:22) 先订阅 onStatus，再发初始 status IPC；收到实时事件后设置 receivedStatus，使更晚的初始 resolve/reject 不覆盖它，事件也清除 unavailable。cleanup 同时设置 active=false 并 unsubscribe，抵挡已排队旧 callback 和迟到初始读。CloudAccountSettings [20](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/settings/CloudAccountSettings.tsx:20) 同步采用该保护，并为初始拒绝添加可见 statusLoadFailed 文案。preload 的 unsubscribe [cloud-account-api.ts:12](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/preload/cloud-account-api.ts:12) 实际 removeListener；Main [desktop-remote-services.ts:47](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/desktop-remote-services.ts:47) 对所有注册主窗口广播 identity 状态。没有只依赖一个窗口自己的 form 回包刷新 footer。

只读反证过“footer 初次 status 失败，打开表单成功后 footer 仍 unavailable”的构造：两个组件状态独立，mock 任意 reject 的确可走这个逻辑，但**当前未证明合法生产触发**，故不列候选。Main [index.ts:1023](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/index.ts:1023) 在初始 createWindow [3447](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/index.ts:3447) 前已组合服务、注册 cloud IPC [desktop-remote-services.ts:71](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/desktop-remote-services.ts:71)。合法主窗口 status handler 同步调用 manager.status；manager.load [62](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/cloud-account-manager.ts:62) 捕获读取/解密错误并返回 `storage-error`，不向该 status IPC 抛存储错误。因此不能把“IPC 尚未注册”或“磁盘拒读”直接当成本提交稳定 unavailable 的真实复现。renderer 销毁/非法 caller 的拒绝也不等于仍可操作主窗口的恢复失败。

真正 store 不可用时，footer 有明确“账号存储不可用”投影；表单保留现有 storage-error 退出按钮 [CloudAccountSettings.tsx:174](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/settings/CloudAccountSettings.tsx:174)。manager.logout [330](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/cloud-account-manager.ts:330) 撤销本机 saved 状态，forget 失败仍投影 storage-error 并给出权限修复后重试错误。这里是源码核对，不称实际 chmod/安全存储恢复已跑。

操作失败继续通过原 act helper [CloudAccountSettings.tsx:42](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/settings/CloudAccountSettings.tsx:42) 的 toast/error/finally 反馈并释放 busy；本次额外在成功后的状态读清 statusLoadFailed。正式 renderer root 有 ToastProvider [main.tsx:77](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/main.tsx:77)，其通知层 z60，账号 modal 为 z50，因此不能以独立 fixture 未挂 ToastProvider 的 no-op 行为推断产品静默吞掉登录失败。password 提交即清空、origin/username 保留属于本提交之前的行为；未扩大成新增失败丢稿 finding。

## 取消、关闭与迟到结果

新增 modal 的 Escape handler [AccountSidebarEntry.tsx:89](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/account/AccountSidebarEntry.tsx:89) 阻止 isComposing/keyCode229 的 IME Escape 关闭，普通 Escape/X 则沿真实 Dialog 生命周期关闭表单。DialogContent [dialog.tsx:34](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/components/ui/dialog.tsx:34) 通过 portal/close 组件处理生命周期；窄窗外层 drawer 与账号 modal 各有 Radix layer，源码没有新增 document Escape 监听。未运行原生焦点/IME/窄窗交互，不能把源码保护称成平台 E2E 通过，也没有证据认定嵌套 Dialog 焦点故障。

**关闭账号管理是关闭视图，显式“取消登录”才是取消操作。** 新组件 cleanup 没有自动取消 manager；用户发起 OAuth 后关闭面板、继续在浏览器完成，不能仅因为请求继续就判为错误。重开表单会重新 status 读取/订阅，signing-in 状态继续提供取消。现有显式取消按钮 [CloudAccountSettings.tsx:169](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/renderer/settings/CloudAccountSettings.tsx:169) 走 preload→Main cancelSignIn；manager [325](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/cloud-account-manager.ts:325) invalidate generation、abort 当前 operation，再 publish signed-in/signed-out。

迟到登录结果在 complete [cloud-account-manager.ts:117](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/cloud-account-manager.ts:117) 写盘前检查 generation+authorized，失效结果发起撤销，不覆盖当前账号；GitHub poll 循环每轮同样 current 检查，receipt finally cancel。正常窗口关闭/reload后的 caller/frame 检查仍由 Main 掌握。新侧栏没有把取消变成全局项目停止，也未触发 worker/model。logout 的本地 publish 在远端 revoke 完成前发生，不同于 R38 配对 Web 的本地退出等待黑洞；HTTPS adapter 仍有既有 15 秒 deadline [cloud-account-http.ts:73](/Users/admin/Documents/个人学习/代码学习/codeshell/packages/desktop/src/main/cloud-account-http.ts:73)。这些仅按已有链核对，不宣称真实账号/网络撤销验收。

关闭弹窗使 username/password/origin 的未提交表单 state 随卸载丢弃，重新打开回默认/当前账号状态；源提交没有承诺关闭等价于保存草稿。没有实际操作产生的长期 credential 写入，也没有把普通关闭时清空密码当作丢失既有授权。已提交操作的业务状态仍由 manager/global event 持有，不依赖 modal 常驻。

## 测试审阅与计数

新增 interaction.test.tsx 声明 7 个 child fixture 场景：authentication、github cancel、IME composition、late initial response、late initial failure、unavailable、cleanup。已读 fixture 全文，使用 actual AccountSidebarEntry/CloudAccountSettings/Radix/minidom，但 CloudAccountApi 是 owned 内存 stub，覆盖订阅数、表单动作输入、状态更新、关闭/重开/卸载与迟到 callback。登录/GitHub 没有 real Main/transport/store/OAuth；status unavailable 是 fixture 人工 reject，不能直接证明上述生产异常入口。

**本轮没有运行这 7 个场景，没有取得其新 pass/assertion/Completed 收据。** 不从源码 `test()` 声明计入已执行测试，不借其他任务既有结果说该 local commit 已验证。也没有建立第三 review snapshot，未触碰原 checkout 的产品/依赖/构建。

最终结论：该 6-path 变更的入口、global scope、初始读与事件先后、关闭订阅清理、显式取消 generation fence 和失败 toast 在源码上连贯，未找到足以交 root 申请隔离复现的可信新增候选。保留未执行边界，正式 finding 增量 0；不扩大两冻结快照的结论。
