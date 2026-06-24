# 设计:CC 房间对话视图(历史回放 + resume 常驻对话 + 审批回路 + 合并 rooms)

日期:2026-06-24
状态:设计已批准,直接进实现

## 1. 背景

上一版(cc-orchestrator,已合 main merge 5b2aeb49)做了 Claude Code 面板:列出本项目所有
CC session + 定时驱动。但**点 session 没反应**(列表态占位)。本迭代补上"点进 session →
看历史 → 进常驻对话 → 工具审批 → 手机同步",并**删除旧 rooms 面板**(新面板接管,底层
RoomManager/手机同步复用)。

## 2. 关键技术事实(已实测,当事实用)

裸 `claude` CLI **能做交互式工具审批**(此前误判为做不了)。Happy Coder 的做法:不依赖 SDK,
spawn 裸 CLI 加 `--permission-prompt-tool stdio`,走 stream-json control protocol。

**实测验证(2026-06-24)**:spawn
`claude --print --verbose --input-format stream-json --output-format stream-json --permission-prompt-tool stdio --permission-mode default`,
喂 user 消息要求写文件 → stdout 吐:
```json
{"type":"control_request","request_id":"<uuid>","request":{
  "subtype":"can_use_tool","tool_name":"Write","display_name":"Write",
  "input":{"file_path":"...","content":"..."},"description":"hello.txt",
  "permission_suggestions":[{"type":"setMode","mode":"acceptEdits","destination":"session"}],
  "tool_use_id":"toolu_..."}}
```
往 stdin 回写:
```json
{"type":"control_response","response":{"subtype":"success","request_id":"<uuid>",
  "response":{"behavior":"allow","updatedInput":{...}}}}
```
→ claude 解阻塞、执行工具、`result` 收尾。**进程阻塞在 stdin 等回应 → 天然 backpressure,
不用轮询/ sleep**(对齐 project_background_shell_no_sleep_prompts)。

decision 形态(镜像 SDK):
`{behavior:"allow", updatedInput?}` | `{behavior:"deny", message}`。

坑(Happy 踩过,anthropics/claude-code#52084):远程 ack 但没到宿主会挂死 → **审批必须带超时
兜底**(超时自动 deny)。

## 3. 架构

```
Claude Code 面板(接管并删除旧 RoomsPanel)
├── session 列表(已有)── 点一个 → 选权限档 → 进对话视图
└── 对话视图(新 CCConversationView)
    ├── 历史区(只读):SessionHistory 读 jsonl 最近 N 条 → 渲染,"看更多"往前
    ├── 实时区:resume 常驻进程 stream-json 事件实时渲染 + 输入框
    └── 审批区:approval_request 来 → 弹 allow/deny(桌面)/ 推手机

底层(扩展复用)
├── ResidentAgentProcess(扩展):+--resume +--permission-prompt-tool stdio
│     parse 加 control_request→approval_request 事件;send 加 respondControl 写 control_response
├── ApprovalBridge(新·desktop main):pending Promise map(按 request_id)+超时兜底
├── RoomMeta(扩展):+claudeSessionId? 字段(permissionMode 已有)
├── RoomManager(扩展):openForSession(claudeSessionId,cwd,mode);并发不变量=一 session↔一活跃进程
├── SessionHistory(新·core):读 jsonl→最近 N 条结构化消息(复用 discoverSessions 解析风格)
└── 手机同步:复用现有 messages.jsonl + WebSocket;审批请求也走这条推手机
```

复用 vs 新建:RoomManager/ResidentAgentProcess/手机同步=扩展;ApprovalBridge/SessionHistory/
对话视图 UI=新建;旧 RoomsPanel=删。

## 4. 数据流(点 session→审批往返)

```
① 点 session(claudeSessionId)→ 弹权限档选择 → ccRoom.openSession(claudeSessionId,cwd,mode)
② main:
   a. SessionHistory.readRecentHistory(cwd,claudeSessionId,N) → 历史区渲染(只读)
   b. RoomManager.openForSession:并发不变量(已活跃则复用)否则 spawn resident
③ 输入 → ccRoom.send → 写进程 stdin(user)→ stream-json 事件 → 实时渲染 + 落 messages.jsonl
④ 敏感工具(default 档):
   stdout control_request → ResidentAgentProcess → approval_request 事件 → ApprovalBridge
   → pending.set(request_id) + 推 UI/手机 → 用户答 → ccRoom.respondApproval
   → ApprovalBridge.resolve → respondControl → 写 control_response stdin → claude 续
   → 超时(默认 5min)未答 → 自动 deny + 清理 + 通知
```

## 5. 单元契约

### 5.1 ResidentAgentProcess(扩展)
```ts
interface ResidentAgentOptions {
  command: string; cwd: string;
  resumeSessionId?: string;                       // 新增 → --resume <id>
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  onEvent: (e: ResidentAgentEvent) => void;
}
// ResidentAgentEvent 新增:
//   | { type:"approval_request"; requestId:string; toolName:string; displayName?:string;
//       input:unknown; description?:string }
respondControl(requestId: string, decision:
  { behavior:"allow"; updatedInput?: unknown } | { behavior:"deny"; message:string }): void;
// spawn args 加:--input-format stream-json(已有)+ --permission-prompt-tool stdio
//   + resumeSessionId 时 --resume <id>
// parseStreamJsonLine 扩展:type==="control_request" && request.subtype==="can_use_tool"
//   → approval_request 事件(其余 system/init/hook 仍忽略)
```

### 5.2 ApprovalBridge(新·desktop main)
```ts
type ApprovalDecision = { behavior:"allow"; updatedInput?: unknown } | { behavior:"deny"; message:string };
class ApprovalBridge {
  constructor(opts: { timeoutMs?: number; onPush:(roomId,req)=>void });
  request(roomId, requestId, payload): Promise<ApprovalDecision>;  // 存 pending+推+超时
  respond(roomId, requestId, decision): boolean;                    // resolve+清 timer
  // 超时默认 deny({message:"approval timed out"}),清理,onPush 通知
}
```

### 5.3 SessionHistory(新·core/cc-orchestrator)
```ts
interface HistoryMessage { role:"user"|"assistant"; text:string;
  tools?:{name:string;summary:string}[]; ts?:number; }
function readRecentHistory(cwd, sessionId, limit, claudeHome?):
  { messages: HistoryMessage[]; hasMore: boolean; totalCount: number };
// 读 ~/.claude/projects/<encoded>/<sid>.jsonl;取末尾 limit 条;hasMore=还有更早的
// 解析 user(content str|array)/assistant(content array 含 text/tool_use)
// 跳过 caveat/command 噪声(复用 session-discovery 的过滤)
```

### 5.4 RoomManager(扩展)+ RoomMeta
```ts
interface RoomMeta { /* 已有字段 */ claudeSessionId?: string; }   // 新增
openForSession(claudeSessionId: string, cwd: string, mode: RoomPermissionMode): { roomId: string };
// 查现有 room(按 claudeSessionId 匹配)→ 有则复用 open,无则 createRoom+绑 claudeSessionId
// 并发不变量:this.agents map 已保证一 room↔一活跃进程;按 claudeSessionId 去重房间
// onAgentEvent switch 加 case "approval_request": 转 ApprovalBridge + append(type:"approval")
```

### 5.5 IPC(扩展 ccRoom)
```
ccRoom.openSession(claudeSessionId, cwd, mode) → { roomId }
ccRoom.send(roomId, text)
ccRoom.respondApproval(roomId, requestId, decision)
ccRoom.readMoreHistory(cwd, sessionId, offset, limit) → { messages, hasMore }
ccRoom.closeSession(roomId)
事件:onRoomEvent(cb)(实时流)、onApprovalRequest(cb)
```

## 6. UI(CCConversationView·desktop renderer)

shadcn + Tailwind(遵 desktop CLAUDE.md)。从 CCRoomView 点 session → 弹权限档选择(shadcn
Dialog/Select)→ 进 CCConversationView:
- 顶:session 短 id + 权限档 + 关闭。
- 历史区(只读,灰底):最近 N 条 HistoryMessage,顶部"看更多"。
- 实时区:房间事件实时流(text/tool/tool_result/turn_end)。
- 审批:approval_request 来 → inline 卡片或 Dialog,显示 toolName/description/input 摘要 +
  Allow/Deny 按钮(+ claude 给的 permission_suggestions 可选"本会话切 acceptEdits")。
- 底:输入框 + 发送。

## 7. 明确不做(YAGNI / 本版外)

- 不嵌 Claude Agent SDK(裸 CLI + stdio 控制协议够用,避免重依赖)。
- 不做审批的"记住选择/持久 allow 规则"(updatedPermissions);本版只 allow/deny 单次。
- 不做历史的全量回放(只最近 N 条 + 看更多)。
- 手机端审批 UI 本版尽量复用现有 WebSocket 推送通道;手机交互细节若超范围,先桌面审批可用,
  手机审批推送下一迭代(但推送通道复用,不另起)。

## 8. 落地后真机验证

1. 点 session → 选 default 档 → 实时区让它写文件 → 审批卡弹出 → Allow → 文件真写、对话续。
2. Deny → claude 收到 deny、不执行、继续对话。
3. 审批超时(5min 不点)→ 自动 deny、不挂死。
4. 历史区显示该 session 最近 N 条且正确(中文路径项目也行);"看更多"往前加载。
5. resume 续接:实时区第一句后 claude 记得历史上下文。
6. 并发:同一 session 桌面已开,再点不重起(复用);手机/桌面不打架。
7. 删了旧 rooms 面板后,手机端仍能用(底层 RoomManager 在)。
