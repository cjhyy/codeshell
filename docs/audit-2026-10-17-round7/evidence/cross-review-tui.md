# TUI 审查者对 Files / Providers 的只读交叉复核

冻结基线 `1b04838474bcd57212f80f791d0e268a00d347e3`。本复核新增/修复/执行/重跑测试均为 **0**；只读报告、fixture、第一次 raw log / exit、相关源码和已安装 SDK 源码。未编辑任何作者的 fixture、log 或报告。

## Files

已复核最终降级后的 `files.md` 与四份首次 fixture/log/exit。确认 **3 项（1 P2、2 P3）**，Glob 保留行为候选。四个成功分片为 **12 pass / 43 expect / 0 fail / 0 skip / Completed**，其中 Glob 的 **2 pass / 8 expect** 是候选行为证据，不能另计一个已确认 bug。

- **FILES-R7-01，P2：支持。** `edit.ts:22–23` 的 exact replacement 合同与唯一 old_string 检查清楚；`:94` 默认分支使用字符串替换参数，而 replace_all 使用 split/join。真实 Edit 持久化的 `$&` / `$$` / `` $` `` / `$'` 与入参不同，真实 Read 回读验证，成功 diff 却来自原 `newLf`。普通字符、无匹配捕获的 `$1`、相同入参 replace_all 控制均通过。这是普通文本正确性问题，未推出模型、UI、完整 executor 或实际代码执行影响。四个 token 是同一根因，保持一项。
- **FILES-R7-02，行为候选：支持降级。** `glob.ts:90` 先取 walker 前 200，再在 `:101` 排序，fixture 精确证明一个被截掉的文件即使改成最新仍不进入返回页。它不依赖预定文件名遍历顺序，且三文件控制确实有序。不过 `:16` 只承诺返回项按 modification time 排序，没有明确全体匹配中选择最新 200 的合同；当前返回子集确实有序，因此不能仅凭主观分页期待确认 bug。2 pass 原始收据保留，不改 fixture、不继续验证。
- **FILES-R7-03，P3：支持限定范围。** 实际注册在 builtin/index.ts:418–425 把 generic `glob` schema 和 `grepTool` 接入内建工具；`grep.ts:220` 原样给 rg `--glob`，`:268–270` 写明 fallback 等价过滤意图。Node fallback 经 `:170–180` 进入，递归 `:384` 只匹配 basename，故带目录前缀的 glob 会始终失败。Fixture 的 ENOENT 是主动注入的正常缺命令触发条件，actual handler / recursive Node fallback 确实执行，unfiltered 和 `*.ts` 控制证明同一自有文件可读。没有目录限定的 schema 示例，等价语义仍是从 generic glob 与实际转发推断，作者最终稿已明确这一点；没有把真实 rg/grep、所有语法、平台或权限覆盖列为已测。
- **FILES-R7-04，P3：支持。** `read.ts:77–78` 的上限早于 offset/limit 处理，自己的错误消息却推荐后者。6 MiB 文本的两次相同错误和小文件分页控制直接支持“恢复指引不可能成功”，不支持“上限本身是 bug”或“所有访问途径被堵住”。报告保留 Grep 这一可选建议，边界准确。

初稿三处源码引用已通知作者并核对其最终稿：Glob 合同 `:16`；Grep `--glob` `:220`；fallback 注释 `:268–270`。历史查重决定区分了 Glob 的旧 count-header 格式问题、Grep 的旧 exit-code1 问题、Notebook/patch/history 既有项；没有把它们重复计入新问题。

## Providers

已读 `providers-stream-contract.test.ts`、成功首次 log/exit、normalization baseline log/exit，相关 Anthropic/OpenAI provider、ModelFacade、Web reducer 和 TurnLoop 选择性源码。按 root 与作者最终合同核对口径，此方向 **1 项确认 P3（Anthropic）+ 2 个候选（OpenAI、Thinking）**。成功分片分别 **4 pass / 19 expect** 与 **26 pass / 46 expect**，均 0 fail/skip、有 Completed；26 项是六个既有文件的 baseline，成功的 OpenAI 假分块行为测试也不能单凭 pass 升格为确认 bug。Thinking 续轮的独立首次分片 **1 pass / 1 fail / 13 expect / exit 1**，没有 Completed，不能与干净分片合并成“31 项全部通过”。

- **Anthropic 流期间工具进度错误，确认 P3：动态证据支持，最终参数未被破坏。** 直接核对 `packages/core/node_modules/@anthropic-ai/sdk/package.json` 为 **0.39.0**，core/package.json 与 bun.lock 也分别声明/锁定该版本。安装的 `lib/MessageStream.mjs:361–364` 在 input_json_delta 发 inputJson，`:389–390` 才在 content_block_stop 发 contentBlock；`:397–399` 的 start 不发 contentBlock。Fixture 使用这份 SDK 的真实内存流解码，而不是手工触发不符合版本的 emitter 顺序。产品 `anthropic.ts:347–368` 因此丢首个工具参数、把第二工具的参数流挂到前一工具 ID；实际 ModelFacade 和 Web reducer 的错误卡片参数已由 fixture 验证。`:385–397` 从 finalMessage 独立取回正确参数，fixture 的 returned toolCalls 和 transcript 断言也验证这一点。不能说实际工具拿错参数执行，不能推断真实账号/网络/API 被调用。
- **OpenAI 迟到 identity，行为候选：只支持人为分块下流阶段 start 未发。** `openai.ts:831–843` 只在首次 index 入 map 时判断 id/name；`:845–847` 后来补齐字段不再发 start。Fixture 的完整 identity 控制和迟到 identity 对照支持该人为输入下 ModelFacade 流阶段没有对应卡片、最终 toolCalls 完整；但没有实际正常 producer，也没有查明首个空 identity delta 符合某个支持 provider 的有效流合同。代码注释提到 identity 可跨 delta，并不能代替真实可达输入证明。因此 root 将其降为未确认行为候选是必要的。**TurnLoop.ts:1654–1656 会在最终 response 补发未 streamed 的 tool_use_start**，也不能称永久缺卡、工具被丢弃或执行丢失。保留原始通过 fixture/log，不改输入或另找入口重跑。
- **Thinking 续轮：只保留失败分片候选。** 第一次 fixture 的完整 tool_result wire 断言没有计入自动添加的 cache_control，于 `:71` 失败；虽然更早局部断言已运行，整条测试不满足 guarded 零失败完成条件。候选不算第三项确认，fixture/log 未改、未重跑，也没有通过移除断言或另一入口补验证。

已复核最终 `providers.md`、`providers-findings.json`、`providers-candidates.json` 与 `providers-validation.json`：确认 ID 为 **PROV-R7-01 / P3 / anthropic.ts:347**，两个候选为 **PROV-R7-C1 / C2**，30 clean tests / 65 expectations 与失败分片 1 pass / 1 fail / 13 expectations 分账吻合。其外部官方页面陈述本复核未重新联网读取；thinking 无论外部合同如何，仍受首次失败后的跳过约束。作者已更正报告开头与结构化 finding：Read/Write 是 provider fixture 借用的名称，`path/content` 是合成 args、请求 `tools=[]`，没有验证实际内建工具使用的 file_path schema 或执行工具；真实已声明工具经过相同逻辑的传播明确标为源码推断。ID 对应错误本身不依赖键名，没有改动 fixture 或重新执行。

Files validation 内四个 fixture、四个 raw log、四个 exit 的 SHA 均与实际字节吻合。Providers 最终材料也已完成只读字节核对：**18 个 Git 来源**的 frozen SHA、当前 SHA 和字节相等；**5 个共享 SDK snapshot** 的 logical import path、实际 resolved path、bytes 与 SHA 全部相符，确为既有 primary node_modules 内的 0.39.0，而非 Git frozen blob；**21 个 artifact receipt 条目**的 bytes/SHA 均与落盘材料相符。该收据不包含自身，root 最终 evidence-index 仍负责整批材料哈希。全部核对差异为 0。

已读 `providers-metadata-assembly-note.md`：两次元数据路径计算错误分别为共享依赖 resolved path 不在工作树根内，以及误写 SDK `lib/streaming.mjs`（实际在包根）。转录明确不是新执行所得的 raw log，只修收据路径后重新组装元数据；这些不属于 Bun 测试分片，不能与产品测试通过/失败数量混算。没有修改或重跑产品 fixture，thinking 的首次失败与 SKIP 状态仍保持。

本交叉复核没有剩余待定事项，没有其他实质反证或新增缺陷；新增/修复/执行/重跑测试始终为 0。
