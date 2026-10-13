# 第二十三轮 HTTP 错误与文件列表只读预审

2026-10-12 SG07:41；root只读源码、已有报告及测试定义，新增执行0，产品修改0，可信新候选0，正式发现0。初始84740/a66f继续冻结；第22轮docs-only检查点为1d6e09fda42472c146c572cf518c5fc545488268。本文件为第23轮接续材料，不能算新Bun/native完成记录。

## 已核门禁

- Auth JSON reader有8KiB声明/实际流量限制、对象验证、10秒timer和aborted/error收束；fail移除旧reader后保留一次error监听并resume，避免把已断开的request error误当新Host崩溃候选。[reader](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/server/src/hub/auth-http.ts:234)。handler对activeLogins使用finally减计数，未把解析失败留成活跃login。[handler](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/server/src/hub/auth-http.ts:132)。这里只读，不声称本轮动态故障/延时测试通过。
- 配置JSON reader为64KiB和10秒destroy期限，限制声明值与实际字节，JSON非对象/解析失败显式400。[reader](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/server/src/hub/configuration.ts:575)。会话PATCH为8KiB与10秒，读完整body后再次鉴权/owned，再写title或archive；不在解析前写状态。[reader](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/server/src/hub/session-management.ts:419)、[PATCH](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/server/src/hub/session-management.ts:309)。配置/session destroy期限与Auth可回408方式不同本身不构成重要流程缺陷；普通Web请求使用完整序列化JSON，没有发现正常可达的永久挂起。
- Headless HTTP总入口捕获handleHttp拒绝，hubJson对ended/destroyed直接返回；不由异步handler写法直接推定unhandled rejection或header后二次响应崩溃。[总入口](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/server/src/serve/headless-server.ts:767)、[hubJson](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/server/src/hub/uploads.ts:40)。这不是全面证明所有streaming错误都不可能崩溃。
- 目录500/4096上限带truncated，实际HubFiles显示截断提示；目录/预览使用各自AbortController并检查aborted，切目录取消旧preview。已有R65权限/空树及第12/14轮错误/恢复已覆盖，不重复列项。[组件](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/web/app/HubFiles.tsx:65)、[截断提示](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/web/app/HubFiles.tsx:199)。下载header后失败destroy、finally释放打开祖先句柄并移除active response；没有发现此静态路径的额外配额遗留。[finally](/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell/packages/server/src/hub/files.ts:256)。

## 去重与限制

R09启动上传清理、R17附件配额、R20大小限制不一致、R34上传断线、R38logout等待、R65文件权限反馈、R73异步回答lease、R76归档忙状态、R77认证锁同步阻塞均保留，未据本次body-reader正常门禁否定各自已复现条件。没有新增HTTP/Bun/Electron/模型/worker/网络执行，测试定义只用于了解已有断言范围，不能计成新pass。两个其他只读代理继续检查服务端重连资源归属与Desktop启动/深链；其结果未在本报告预先认领。
