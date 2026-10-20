# Coding / TUI / Arena / Optimization Lab / 根脚本审查

基线：`66ee7737a7d6203319834e601c84afe6757f801e`。只记录问题，不修改产品。

## A01 [P2] ApplyPatch 成功重命名后丢失脚本执行权限

- 位置：`packages/coding/src/tools/apply-patch/applier.ts:143-163,297-306`。
- 触发：对一个 `0755` 脚本使用 Update + Move to，目标此前不存在。
- 预期：移动后的文件保留原文件执行权限；实际：先 unlink 源，再 writeFile 新目标，目标按默认 mode 创建，执行位全部消失。工具返回成功，但原本可直接运行的入口现在不能执行。
- 验证：`evidence/root-patch.test.ts` 第一项，真实临时文件；原位置普通 update 保留 `0755` 作为正常对照，move 后正文正确、源消失、目标 `mode & 0111 = 0`。不涉及 OS 外部命令。
- 查重：旧两份审查索引未列此项。
- 建议：计划中保存文件 mode，rename/update 的新目标恢复适用的源 mode；避免继承无关目标的权限。

## A02 [P2] ApplyPatch 失败回滚会损坏被删文件的字节和权限

- 位置：`packages/coding/src/tools/apply-patch/applier.ts:112-122,278-289`。
- 触发：第一 hunk 删除文件，后续 Add 写入失败（例如父路径实际是文件）。
- 预期：默认原子模式拒绝补丁后原文件完全恢复。实际：Delete 的 snapshot 用 UTF-8 string 保存二进制；rollback 用 UTF-8 writeFile 重建，非法 UTF-8 字节变为替换字符，且 executable mode 也丢失。
- 影响：明确返回失败、声称 all-or-nothing 的调用依然改变原始资源。二进制图片/资源可能永久损坏；文本脚本正文虽恢复，却不能执行。
- 验证：`evidence/root-patch.test.ts` 后两项；临时二进制 `[89 50 4e 47 ff 00 80]` 的回滚字节与原件不等；另一用例恢复脚本文字后执行位为 0。后续失败由真实 ENOTDIR 引发，不 mock 文件系统。和 A01 的成功 move 是不同修复语义；本项将两种不完整 snapshot 表现合并计数。
- 查重：旧两份审查索引未列此项。
- 建议：删除/回滚 snapshot 保存 Buffer 和元数据，完整恢复；不能保证恢复时向调用者明确报出恢复失败。

## A03 [P3] Git status 的首条未暂存路径被截掉首字符

- 位置：`packages/coding/src/git/utils.ts:29-30,76-83`；调用方 `packages/coding/src/capability-runtime.ts:76-81`。
- 触发：porcelain 第一行为常见的 ` M alpha.txt`。
- 原因：通用 git helper 对整个 stdout `.trim()`，删除第一行状态列的空格；随后固定 `slice(3)` 把真实路径首字符一并截掉。
- 实际：`getGitStatus` 返回 `lpha.txt`，模型动态 Git context 因此收到不存在的文件路径。暂存状态 `M  alpha.txt` 对照正常。
- 验证：`evidence/root-git.test.ts` A03，真实临时 Git 仓库；不声称当前 /commit 会按此错误路径暂存（它实际 git add 全目录）。
- 查重：旧审查索引未列。建议保留 porcelain 的前导空格，并改为 NUL 分隔解析。

## A04 [P3] 合法提交标题中的竖线破坏 Git log 字段

- 位置：`packages/coding/src/git/parse-log.ts:20-27`；格式来源 `packages/coding/src/git/utils.ts:105`。
- 触发：提交标题 `feat: a | b`。
- 实际：标题被截为 `feat: a `，作者变成 ` b`，日期变成作者名。动态 Git context 和 /commit 的近期风格提示丢失标题后半段。
- 验证：`evidence/root-git.test.ts` A04，真实 `git commit --allow-empty`；未依赖外部仓库。
- 查重：旧审查索引未列。建议使用不能与合法字段混淆的格式/长度边界，而非裸 `|`。

## A05 [P2] /commit 在模型返回 error 时仍实际提交

- 位置：`packages/tui/src/cli/commands/builtin/git-commands.ts:84-91`。
- 触发：生成提交消息的 `client.run` 正常返回合法终态 `reason: model_error`，同时仍有此前轮次的非空文本。
- 预期：保留用户工作区和暂存区，报告生成失败。实际：只判断 text 非空，无视终态，执行 `gitAdd` + `gitCommit`，把错误运行的旧正文当提交消息。
- 验证：`evidence/root-git.test.ts` A05。真实 slash command + 源码 Git helpers + 临时 Git；仅 client.run 是内存失败替身。HEAD 前进、提交标题为 `prior-round output`、工作区变干净。没有调用真实模型。TurnLoop 的 finalText 保存及 model_error 返回、Server/Client 正常传回该结果的接线另做静态核验；不保证失败流本轮的半截 delta 一定出现在 result.text。
- 查重：旧审查索引未列。建议完成状态且消息有效时才执行提交；用户取消也应复核 guard/abort 所属代次。

## A06 [P2] /commit 提示不含已暂存内容，提交却包含它

- 位置：`packages/tui/src/cli/commands/builtin/git-commands.ts:70-90`；`packages/coding/src/git/utils.ts:85-98,118-122`。
- 触发：alpha 已暂存修改，beta 另有未暂存修改，然后运行不带 -m 的 /commit。
- 实际：提示只用默认 `git diff` / `git diff --stat`，完全看不到 alpha；拿到标题后 `git add .` 并 commit，最终把 alpha 与 beta 都提交。只有已暂存修改时，模型甚至收到空 diff。
- 影响：生成的提交消息/所审上下文与实际提交范围不一致，用户此前单独暂存的内容被纳入未经展示的提交。
- 验证：`evidence/root-git.test.ts` A06；提示含 `UNSTAGED_SENTINEL`，不含 `STAGED_ONLY_SENTINEL`，真实 HEAD 却包含两文件。模型仅替身，没有真实请求。
- 查重：旧审查索引未列。建议确定并冻结欲提交集合，再以同一集合生成上下文和实际提交。

## A07 [P2] /permissions 宣称 live 切换，实际只改无会话引擎

- 位置：`packages/tui/src/cli/commands/builtin/permissions-command.ts:82-83`；`packages/core/src/protocol/client.ts:386-387`；`packages/core/src/protocol/server.ts:3063,3540-3557`。
- 调用链：TUI REPL 以 ChatSessionManager 构建 AgentServer；config 查询带 sessionId，permission_set 仅发送 value，不含 owner。Server 用 detachedQueryEngine 执行 setPermissionMode。
- 触发/实际：活跃会话 acceptEdits 时输入 `/permissions plan`，输出 `acceptEdits → plan (live)`，活跃 session 仍 acceptEdits，只有 detached engine 为 plan。只读计划模式没有按用户指令启用。
- 验证：`evidence/root-permissions.test.ts`，实际 command、AgentClient、in-process transport、AgentServer、ChatSessionManager；Engine 为记录配置的内存替身。5 expect / 1 pass / Completed。没有运行真实工具，因而不声称已观察真实文件写入。
- 查重：旧两份审查索引未列。建议走携 sessionId 的 configure 权限路径，并在 UI 同步实际获确认的会话模式。

## A08 [P2] 自定义会话存储时 /undo 读取错误目录，无法撤销

- 位置：`packages/tui/src/cli/commands/builtin/utility-commands.ts:58-64`；`packages/core/src/protocol/server.ts:3178-3207`。
- 触发：用户配置了非默认的 `session.storageDir`，对应 Engine `sessionStorageDir` 内有真实文件历史。
- 实际：command 期望 config 查询返回 `sessionStorageDir`，但协议响应没有该字段；因此退到 `~/.code-shell/sessions/<id>`。真实自定义目录里有快照，界面却报“没有可撤销的文件修改”。若默认目录碰巧有同 ID 的旧历史，还可能选错恢复集（此分支未动态验证，不计扩大影响）。
- 验证：`evidence/root-undo.test.ts` A08；实际 protocol/client/manager + 实际 FileHistory + 实际 /undo，Engine 配置 getter 为内存替身。确认字段丢失、命令未恢复、直接从自定义目录读取的同一 history 能恢复原文。
- 查重：旧审查索引未列。建议按会话权威路径在服务端执行恢复，或返回经过审查的实际存储根并保持所有消费者一致。

## A09 [P2] /undo all 忽略新建文件，不能撤销整个会话

- 位置：`packages/tui/src/cli/commands/builtin/utility-commands.ts:73-101`；`packages/core/src/session/file-history.ts:363-367`。
- 触发：某一会话的工具创建新文件，FileHistory 已有 `recordCreated` 标记，用户选择 `/undo all confirm`。
- 实际：全会话路径只用 snapshots，完全不看 created markers。仅新建文件的会话显示“没有可撤销”，新文件留存；普通 `/undo confirm` 能正确删除同一个新文件。新建后又被编辑的文件则会被错误视作会话前已存在（源码判断，未额外动态计数）。
- 验证：`evidence/root-undo.test.ts` A09；真实临时 history、真实 command。正常对照为同一 fixture 的普通单轮 undo，不调用模型。
- 查重：旧审查索引未列。建议全会话恢复计划纳入创建记录，保持 preview 与 confirm 目标集合一致。

## A10 [P2] headless run 的显式模型参数被 seed Engine 覆盖

- 位置：`packages/tui/src/cli/commands/run.ts:118-122,158-171,193-203`；`packages/core/src/engine/engine.ts:934-948`。
- 触发：已有可用 catalog 默认连接，又在 `code-shell run` 提供 `--model` / `--provider` / `--base-url` / `--api-key` 等显式覆盖。
- 调用链：runCommand 先覆盖 resolved config 的 provider/model/baseUrl（apiKey 在 resolved 分支根本未赋值），随后创建 seed Engine；构造时 populateModelPoolFromSettings 又把 llm 整体切回 defaults.text。runCommand 读 seed.getConfig().llm 后供真正会话使用。
- 结果：显式选择无法生效，执行将沿用已保存的模型/端点/凭据。可能违反用户的成本或路由意图；本轮没有发送请求，也不声称已发生费用。
- 验证：`evidence/root-cli-model.test.ts`，真实 Engine 构造与有效本地 settings；传入 flag-model/flag endpoint/key 后 getConfig 返回 saved 模型/endpoint/key，3 expect / 1 pass / Completed。model/baseUrl 的 seed 覆盖已实证；runCommand 在 resolved 分支遗漏 apiKey 覆盖另由源码确认，测试的 key 输入不等同于 CLI 实际传参。provider 分支及 CLI→seed→共享配置接线为静态核验，未完整运行付费 CLI。
- 查重：旧审查索引未列。建议把 CLI 的明确选择作为 seed catalog 同步后的显式覆盖并一致传入运行会话。

## A11 [P2，静态确认] release --push 在任务分支可能推送未合入 main 的标签

- 位置：`scripts/release.ts:185-202`，以及其前置条件检查（只查 clean tree 和版本，没有校验当前 branch/HEAD 是否为 main）。
- 触发：在干净任务分支运行带 --push 的发布脚本。脚本在当前分支提交版本更新，却固定 `git push origin main`，接着对当前 HEAD `git tag` 并推 tag。
- 实际：main 可仍是旧提交，release tag 指向独立任务分支上的新版本，触发 tag CI。与本仓库“Release only an authorized, verified merged commit”约定矛盾；已同步的 main 并不能保证当前 tagged HEAD 已合入 main。
- 验证层级：完整顺序静态核验，未运行发布脚本、未写任何真实 tag/commit、未推送远端。仅陈述源码可达路径，不声称已发生错误发布。
- 查重：旧审查索引未列。建议发布前验证当前提交的集成/授权关系，并按明确的同一 revision 推送分支和标签。

## A12 [P3] JSON 最终结果的空正文后备混入子代理输出

- 位置：`packages/tui/src/cli/output/renderer.ts:91-98`；正常 TextRenderer 在同文件 `:30-35` 明确按 agentId 排除子代理 delta。
- 触发：主代理最终 text 为空（如取消发生在主代理输出前），但期间已收到带 agentId 的 child text_delta。
- 实际：JsonRenderer 把所有 text_delta 累加到同一字符串；onComplete 用 `text || this.text` 后备，返回的父会话 result 却是子代理内容。主代理已有最终正文时不触发此后备。
- 影响：headless JSON 消费者可能把子代理片段当父代理最终回答；reason 字段仍显示 aborted_streaming，没有伪造 completed。原始 stream-json/jsonl 事件有 agentId，不在本条范围。
- 验证：`evidence/root-json-output.test.ts`，直接生产 renderer，捕获 stdout；TextRenderer 排除同一事件、JsonRenderer 返回 child-only-output，3 expect / 1 pass / Completed。未运行真实子代理或完整CLI。
- 查重：旧索引未列。建议只累加主代理 delta，并考虑只以实际终态正文作为权威 result。

## 执行与覆盖（持续更新）

- 补丁专项：`evidence/root-patch.log`，3 pass / 11 expect / 0 fail / 0 skipped，guarded runner 完成。测试通过表示缺陷被稳定观察，非修复。
- Git 专项：`evidence/root-git.log`，4 pass / 13 expect；权限命令专项：`evidence/root-permissions.log`，1 pass / 5 expect；均 0 fail/skip 且 Completed。独立质量复核发现初稿 A05 的替身 reason 使用了非法 `error` 值，已改为合法 `model_error` 并重新运行；初稿源码/日志保留为 `root-git-initial.*`，不计为额外独立测试。
- 撤销专项：`evidence/root-undo.log`，2 pass / 10 expect；CLI seed 模型专项：`evidence/root-cli-model.log`，1 pass / 3 expect；均 0 fail/skip 且 Completed。
- JSON renderer 专项：`evidence/root-json-output.log`，1 pass / 3 expect / 0 fail/skip / Completed。初稿使用非法 `aborted` 值，质量复核后改为合法 `aborted_streaming` 并重跑；初稿 `root-json-output-initial.*` 单独保留，不重复计数。
- 首次较大 baseline shard 因新 worktree 缺 package 依赖软链产生 `Cannot find package zod`，完整保留 `root-baseline.log`。属于环境问题，不计产品 bug。补齐本地依赖链接后重跑，见 `root-baseline-retry.log`。
- 重跑 coding Git/ApplyPatch、Arena、Optimization Lab 现有测试：42 files / 253 pass / 664 expect / 0 fail/skip / Completed。通过既有测试不代表全部分支正确；本报告新复现覆盖此前遗漏的场景。
- TUI CLI、QueryGuard/input/pending question/store，以及 coding runtime shared/root path：24 files / 150 pass / 412 expect / 0 fail/skip / Completed。
- 发布包帮助器、恢复、资源拷贝、meta build、覆盖统计及engine bypass guard：6 files / 42 pass / 171 expect / 0 fail/skip / Completed。没有执行真实发布。
- `check-workflow-test-paths` 20条literal路径通过，`check-no-engine-bypass` 通过。没有全量build/typecheck/真实打包发布门禁，故不能宣称构建产物已验收。
- 未运行真实外部 coding CLI、付费模型、用户凭据、真实平台账号或 Electron UI。
