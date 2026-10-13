# 第二十六轮：云账号登录、取消与退出静态核查

当前正式85项、通用85文件250测试。此稿只读取84740/a66f冻结源码、既有测试与构造关系；新增产品import、fixture、网络、账号、OAuth、模型、worker、Electron和动态执行均为0。未修改产品或主报告；不把读到测试代码当本轮通过结果。

未确认独立新缺陷。以下是正常门禁与未验证边界，不升级为正式项：

- 实际 Settings 入口为 CloudAccountSettings.tsx:20–40、44–48、115–149；busy或signing-in禁用重复动作，act成功后重读status；失败给toast，finally清busy。password在发请求时清空属于明确UI策略，没有从普通登录失败就声明凭据丢失缺陷。页面取消通过preload/cloud-account-api.ts:10进入真实cancelSignIn；IPC cloud-account-ipc.ts:10–15验证活主窗口与mainFrame，signIn/GitHub/link以实时allowed回调继续验证。
- CloudAccountManager.invalidate:87–92推进generation、abort旧operation、清refresh引用；complete:111–135验证grant、current代与授权，才存盘并发布。晚到的有效grant触发异步revoke，而不是恢复已取消登录。github:245–321固定GitHub HTTPS授权路径、PKCE挑战、receipt和期限，poll与sleep均绑定本次signal；cancelSignIn:325–329发布当前saved状态。没有从任意deferred Promise延迟构造一次自然UI串错账号的结论。
- Desktop logout:330–354在任何await网络前invalidate、saved=undefined并forget/publish signed-out，之后才retireRelay和revoke。与R38配对Web等待HTTP后才本地退出不同，不能复制该finding。撤销失败明确返回‘本机已退出；服务端未确认撤销’；存储拒写进入storage-error，不能声称已成功擦除持久状态。
- 默认cloud-account-http.ts:29–76只做固定HTTPS origin的有界JSON请求，无redirect/cookie继承；每请求15秒deadline及16KiB响应界限。logout可能先refresh再logout，不把单请求15秒当整个退出流程总上限。Settings的busy在远端确认期间仍保留，这里没有证明取消按钮能提前结束logout，也没有因此直接升级反馈问题。没有运行真实HTTP超时或Electron按钮行为。
- getCredential:356–431绑定精确origin/account；refresh singleflight并先保存后交付，generation/current及saved对象阻挡晚到刷新。401/403走logout，临时network错误保留账号。logout记录在途refresh用于撤销旋转token，不能仅从invalidate清Promise就推出旋转授权泄漏。具体下游relay的所有native时序没有本轮动态验收。
- desktop-remote-services.ts:40–71实际构造store/manager/controller，把retireRelay连至retireAccountRelay并向存活窗广播状态。cloudAccount:status同步读取manager状态，没有发现异步磁盘加载主动覆盖后来广播的必要窗口；不按R29旧项目异步快照直接套用。
- 既有cloud-account-manager.test.ts:126–181、238–310覆盖singleflight、晚到refresh/login、撤销不确定、GitHub cancel等使用受控transport的正常断言。此轮只读，未复跑、未增加测试数、也未将这些替身当真实GitHub或服务端行为。没有访问operator账号、secret或持久HOME。

[源码hash收据](cloud-account-static-round26.sources.json)比较10个相关文件，两冻结基线均字节相同；属于read-only来源比较而非import/cachegraph证明。当前正式85/250不变，新增finding0/执行0。

独立只读[质量结论](cloud-account-quality-round26.md)与[原稿](validation/original-session-continuation-round26/cloud-account/report.md)保留；当前正式85/250不变。
