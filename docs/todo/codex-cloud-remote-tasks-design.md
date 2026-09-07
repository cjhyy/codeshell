# Codex Cloud 远程任务接入：现状核验与设计取舍

> 状态：现状核验 + 方向取舍（Draft for review），**尚未实现任何代码**
> 日期：2026-09-06
> CLI 基线：`codex-cli 0.145.0`（与 `docs/architecture/15-codex-harness-comparison-and-roadmap.md`
> 及 `external-runtimes/codex/app-server-client.ts` 的绑定基线一致）
> 上游文档：`codeshell-hub-remote-service-architecture.md`、`codeshell-hub-iteration-design.md`

## 0. 先厘清「codex 远程云端模式」的三义

仓库里有三样东西都可能被叫成"codex 的远程/云端模式"，它们互不相同，混淆会导致做错东西：

| 叫法                       | 实体                                                    | 现状                                  | 执行发生在哪                       |
| -------------------------- | ------------------------------------------------------- | ------------------------------------- | ---------------------------------- |
| ① 服务端跑 codex CLI       | `packages/server/src/mobile-remote/codex-room-agent.ts` | **已实现**                            | 你自己的服务器（spawn 本地 codex） |
| ② codex 作为外部 Runtime   | `packages/coding/src/external-runtimes/codex/`          | **已实现**（app-server + MCP bridge） | 本机 / 部署机                      |
| ③ **Codex Cloud 云端任务** | 无                                                      | **完全未实现**，本文的对象            | **OpenAI 的机器**                  |

①②的"远程"是指 CodeShell 部署在远端，codex 仍在你的机器上跑。
③是把任务**委派给 OpenAI 托管的机器**执行，本机只提交、轮询、取回 diff。

`docs/architecture/15-codex-harness-comparison-and-roadmap.md:36` 明确把
"OpenAI 托管模型和云端服务内部实现"划在对照范围之外——所以 ③ 在仓库里既无实现也无文档，
本文是第一份。

## 1. 实测：Codex Cloud 的可用表面

以下全部在 2026-09-06 用 `codex-cli 0.145.0` 实测，不是读文档推断。

### 1.1 CLI 子命令

`codex cloud` 自述为 `[EXPERIMENTAL] Browse tasks from Codex Cloud and apply changes locally`：

```
codex cloud exec --env <ENV_ID> [QUERY]   # 提交任务（--env 必填，--attempts 支持 best-of-N）
codex cloud list  [--env] [--limit 1-20] [--json]
codex cloud status <TASK_ID>
codex cloud diff  <TASK_ID> [--attempt N]
codex cloud apply <TASK_ID> [--attempt N]
```

### 1.2 连通性已验证

```console
$ codex cloud list --limit 5
No tasks found.

$ codex cloud list --json --limit 3
{
  "tasks": [],
  "cursor": null
}
```

干净退出、结构化输出 → **本机 auth 有效、云端 API 可达**，账号下当前无任务。

### 1.3 关键约束：只有 `list` 有 `--json`

`exec` / `status` / `diff` / `apply` **都没有 `--json`**，只输出给人看的文本。

这条直接撞上仓库既有教训（`docs/todo/` 与记忆均有记录）：**不要用正则解析散文**——
正则只用于确定性格式，不应解析面向人类的文案来推导分支。一个 experimental 子命令的
文本排版没有稳定性承诺，随时可能变。

### 1.4 底层 REST API（由错误信息泄漏）

```console
$ codex cloud status task_bogus123
Error: http error: get_task_details failed:
GET https://chatgpt.com/backend-api/wham/tasks/task_bogus123 failed:
404 Not Found; content-type=application/json; body={"detail":"Invalid task ID"}
```

`chatgpt.com/backend-api/wham/...` —— 与 `packages/coding/src/quota/index.ts:22` 已在用的
`https://chatgpt.com/backend-api/wham/usage` **是同一个 wham backend**。

### 1.5 认证：已有可直接复用的 headless 实现

`~/.codex/auth.json` 结构（实测）：

```
top-level: auth_mode, OPENAI_API_KEY, tokens, last_refresh
tokens:    id_token, access_token, refresh_token, account_id
```

`packages/coding/src/quota/credentials.ts:23-37` 的 `readCodexCreds()` 已经在读它，
纯 `fs.readFile` + `JSON.parse`，best-effort 不 throw，**零 Electron 依赖**；
`quota/index.ts:64` 已经在用 `authorization: Bearer ${creds.codexAccessToken}` 打同一个 host。

→ 服务端部署形态下认证这一环**不需要新建任何东西**。

## 2. 两条路线与取舍

### 路线 A：包 `codex cloud` CLI

对齐既有 `codex-room-agent.ts` 的 `codexArgsForTurn()` 模式（固定 argv、不过 shell）。

- 优点：不碰非公开 API；token 刷新由 codex 自己管；argv allowlist 模式仓库已有先例。
- 致命缺点：**只有 `list` 能拿到结构化数据**。`status`/`diff`/`exec` 都要解析散文，
  违反 §1.3 的既有教训。`diff` 尤其危险——把 unified diff 从人类排版里"抠"出来，
  一次排版微调就静默产出错误补丁。

### 路线 B：直连 wham REST API

对齐既有 `quota/` 模式（注入 fetch、注入凭证、host 固定）。

- 优点：结构化 JSON；复用已验证的 `readCodexCreds()` 与 host；可离线单测（fetch 注入）；
  与 `codex-parse.ts` 的"纯函数解析 → 归一化事件"house pattern 一致。
- 缺点：**非公开 API，无稳定性承诺**，可能随时变；
  **必须自己处理 token 刷新**——`auth.json` 有 `refresh_token` + `last_refresh`，
  quota 探针是一次性调用不受影响，但云端任务轮询是长跑的，服务端部署尤甚。

### 倾向

**B 为主，A 作为 `apply` 的兜底。** 理由：读路径（list/status/diff）必须结构化，
否则不可靠；而 `apply` 是把补丁落到工作树的写操作，交给 codex 自己做比我们复刻
`git apply` 语义更安全。

**但这是一个需要你拍板的决策**，因为 B 依赖非公开 API——见 §4 Q1。

## 3. 与服务端部署的关系

Codex Cloud 恰好补上服务端部署的一个短板：①（服务器上 spawn codex）要求部署机有
codex 登录态、算力和沙箱；③ 把执行推给 OpenAI，**部署机只做提交与轮询**，
对小规格 VPS 友好得多。

但引入两个服务端特有问题：

1. **token 刷新**（§2 已述）——长跑进程必须处理，否则跑一阵就 401。
2. **多用户下 token 属于谁**——上游文档 §6.3 定了"provider secret 属于用户不属于共享仓库"。
   `~/.codex/auth.json` 是**进程 HOME 级**的单份文件，与 Hub 的 per-user 数据根模型冲突。
   Phase 2 多用户前必须解决；Phase 1 单用户（部署者本人）可以直接用。

## 4. 开放问题

| #   | 问题                                       | 倾向                                                        | 决策时点   |
| --- | ------------------------------------------ | ----------------------------------------------------------- | ---------- |
| Q1  | 是否接受依赖非公开 wham API                | 待拍板；若否则只能做 `list`（唯一有 `--json` 的命令）       | **开工前** |
| Q2  | `--env <ENV_ID>` 从哪来                    | 需先在 Codex Cloud 侧配置环境；本机当前无任务故未能实测枚举 | 开工前     |
| Q3  | token 刷新自己做还是每次 shell 出 codex 拿 | 倾向复用 codex 自身刷新，避免复刻 OAuth 流程                | 设计细化时 |
| Q4  | 多用户下 per-user codex 凭证如何隔离       | 随上游 Phase 2 一起解，Phase 1 不阻塞                       | Phase 2    |

## 5. 尚未验证的部分（诚实边界）

- **没有真跑过一个云端任务全流程**：账号下无任务，且 `exec` 需要 `--env`，
  本次未提交真实任务（会消耗额度并在你账号留下记录，需你授权）。
  故 `status`/`diff`/`apply` 的**真实输出格式未见过**，§2 对"散文不可解析"的判断
  基于 `--help` 缺少 `--json` 这一确定事实，而非见过输出。
- wham API 的**请求/响应 schema 未验证**（只从一条 404 错误里确认了 URL 形状）。
- 未验证云端任务与 CodeShell session/审批模型如何对应。
