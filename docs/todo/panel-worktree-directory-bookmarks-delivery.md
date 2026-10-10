# Worktree 与主项目的目录书签

Desktop Panel 的目录选择、已知项目目录与恢复统一以绑定的主项目保存书签。实际执行目录仍是 worktree；配对 Desktop HTTP 与后台任务使用同一个主项目作用域，能够读取相同书签。

旧 worktree 书签保留原 ID 和原作用域。仅 Desktop Host 在真实 Git 注册、双向指针、commondir 和工作目录身份均通过验证时接受该关联；Hub 默认仍要求精确项目作用域。迁移不会重写旧记录，也不会扫描或开放其他项目。被移除或替换的 worktree、伪造 Git 标记、其他 App／项目和身份变化的输出目录均拒绝恢复。

原生选择器及目录授权每个异步边界重验项目、workspace、Panel 修订、guest 与信任状态。授权失效时不会分配目录 handle 或提交书签。

## 验证

隔离 HOME 的 guarded unit runner 覆盖真实 Git 主项目/worktree、旧记录迁移、原生桥接方法和进程授权异步撤权。另一个独立、先安装精确 origin guard 的实际 Bun/Node 流程通过 Desktop-hosted HTTP、Hub cookie 认证和生产后台任务执行器验证三类书签、精确输出字节与冷启动恢复；它不替代 Electron 配对流程。

`test:e2e:worktree-directories` 通过实际 Electron Main/preload/guest、生产配对 Desktop HTTP 和真实 Node 后台交付验证同一流程，已加入现有真实 Linux SecretService CI。原生目录选择对话框使用受控选择结果，设备使用测试 TrustedDeviceStore 记录，未验证实体手机或 QR 扫码。测试父进程仅运行 Playwright；生产 store 初始化子进程、Main 和工作进程在导入 Core 前安装精确 origin guard。

本机 macOS 验收在真实 Keychain `SecKeychainAddGenericPassword` 的系统授权等待处停止，保留诊断记录，不计为通过；不使用 mock-keychain 代替此结果。最终组合验收以 PR CI 为准。交付为源码集成，安装包与正式发行另行记录。
