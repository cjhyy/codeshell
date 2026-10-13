# Round26 Hub export 独立静态预审

审查冻结产品树 84740d56 与 a66f4ef2。当前父任务正式 banner 为 85 findings / 250 tests；此稿不改变计数。已读 CODESHELL、审查 README、第十二轮 transfer 正常控制、第十八轮 Hub session operations 及独立质量稿。新增 fixture、产品 import、模型、worker、provider/coding CLI、构建安装、网络、Git subprocess 与动态产品验证均为 0；仅源文件/文档读取与本 `/tmp` 稿件写入，产品及主报告未改。

**结论：未发现可信且独立于现有项的 Hub export 新候选。** 下载错误在 Hub React 内没有 fetch callback/toast；其实际浏览器错误呈现尚未运行，不能仅凭这一形式声明静默成功、错误文件或历史损坏。R76 的 follow-up running 投影缺口已覆盖同一个 export admission 来源，不另编号。

## 1. 真实入口与固定请求身份

- `packages/web/app/Workbench.tsx:871–879` 在 history view 使用实际 HubSessions，key 为 `${controller.workspaceKey}:history`。`HubSessions.tsx:440–453` 普通静止行展开导出菜单，以该行 **entry.sessionId** 构造两个 `<a download>`。
- `HubSessions.tsx:45–46` 先 `encodeURIComponent(id)`，格式只有 literal markdown/json，进入 `apiUrl`。`packages/web/app/api-context.ts:54–72` 将当前 workspace 编进 query，将项目 UUID 编进 `/p/:id`；完全 scoped URL 以后保持原样。真正被点击的 href 是已构造字符串，不是响应完成时从活动会话重取目标。
- Desktop 配对管理页的工作区在子视图 passive fetch 前通过 layout effect 设置（`packages/web/app/DesktopApp.tsx:142–151`）。Cloud 项目切换先设置 project scope（`ProjectsGate.tsx:103–111`），项目/generation 使用 keyed subtree（`:286–296`）。没有找到“已发出 A 导出请求，B 被选中后把 A 响应写进 B 聊天”的 callback：导出是浏览器下载，React 的 read/write refs 用于列表和 PATCH/标题读取，不消费 export response。
- 下载使用同源 Cookie；`packages/web/app/auth.ts:10,88–99` 明确配对 WebSocket 认证后换取 Desktop HTTP session，`api-context.ts:54` 明确 assets/downloads 与 HTTP/WS 使用相同 project。不能错误要求原生 `<a>` 携带 `api()` 设置的自定义请求头，因为 workspace 已在 URL query。

## 2. 配对 Desktop 与 Cloud 服务入口

**配对 Desktop**：`packages/server/src/desktop-web/http-api.ts:94–110` 从 header/query 读取 workspace，拒绝重复 query 或不一致 header。`:429–443` 经过 paired principal 与 resolveWorkspace，保存本次 token/session/input/cwd/generation，再选择 cwd 对应服务；`:288–294` 的 history 就是真正 createHubSessions。其 `isAuthorized` 在 `:236–248` 再校验原 token/session、generation、设备及相同 resolved cwd，resolver await 后重复检查。设备撤销/host close 会销毁 session-owned responses（`:195–212,353–361`），不是沿当前 UI workspace 重新选一个目标。

**Headless/Cloud runtime**：primary `packages/server/src/serve/headless-server.ts:642–654` 为固定 workspace/sessionRoot 构造实际 createHubSessions；`:716–740` 先认证、校验 origin、排除 closing 并追踪响应，再路由 history。latest 相关代码有无关新增的行偏移，不把 primary 行号冒充 latest 行号。

**Cloud 项目 proxy**：`packages/server/src/project-runtime/proxy.ts:181–241` 将 lease 固定为 session/project/generation/target，`:132–139` response 前重新 resolveTarget 并检查同一代；`:398–410` 请求与响应使用该 lease。`:47–63,459–467` 保留 content-disposition 和 content-type、状态码，强制 no-store 后 pipe；`:377–397,474–480` 在 abort/error/未完成 close 时取消 upstream 并移除 active entry。这里未看到将 A 的结果改接到后来选中的 B 项目的路径。

## 3. 服务端目标与存储正常门禁

`packages/server/src/hub/session-management.ts:254–300`：

1. 首次授权后解析固定 path sessionId；非法 URL encoding 返回 400（`:266–272`）。
2. owned（`:161–178`）读取同 ID 的有界 state，要求 `state.sessionId === requestId`、resolve(cwd) 等于服务的固定 cwd、非子会话、非 ephemeral。无法证明所有任意外部进程重写存储都安全，但源码没有以 renderer 当前活动 ID 替代 path ID。
3. 普通 running=true 返回 409（`:280–281`），同时最多两个 admitted exports（`:282–285`）。
4. 同步、有界、只读读取 transcript，随后只接受 markdown/json（`:286–289`）。读取 state 的 1MiB 与 transcript 的 32MiB 界限见 `:18–19,135–142,107–128`。
5. 构建原会话的 title/state/transcript 或 Markdown，正文仍受 32MiB 检查；发送前再次授权（`:290–300`）。成功以固定 sessionId 文件名、正确内容类型、attachment/no-store/nosniff 发送（`:301–308`）。ID 的 safe regex 无引号/换行，不能从这里推 filename header 注入。

底层 `boundedSessionFile :42–103` 校验目录类型与 inode，O_NOFOLLOW 打开，拒绝非普通文件，限制 fstat size，固定已核前缀分配并读取，再核对目录/文件 inode；文件句柄 finally 关闭。`readHubTranscript :111–128` 仅允许丢弃最后一个没有 newline 的半行；损坏内部记录返回 422，不自动重写/修复源记录。

HTTP 失败统一返回实际错误状态和 JSON（`:341–357`）；export admitted 后所有退出路径均在 finally 释放 activeExports（`:358–359`）。只读 export 分支没有 saveState/rename/PATCH/onChanged 调用。response 生命周期由 `packages/server/src/session-http-responses.ts:7–32` 追踪至 finish/close，并可按认证 session 销毁；未从 handler return 时刻推断下载已完整完成。

## 4. 去重、未验证边界

- 第十二轮 `docs/review-2026-10-12/transfer-round12.md` 已有两基线正式正常控制：三次非法格式 400 后合法 200、普通显式运行 export 409、内部坏行 422 保留原字节并可受控修复后导出、archive/restore 后原消息可 resume。本次没有复跑、没有把旧 5 tests/136 expects 加进新增计数。
- R76：第十八轮文档明确同一个 Host isRunning 漏登记 async-answer follow-up，export 也使用该来源；已有作者刻意不声称 follow-up 导出内容损坏。本稿也没有此动态证据，不把同一 gate 另报。
- R39：已恢复后 busy 导致多一次导航确认，与原生 export download response 不同；本文未操作 restore/open，也不推翻旧 finding。
- 原生链接的 401/413/422/429/500 如何呈现在 Chrome/Electron 下载 UI，本次没有运行。服务错误 JSON 没有成功 export 的 attachment header，也没有成功 toast；仅看缺少 Hub 内 toast 不足以确认一个新的错误反馈缺陷。
- 读取 state/transcript 与随后 title await 不是跨文件事务。源码提供有界前缀快照，不保证任意外部 writer 的全局原子快照；没有把这种一般并发可能性或 R76 已知 running 缺口扩成历史损坏。
- 未运行浏览器真实下载、取消、native DownloadItem、HTTP/WS、完整 App/worker/Engine 或模型；没有借静态 source 与已有测试源码声称本轮动态通过。

## 5. 双基线一致性

只用 Python 标准库 read_bytes/hash 比较：HubSessions、api-context、auth、Workbench、ProjectsGate、DesktopApp、server hub/session-management、desktop-web/http-api、session-http-responses、project-runtime/proxy 共 10 文件在两个冻结树逐字节一致。headless-server 仅按 primary 精确行号说明入口，未把其整文件声明相同。

本稿新增动态验证 0；可信独立新候选 0；正式新增 finding 0。
