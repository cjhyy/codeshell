# 后台 Shell 的资源回收

后台 Bash 现在接管 sandbox spawn target 返回的 cleanup：同步启动失败立即回收，实际 ChildProcess `close` 后回收成功启动持有的资源，每个 cleanup 最多执行一次。异步 `error` 不代表进程与管道已经结束，因此不会提前释放资源。

Node 在 ENOENT／EACCES 等无 pid 启动失败时仍会异步发送 `error`。现在在检查 pid 前安装错误与关闭处理，避免错误没有监听器而终止宿主。既有后台任务状态、自然退出、取消和 Session 关闭语义保留；普通 Run abort 不会隐式终止明确启动的后台任务。

## 验证

隔离 HOME 的 guarded Bun wrapper 构建真实 Core/Bash 源码闭包，再用实际 Node 执行 ENOENT、EACCES、同步 spawn 参数错误、自然非零退出、继承管道、live error、kill 和 Run abort／Session teardown。实际 ChildProcess close 与 cleanup 次数独立记录，透明 errorMonitor 不代替生产 error listener。旧源码的真实 Node 未处理错误与 cleanup 丢失有失败记录。

夹具的第八项验证实际 live 后台任务的协作收尾：禁止新任务、释放继承管道 gate、通过当前 manager 关闭任务并等待所有已观察 ChildProcess close。外层超时先请求这一流程；不能确认则保留 unknown，不凭历史后台 PID 补杀。网络 guard 在首个 Core 导入前拒绝 HTTP/fetch；这不构成 OS/raw socket 沙箱。

实际验收使用 POSIX 的执行权限和进程组；Windows 保留现有 portable manager 和真实 win32 CI 覆盖，不把 POSIX 夹具结果等同 Windows 验收。源码集成与安装包发行分别记录。
