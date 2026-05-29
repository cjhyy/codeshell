# 第 4 章 · Tool System

> 覆盖:`tool-system/registry.ts` `executor.ts` `permission.ts`(862)`mcp-manager.ts`(414)`context.ts` `validation.ts` `investigation-guard.ts` `builtin/index.ts`(~35 工具)+ `sandbox/`(概览)
> 这是 core 最大的子系统(~9890 LOC)。本章读"编排骨架",builtin 各工具仅做能力矩阵概览。

---

## 1. 职责

四层:
1. **Registry**:工具登记 + 统一执行入口 `executeTool`(超时 / abort 级联 / 永不抛、返回 ToolResult)。
2. **Executor**:一次工具调用的完整流水(plan-mode 闸 → 校验 → pre_tool_use hook → guard → permission → 执行 → post hook)。
3. **Permission**:classifier(规则 + Bash YOLO 分级 + mode)+ approval backend(headless/auto/interactive)+ DenialTracker。
4. **MCP**:连接外部 MCP server、发现工具注册进 registry、输出包"untrusted"标记 + 图片落盘。
ToolContext 是贯穿这一切的 per-Engine 依赖注入对象(取代旧的 module 单例)。

## 2. 关键类型 / 入口

- `ToolRegistry`(registry.ts):`registerTool / getToolDefinitions / executeTool`。`DEFAULT_TOOL_TIMEOUT_MS=120s`。
- `ToolExecutor.executeSingle(call)`(executor.ts 103):核心流水。`executeAll`(495)= safe 并行 + unsafe 串行。
- `PermissionClassifier.classify / handleAsk`(permission.ts 673/713)。`classifyBashCommand`(543)+ `scanShellCommand`(417)+ `ACCEPT_EDITS_ALLOWLIST`。
- `ApprovalBackend` 三实现:Headless / Auto / Interactive(后者带 session+project 规则持久化)。
- `MCPManager.connectAll / connect / discoverTools`(mcp-manager.ts)。
- `ToolContext`(context.ts 110):cwd/llmConfig/modelPool/toolRegistry/askUser/subAgentSpawner/sandbox/hooks/streamCallback/planMode/engine/sessionId/disabledSkills/disabledPlugins。
- `InvestigationGuard`(三计数器:dedupe / read-budget / silent-turns)。

## 3. 逻辑主线

### 3.1 executeSingle 流水(executor.ts 103-407)

```
0.   plan-mode 闸:不在 allowedInPlan 白名单 → block(Bash 只读命令放行)
0.5. validateToolArgs(schema 必填 + 基本类型)
0.6. pre_tool_use hook:
       decision=deny → block
       updatedInput → 重写 args + 重校验
       decision=allow → A1 加固:拒绝提权(只记日志,不放行)
       decision=ask → handleAsk(用户批准则跳过下面 classifier)
0.7. InvestigationGuard.preToolCheck → block(重复读)/ prepend(软提醒)
1.   permission(若 hook 未 ask):
       classify → on_permission_check hook(clampHookDecision 只许降级)
       deny → block;ask → handleAsk(拒则 block)
2.   on_tool_start hook
3.   registry.executeTool(span + recordToolCall/Result)
     guardDecision.prepend 拼到成功结果前
4-6. on_tool_end / post_tool_use(additionalContext 拼接)/ file_changed(Write|Edit)
```

### 3.2 registry.executeTool 的超时 / abort(registry.ts 75-158)

- 超时优先级:`options.timeoutMs > tool.timeoutMs > 120s`。Bash=1h、Agent=30min、Arena=30min、AskUser=0(无超时)。
- 建 child AbortController:超时 OR 父 signal abort 都触发。`__signal` 注入 args,`signal` 注入 ctx。
- `Promise.race([executor, abort-promise])`。**永不抛** —— 任何错误都转成 `{isError:true}` 的 ToolResult。

### 3.3 Bash 安全分级(permission.ts)

两道独立扫描:
- **classifyBashCommand**(543):先整串查 DANGEROUS_PATTERNS + PIPE_TO_SHELL;再 `scanShellCommand` 引号/转义感知地切 segment(`;` `&&` `||` `&` `\n`),命令替换 `$(` / 反引号、重定向 `>` `<`、进程替换 `<(` 标记 dangerous;每 segment 独立 `classifySegment`(safe-read/safe-write/unsafe/dangerous),整体取**最小安全级**。
- **classify** 用分级:dangerous→ask、safe-read→allow、safe-write→(acceptEdits/auto 才 allow)、unsafe→ask。
- A1 加固:`acceptEdits` 是**白名单**(ACCEPT_EDITS_ALLOWLIST = Write/Edit/ApplyPatch/NotebookEdit/TodoWrite),非 allow-all;其它工具仍 ask。`bypassPermissions` 才全 allow。

### 3.4 Interactive 持久化(permission.ts 144-244)

- session 规则(内存 Map)→ project 规则(写 `.code-shell/settings.local.json`,原子 tmp+rename,只持久化 allow)。
- `savedProjectRules` 累积 + `onProjectRules` 回调把**全量**规则喂回 classifier(避免只传新规则丢掉旧批准 —— 注释明确这是修过的 bug)。
- Bash 规则窄化到 head 命令(`git status` → `^git(\s|$)`)。

### 3.5 MCP(mcp-manager.ts)

- `connectAll`:`enabled===false` 跳过;`Promise.allSettled` 并发连;单连 15s 超时 + best-effort close。
- `discoverTools`:每工具注册名 `mcp_<server>_<tool>`,executor 调 `client.callTool`,**输出过 `wrapMcpOutput`**(untrusted 标记防注入)+ 图片落盘 `spillMcpImage`(>8MB 丢弃占位)。
- `buildRegisteredTool`:默认 `isConcurrencySafe/isReadOnly=false`(保守),仅 `annotations.readOnlyHint===true` 才放开并发。

### 3.6 builtin 能力矩阵(index.ts)

~35 工具,每个声明 `permissionDefault / isReadOnly / isConcurrencySafe / timeoutMs`。要点:
- 只读并发安全:Read/Glob/Grep/WebSearch/WebFetch/ToolSearch/Lsp/Brief/Memory{List,Read}/CronList/Agent(!)/AgentStatus。
- Agent `isConcurrencySafe=true + isReadOnly=true`(把子代理当只读并发,30min 超时)。
- Bash 1h 超时;Arena 30min;AskUser timeoutMs=0(纯等待)。
- 写类默认 ask:Write/Edit/ApplyPatch/NotebookEdit/Config/Cron{Create,Delete}/Repl/PowerShell/Worktree/Memory{Save,Delete}/RemoteTrigger。

## 4. 逻辑理顺问题

- ⚠️ **plan-mode 工具白名单三处不一致**:engine.ts `planModeAllowed`(ch01,含 `TaskCreate/TaskUpdate/TaskList/TaskGet` 但**无 TodoWrite**)、executor.ts `allowedInPlan`(含 `TodoWrite` 但**无 TaskCreate 等**)、context.ts 无关。两份白名单 drift:engine 在装配期 filter toolDefs(模型看不到),executor 在执行期再 block。若某工具只在一份里(如 TodoWrite),模型在 plan 模式下能看到却被 executor 放行 / 或看不到。**应抽成单一常量。**

- ⚠️ **`validateToolArgs` 极弱**(validation.ts):虽 import 了 zod 但**完全没用**;只查 required + 顶层 string/number/boolean 类型,不校验 array/object/enum/nested/format。注释 "Zod-based" 与实现不符。catch 里 `return null`(校验出错=放行)。**误导性注释 + 形同虚设的校验。**

- ❓ **`isReadOnlyBashCommand`(executor.ts 409)与 `classifyBashCommand`(permission.ts 543)是两套 Bash 只读判定**。前者给 plan-mode 用(自带 readOnlyCommands/readOnlyPrefixes + DANGEROUS 正则),后者给 permission 用(SAFE_READ_PATTERNS)。两份白名单不同(如 executor 版含 `awk`,permission 版 SAFE_READ 不含 awk)。**Bash 只读判定逻辑重复且不一致** —— plan 模式与 permission 模式对同一命令可能判定相反。

- ❓ **Agent 工具 `isConcurrencySafe=true`**(index.ts 186)。意味着多个 Agent 调用会**并行**起跑(StreamingToolQueue / executeAll)。子代理会 fork 子 Engine + 各自 MCP/工具。注释 setMaxListeners(50) 提到 "11+ concurrent tools when Agent fans out"。并发子代理对共享 runtime(modelPool/mcpPool)的串台风险 —— 正是 §session-isolation 主题。**确认:并发子代理是否各持独立 llmClient?**(ch01 spawn 里子 Engine 自建,但若共享 runtime 则共享 modelPool。)

- ❓ **`executeAll`(executor 495)与 TurnLoop 的 StreamingToolQueue / executeToolsOverlapped 是第三套并发实现**。registry 无并发实现,executor 有 executeAll,TurnLoop 有 StreamingToolQueue + 死代码 executeToolsOverlapped。**全系统至少 3 套 safe/unsafe 调度逻辑**(ch02 已记 2 套)。run() 实际只走 StreamingToolQueue;executeAll 被 executeToolsOverlapped 在 calls<=1 时调,而 executeToolsOverlapped 是死代码 → **executeAll 可能也是死代码**。需确认调用方。

- ❓ **`MCPManager` 既是单例(static instance)又被 Runtime 当共享池注入**(mcp-manager 143/147)。构造即覆盖 static instance。若同进程建多个 MCPManager(runtime 模式 vs null-runtime 测试),`getInstance()` 返回最后一个 —— 全局可变单例与 per-runtime 实例语义冲突。`getInstance` 还有谁在用?(若只测试用,无害;若生产代码用 getInstance 拿"当前"MCP,与 runtime.mcpPool 可能不是同一个。)

- ❓ **`clampHookDecision` 只防 pre_tool_use / on_permission_check 提权到 allow,但 `bypassPermissions` mode 在 classify 入口直接 return allow**(permission 675),先于规则。即 bypass 模式下 hook 的降级(allow→deny)**仍会生效**(因为 classify 返回 allow 后,executor 的 on_permission_check hook 可降级)。但 `handleAsk` 里 bypass 直接 return true(726)—— 若 hook 把 allow 降成 ask,会进 handleAsk,bypass 又自动批准。**链路:bypass + hook 降级 ask → 仍自动放行。** 确认这是否预期(bypass 应压倒一切?)。

- ❓ **`scanShellCommand` 不递归命令替换**(注释自承,452 标 dangerous 即停),所以 `echo "$(rm -rf /)"` 里的 rm 不会被单独分类 —— 但 `$(` 已标 dangerous → ask。OK。但 **引号内的分隔符被正确忽略**(`echo "a; b"` 单 segment),而引号内若含 `rm -rf /` 字面量也只是 echo 的参数,安全。逻辑自洽,记录其"检测非解析"的边界。

- ❓ **DANGEROUS_PATTERNS 含 `git push --force` / `git reset --hard` / `git clean -fd`**(permission 346-350)→ 这些被判 dangerous → ask(非 deny)。即危险 git 操作仍可经用户批准执行,合理。但 `kill -9` / `pkill -9` 也在列 —— 普通进程管理被一律拦,可能误伤。记录为偏保守。

- ❓ **`recordUsage` / `recordToolCall` 用 `getCurrentSid()`**(executor 321),依赖 ch01 的 ALS runWithSid 包裹。若工具在 ALS scope 外执行(如某些后台路径),sid 会落到 module fallback。与 ch01 跨进程 resume 的 sid 备查项关联。
