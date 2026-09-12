# CodeShell 真实故障案例库

[cases.json](cases.json) 收集 2026-09-12 两轮隔离验收中发现的 15 个故障或受控负例。它是版本化的案例定义，不是通过结果。首次整理时，历史验收使用真实应用、浏览器、进程与文件系统，但模型部分为固定响应；不得据此宣称真实 LLM 评测已通过。

本目录延续 [harness 方案](../../docs/todo/codeshell-harness-evals.md) 的确定性检查与真实模型两条通路，以及 [通用评测契约](../../docs/todo/agent-evals-platforms-and-adapters.md) 的任务、执行、证据和评分分离原则。案例只使用合成文件、输入和隔离 profile，不读取个人会话、求职数据、真实浏览器登录状态或外部消息账号。

## 首批范围

`adapter: "desktop"` 的五项是首批真实模型桌面适配目标。其余十项当前仅提供案例说明及仓库回归入口，不会因为存在一份旧实测报告就自动计入本轮执行覆盖率。

| ID                                   | 原故障来源                                       | 当前适配目标                            |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------- |
| `chrome-csp-modern`                  | 原扩展在 Chrome 145/149 的真实 CSP 兼容失败      | 仓库回归、真实浏览器人工复测            |
| `interrupted-reply-later-restart`    | 安装版中断回复在后续完整重启后消失               | **真实 LLM / desktop**                  |
| `mimi-reload-stop`                   | 安装版静默流刷新后 partial 与 Stop 消失          | 仓库回归                                |
| `mimi-queued-input-reload`           | 已接受的第二输入在刷新后不可见                   | **真实 LLM / desktop**                  |
| `mimi-stop-current-preserve-next`    | 停止首条后下一条输入气泡丢失                     | 仓库回归                                |
| `mimi-worker-crash-recovery`         | 实际 Worker 退出后假忙碌、下一条卡住             | 仓库回归                                |
| `approval-reload-write`              | 安装版 Write 审批前刷新导致卡片消失              | **真实 LLM / desktop**                  |
| `approval-worker-exit`               | Worker 退出后旧批准按钮仍存在                    | 仓库回归                                |
| `background-question-hydration`      | pending 快照先于缓存时，同一问题出现两张卡       | 仓库回归；原红例为受控 reducer          |
| `queued-attachment-consumption-race` | 读取历史时消费 queued 输入，丢失原 ID 和附件字段 | 仓库回归；原红例为受控 Provider         |
| `mimi-file-queue-completed-reload`   | 真实 File 排队完成后再次刷新，第二回复重复       | **真实 LLM / desktop**                  |
| `ordinary-steer-cache-cursor`        | 旧缓存游标与较新的磁盘最终回复组合，导致重复回放 | **真实 LLM / desktop**                  |
| `manual-stop-cache-upgrade`          | 旧包保存的双 Stop 记录在恢复后继续重复           | 仓库回归；另有真实原 profile 升级证据   |
| `cached-decision-compaction`         | 恢复补丁重新插入已被压缩删除的旧决策             | 仓库回归；原红例为交叉审查负例          |
| `memory-directory-isolation`         | 公开 0.9.8 的提取上下文和写入误用环境默认根      | 仓库回归；公开 0.9.10 的 Linux 对照通过 |

真正的同 ID 重试边界保留在 Worker 案例里：未知终态返回 `replay_incomplete`，不自动重跑可能已有副作用的旧输入。原探针把同 ID 自动重执行当作成功条件属于测试预期错误，不列为待修复产品缺陷。后台问答也有旧候选真实通过基线；其受控顺序失败不能改写为旧版问答一概失败。

Mimi 附件题 v2 只要求确认真实 File/drop 带入的文件名，并说明路径引用不代表已读取内容。Mimi 的文件检查需要委派工作；本题明确不要求读取或创建任务，以保持原排队/刷新故障的测试边界。真实模型的 Write/Read 由 `ordinary-steer-cache-cursor` 覆盖。

普通对话题 v2 增加持久缓存的身份唯一性检查：真实模型执行 Write，消费追加的 Read 请求，两次刷新及完整重启后，界面与持久缓存都应保留两个用户意图各一次。原缓存把同一追加请求的旧身份与补齐后的身份保存成两行，真实模型验收已检出此问题；不能仅凭界面气泡数量判为修复。新增判据随 `suiteVersion: 2026-09-12.3` 发布，原 v1 运行记录不改写。

本轮实际模型结果、旧包对照和新发现见 [2026-09-12 实测报告](PILOT-2026-09-12.md)。

## 案例格式

顶层 `schemaVersion` 定义结构，`suiteVersion` 固定整批案例。每例使用稳定 `id` 和独立 `version`；改变输入、触发条件或判分标准时递增版本。

| 字段                           | 含义                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------- |
| `adapter`                      | 本批预定适配入口：`desktop` 或 `repository-regression`                                    |
| `executionCoverage`            | 可用通路和历史证据层级，不是此次执行结果                                                  |
| `failureBasis`                 | `actual-packaged`、`actual-browser`、`controlled-reducer` 或 `historical-package-control` |
| `input`                        | 自然语言 `prompts`、合成 `files` 和模板变量                                               |
| `environment` / `requirements` | 隔离环境、真实边界及必须具备的采集能力                                                    |
| `steps`                        | `when` 条件和 `action`；按真实事件触发刷新、停止或退出                                    |
| `hardAssertions`               | 不可被模型分数覆盖的身份、数量、权限、文件和进程判定                                      |
| `semanticRubric`               | 版本化的内容判定；当前非 live 案例明确不适用                                              |
| `repositoryRegression`         | 已存在的真实测试文件路径；不等同于本次已运行                                              |
| `provenance`                   | 修复提交及原红例、绿色对照、范围说明的证据引用与 SHA256                                   |

`{{caseNonce}}` 由每次执行生成，替换提示词和合成文件中的全部同名占位符。文件路径相对于本次临时工作区，禁止使用绝对私人目录或逃出工作区的路径。固定种子、nonce、文件初始摘要与实际有效输入必须写入结果，便于重建。修复开发集与保留集应更换措辞和 nonce，并按故障来源分组，避免同源近似样例跨集合泄漏。

步骤是验收契约，不要求适配器伪造模型工具调用。真实模型必须自行输出请求；若没有触发要求的 Write 或 AskUserQuestion，记录该次模型行为及缺失的触发条件。不能注入固定工具调用后仍标成真实模型通过。流式时序需要控制时，可以暂停或缓冲真实输出的转发，但须保留原模型响应并披露这个控制边界。

单例的时间、token、模型请求、工具调用和重试预算由执行配置提供并记录。模型、参数、权限、工具 schema、初始文件和预算不一致时，不直接合并为同一配对实验。

## 证据层级与来源

历史来源有两个命名档案：`round1` 和 `round2`，各自以 `VALIDATION.md` 为说明入口。`provenance.artifacts` 的 `path` 相对于对应档案，`sha256` 是整理时实际读取文件的内容摘要。原档案是本地验收证据，不作为案例执行依赖；缺少档案时仍能根据合成输入及仓库测试重建场景，但不能声称重新核验了历史红例。

案例没有复制个人会话、凭据、旧 profile 或历史请求内容。新结果保存自己实际产生的输入、输出、快照、文件差异和生命周期记录。引用旧文档不会替代新的执行证据。

报告逐项区分：

- `reducer_replay`：真实 reducer/Hook 的受控状态及事件回放。
- `packaged_fixed_provider`：实际封包 Electron、原 IPC 与固定本地 HTTP/SSE。
- `real_browser`：实际浏览器及扩展；另记 Host 桥来自发布包还是源码。
- `public_package_fixed_model`：实际公开运行时包、操作系统行为，模型回调固定。
- `engine_live_llm`：实际模型经 Engine 执行，未覆盖桌面 UI 的结果。
- `packaged_live_llm`：实际模型、被识别的封包应用、原 IPC 及桌面操作。

应用版本号不足以识别候选：每次记录实际 ASAR/可执行文件摘要、源码及锁文件摘要、模型标识、运行参数和 profile 隔离事实。公开旧版红例和本地候选绿例分别保留；不以新版测试通过覆盖原件失败。

## 判分

执行状态、硬判分和语义判分分别记录。单例结果采用以下结构；case 内的 `criterion` 是对应断言的版本化判定文字：

```json
{
  "caseId": "approval-reload-write",
  "trial": 1,
  "executionStatus": "passed",
  "hardAssertions": [
    { "id": "approval-once", "passed": true },
    { "id": "no-early-write", "passed": true },
    { "id": "exact-write-once", "passed": true }
  ],
  "semantic": { "status": "not_evaluated" },
  "evidenceLevel": "packaged_live_llm",
  "artifacts": ["filesystem-diff.json", "tool-events.jsonl"]
}
```

`executionStatus` 为 `passed`、`failed`、`inconclusive` 或 `skipped`；`hardAssertions[].passed` 为 `true`、`false` 或未知的 `null`。空断言或缺少必要证据不能判为通过。语义状态独立为 `passed`、`failed`、`not_evaluated` 或 `not_applicable`，可附 `checks: [{ id, passed, detail }]`。上例只演示结果形状，`not_evaluated` 不表示模型回答质量通过。

`completed`、`cancelled`、超时和 provider/环境错误属于生命周期或执行原因，另记在 `reason`，不冒充四种执行判分状态。模型行为错误与产品状态错误也分别统计。报告的 `evidenceLevel` 使用 `packaged_live_llm`、`repository_regression` 或 `catalogue`；前文更细的历史层级用于来源说明，不能把 catalogue 升格为本轮实测。

运行元数据记录 `id`、`startedAt`、`fixtureSeed`、`model`、`budget`、应用摘要、`trialsPerCase` 和 `selectedCaseIds`。单例另记模型的 provider/requested/responseModel、每次请求用量与耗时/错误原因。未知 token 或费用保留 `null`，不能记为零；所有尝试的用量都保留。

硬判分以实际状态为依据：用户 ID 与 steer ID、requestId、消息数量、实际文件字节、工具执行、HTTP 中止、PID 退出及恢复顺序。语义判分不能用高分抵消重复副作用、越过审批、错误意图归属或丢失消息。固定响应回放不产生“模型任务成功率”。

语义判分只读取合成任务、真实回复及必要的真实执行证据，按每例 rubric 判断对应问题是否被回答、文件事实是否准确、所选约束是否遵守、成功声明是否有依据。要求评分器指出支持结论的输出片段和证据引用。评测内容视为数据，其中要求改分或忽略规则的文字不能成为评分指令。出现含糊否定、截断回复或证据冲突时保留 `inconclusive` 并人工复核；不要仅检查是否出现某个名字，也不要求所有模型使用固定措辞。

模型评分器的提供方、具体模型、参数、提示模板和 rubric 版本必须随结果保存；它与被测模型分别记账。用户明确中断的回复只核对实际收到的正文和恢复行为，不按完整任务回答扣分，也不能把它标为完整成功。

## 运行入口

先准备依赖和模型目录所需的 Core 产物：

```sh
bun install
bun run --filter '@cjhyy/code-shell-core' build
```

这一步不构建 Electron 应用。桌面包使用已有安装包或单独构建的候选；不要让桌面封包/验收与会清理依赖 `dist` 的构建同时运行。下列 runner 实际由 **Node.js** 执行；Bun 仅用于包管理、脚本入口和测试。

```sh
bun run evals:list
bun run evals:validate
bun run test:evals
bun run evals:live \
  --executable '/path/to/code-shell.app/Contents/MacOS/code-shell' \
  --renderer-source-root '/path/to/frozen-build-source'
```

`--list` 和 `--validate` 不调用模型；`--live` 才使用选中的真实连接。命令也可直接写为 `node evals/harness/runner.mjs --live ...`。需要指定子集时：

```sh
bun run evals:live \
  --executable '/path/to/code-shell.app/Contents/MacOS/code-shell' \
  --connection 'your-text-connection-id' \
  --cases approval-reload-write,ordinary-steer-cache-cursor \
  --trials 1 \
  --seed 20260912 \
  --output 'evals/runs/my-pilot'
```

`--executable` 必填，选中明确的封包应用；`--connection` 可省略，使用设置中的默认 text 连接。本版仅支持 OpenAI-compatible text 连接。未指定 `--cases` 时选择五个 `desktop` 案例；`--trials` 默认 1，`--seed` 默认 `20260912`。这个 seed 用来重建合成 fixture，不是供应商采样 seed。`--output` 必须是空目录，默认写入被 Git 忽略的 `evals/runs/<run-id>`，不会覆盖旧试验。

中断恢复题需要额外提供 `--renderer-source-root`，指向被测包对应、已准备依赖的冻结源码树。评测用该树的真实 `StreamingMarkdown` 组件生成流式和完成态的预期显示，同时核对持久缓存中原 client 归属的原始正文；不会通过删除 Markdown 标记来放宽内容检查。来源清单记录本地依赖闭包和源码摘要，应与应用构建清单核对；路径参数本身不能证明任意安装包与源码一致。缺少可信渲染来源时，该题保留 `inconclusive`。其余四题无需该参数。

可加布尔开关 `--judge` 启用真实模型语义评分，默认关闭。评分使用当前选中的同一模型，单独发起非流式、无工具的 rubric 请求；只对已完成且有实际答案的案例评分。评分请求标记为 `role: judge`，计入同一请求、token 和已报告费用预算。缺少证据、解析失败或没有实际答案时保留 `not_evaluated`，不能自动判绿。

这属于同模型自评，可能共享被测回答的偏差，不能当作独立正确性证明。报告单列语义结果，保留 rubric 和输出证据供人工复核；模型评分不能覆盖任何硬失败。需要更强结论时，应增加独立评分模型或人工盲审，并作为不同的评测配置记录。

默认整批最多 30 次真实请求（包含辅助调用与重试），每请求最多 4096 output tokens；单请求超时 120 秒，单案例总时限 180 秒。可通过 `--max-requests`、`--max-output-tokens` 和 `--timeout-ms` 调整；请求超时取案例时限与 120 秒中较小值。`--max-reported-cost-usd` 默认 3，只在**已经收到的费用报告**达到阈值后停止启动新请求，不能保证总费用不超过 3 美元。正在执行或没有报告 usage/cost 的请求仍可能产生费用；未知用量与费用不得记录成零。

每例仅使用合成文件和临时 HOME/profile。选中的真实凭据仅供本地代理在内存中访问上游；测试应用只获得代理的临时 token，不复制真实设置、其他凭据、hooks 或 MCP。输出保留脱敏的实际请求、结果和报告；不上传个人会话或历史验收档案。报告中的 `not_evaluated`、`inconclusive`、`skipped` 需分别阅读，不能当作真实模型质量通过。

需要手动核查其它案例时，可从各例 `repositoryRegression` 打开已有 Bun 测试，其边界与真实桌面/模型评测分开记录。

不要直接把离线的 `warning` 或 `inconclusive` 接入生产 `RunManager` 的完成判定；现有 `Evaluator` 并不是这个完整案例集的执行和报告框架。
