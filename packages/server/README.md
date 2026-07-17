# @cjhyy/code-shell-server

CodeShell 服务端传输层（纯 Node、零 Electron）：mobile remote 的 HTTP/WS host、配对、passcode 门、tunnel、rooms、上传，以及 **headless 无账号 Web host（`code-shell-serve`）**。

## 聚焦入口

宿主代码应选择职责最窄的稳定入口：

| 入口                                     | 职责                                                              |
| ---------------------------------------- | ----------------------------------------------------------------- |
| `@cjhyy/code-shell-server/storage`       | 磁盘 Session、附件暂存、图片探测和稳定 client-message ID          |
| `@cjhyy/code-shell-server/worker`        | 与传输无关的 stdio worker 生命周期和行协议桥接                    |
| `@cjhyy/code-shell-server/mobile-remote` | 配对、访问门禁、rooms、上传、LAN/tunnel host 和移动端协议类型     |
| `@cjhyy/code-shell-server/serve`         | Headless HTTP/WebSocket host 与 `code-shell-serve` CLI 组合默认值 |

```ts
import { listDiskSessions } from "@cjhyy/code-shell-server/storage";
import { RemoteHostManager } from "@cjhyy/code-shell-server/mobile-remote";
import { WorkerBridgeCore } from "@cjhyy/code-shell-server/worker";
```

包根入口仍是四个入口的兼容并集。新消费方应避免根入口，以免只使用 storage
或 transport 时也求值无关的宿主组合。

`/storage`、`/worker` 和 `/mobile-remote` 没有 Coding/Web 静态导入。外部
Agent 策略由产品宿主通过 `ResidentAgentOptions.appendSystemPrompt` 注入。
`/serve` 则是有意保留的开箱即用产品入口：CLI 被调用时解析 Coding stdio
worker 和已构建的 Web app。

## code-shell-serve — 无账号 Web host

在任意机器上把一个 workspace 变成浏览器可访问的 CodeShell：

```bash
# 构建（repo 内）：core → coding → server → web app
bun run build && bun run --cwd packages/web build:app

# 启动
node packages/server/dist/bin/code-shell-serve.js \
  --cwd ~/work/my-repo \
  --port 8790 \
  --passcode <你的口令>     # 省略则首次启动生成随机口令并打印一次
```

浏览器打开 `http://127.0.0.1:8790`：输入口令（记住 cookie 后不再询问）→ 会话列表 / 新建对话 / 流式输出 / 工具审批 / 停止。

### 架构

```text
浏览器 SPA（packages/web dist-app，说 core JSON-RPC 协议）
   │  WS /ws（passcode/cookie 门禁）
headless serve（本包 serve/）
   │  stdio line-JSON-RPC（WorkerBridgeCore：按需 spawn、崩溃记账）
agent-server-stdio worker（@cjhyy/code-shell-capability-coding）
```

- 浏览器是 core 协议的一等前端（`agent/run` / `agent/streamEvent` / `agent/approvalRequest` / `agent/approve` / `agent/cancel`），serve 只是一根经过认证的薄管道；所有已认证 tab 看到同一条事件流。
- **访问控制只有 passcode + remember-cookie**（决策见 TODO 约束边界「服务端部署不做账号体系」）：scrypt 哈希存储、防爆破锁定、轮换口令使所有旧 cookie 失效。无注册登录、无多用户。
- 默认只绑 `127.0.0.1`；`--host 0.0.0.0` 暴露到局域网是运维者的显式选择。公网建议走反向代理/tunnel 终结 TLS。
- 会话持久在磁盘（worker 的数据目录）；serve 或 worker 重启后浏览器重连即恢复列表，worker 在下一条消息时按需重启。

### CLI 参数

| 参数            | 默认                  | 说明                   |
| --------------- | --------------------- | ---------------------- |
| `--cwd`         | 当前目录              | worker 的 workspace 根 |
| `--port`        | 8790                  | 监听端口               |
| `--host`        | 127.0.0.1             | 监听地址               |
| `--passcode`    | （生成）              | 设置/轮换访问口令      |
| `--data-dir`    | `~/.code-shell/serve` | access.json 位置       |
| `--static-root` | 自动解析 web dist-app | 覆盖静态资源目录       |

### Web 客户端开发

```bash
bun run --cwd packages/web dev:app   # vite dev server，/ws 代理到 127.0.0.1:8790
```
