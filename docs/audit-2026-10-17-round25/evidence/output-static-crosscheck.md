# Output CRLF 独立静态交叉审查

结论：**支持收窄到 P2 的普通 BashOutput 日志正文丢失**。触发条件是一次读取所见的原始短输出已含完整 CRLF 完成行；并非所有后台命令、所有读取时机都会丢失。根因与实际普通消费者均已静态建立。此稿未读取本批动态 raw/exit，不预称作者测试通过；叶子 actual 结果与生产链静态证据应分别登记。reviewer 产品/import/test/fixture/VM/AST/native/browser/network/auth/security/custody 实验及 Git 写入均为 **0**，只新增本文件。

冻结与复核时点：`2026-10-17 10:17 UTC`，branch `codex/audit/crlf-output-round25-20261017`，HEAD/full frozen `8b9677c78d150abe9681a2f65ab8e55b1288be4b`。先全文读取 CODESHELL；以下 source bytes 均独立对照该 Git blob，current==frozen，Git show/rev-parse/branch 元数据命令均 exit 0。全字节 hash 不是全文语义审查或源码执行。

| 实际静态阅读范围 | 文件 SHA256 |
| --- | --- |
| `CODESHELL.md`，full 217 | `56d9ffdd81b6f6f615ed7a7392ddfa60ec4338c0ccb88eef20c4b73ad8dad5a2` |
| `runtime/output-clean.ts`，full 45 | `e1f7e179003f57dcf3c07da35f76860151e6703de989b0f04db58acbe99bb86a` |
| `runtime/output-clean.test.ts`，full 34 | `5118d580eeb7038205e16ad0a050a74c0e1d51a00ae19abadb71742e5a57b127` |
| `runtime/background-shell.ts`，selected 1–63、208–229、280–345、418–535 | `dabb4c006d1aa10fbb8e916e4de716c3382908a80fb9e8c73224a96562a8f0f5` |
| `tool-system/builtin/background-shell-tools.ts`，selected 1–79 | `e52c34e95dc2ca15dbad41491323f23cfecfd66d9701f1b06903aa3ee8b5f5e6` |
| `runtime/ring-file.ts`，full 188（1–172、170–188 分段） | `f3981f59140f06ce2aa138bd15b26a08ad4cff9dd46b76b7c3b57f7bab81fdcd` |
| `tool-system/builtin/bash.ts`，selected 24–64、120–129、203–239 | `f5bbf67f296aaff1b3d154b194e40d1362cb010257b44607a3704897cec67e22` |
| `protocol/server-output.ts`，full 51；没有发现它参与这个 cleaner 链 | `c7025b3360f8039090b06d320d29c70da35b7fda2a1d3e440b4eb2eb2bdb2c76` |
| `runtime/background-shell.test.ts`，selected 110–175、177–220 | `c2be42cc868eed0fdac3a4b7c68765732a70a3be3a7cb3e0faf1e7b039071170` |

表内除 instruction 外均在 `packages/core/src/` 下。读取 ring 的真实 FS 实现仅是静态反证，没有 import、构造或调用 RingFile/manager/BashOutput，也没有执行所读混合测试。

普通入口并不依赖“Windows 通常如何换行”的假设。[Bash](../../../packages/core/src/tool-system/builtin/bash.ts#L37) 合同接受普通 shell command，当前后台参数也接受长任务，:124 与 :218 将同一 command 送给 manager；manager :216 以 stdout/stderr pipe 捕获输出，:328–342 的普通 onData 直接将 Buffer 交 ring.write，没有限制只能 LF，也没有先剥 CR。RingFile :96–112 保留短 Buffer，:120/:147 读取 UTF-8/raw slice；所以普通命令输出完整 CRLF 文本时，能沿真实入口到达 cleaner。这里证明的是源码容许且直接承载这种正常日志数据，**没有运行某个实际命令或证明具体平台频率**。

合同不是任意控制字节逐字保留：[cleaner 说明](../../../packages/core/src/runtime/output-clean.ts#L1) 明确去 ANSI/进度噪声，BashOutput :28–29 承诺读取输出并剥颜色/进度条；现有 :21–22 test 明确保留普通 LF 正文。[设计父段](../../superpowers/specs/2026-06-05-background-shell-design.md#L126) 同样区分 raw 保真与 clean agent text。CRLF 完成行的可见正文不是一个已经过时的进度帧；可把 CRLF 规范化为 LF，但不能由清理合同推出应把所有完成行正文清空。

根因定位在 [foldProgressLines :34–37](../../../packages/core/src/runtime/output-clean.ts#L34)：按 LF split 后，每条 CRLF 行的片段以 CR 结束，lastCr 指向末字符，slice(lastCr+1) 便取空尾。小型 `ready\r\nnext\r\n` 的源码推导是只剩 `\n\n`；这是静态推导，未在本 reviewer 中计算或调用函数。LF 行没有 CR，保持正文；裸 CR 的 `10%\r100%` 保留最后帧，是原有有意合同，不另报。混合输出只影响含这个 CRLF 结尾的完成行；没有最后换行的末行、读取恰在 CR/LF 之间等时机不在“每行必丢”的断言范围。

传播链清楚且无需大输入：[readOutput](../../../packages/core/src/runtime/background-shell.ts#L455) 的 all 在 :461–467 把原 retained text 直接 clean；incremental 在 :479–500 先拿 raw bytes、推进原始字节 cursor，再 clean。对于远小于 16KB 的完整 CRLF 行，两模式都会丢正文；incremental 后续正常增量读不会重新返回已消费的 raw bytes，改为 all 也仍经过同一 cleaner。BashOutput :58–61 直接输出 res.text，残留 LF 的 length>0，因此通常是**空白行**，不能笼统说工具一定显示 `(no new output)`。header/status 仍可返回，不能称整个工具失败或完整 LLM 回路已复现。

raw 反证也成立：onData 先写原 chunk，RingFile :173 写该 chunk、:183 写 retained raw buffer，cleanOutput 不回写 ring/disk。readOutputRaw :423–425 提供未清理文本。因此影响限于 agent-facing 日志投影，可能遮掉就绪信息或错误正文，**不是磁盘损坏、永久丢失全部日志、权限绕过或进程行为缺陷**。disk mirror 是 best-effort 且会按既有 cap wrap；本稿不承诺 OS 落盘成功，也不重验磁盘退化与 wrap。

已读 [data-prep proposal](data-prep/proposal.json)、source manifest、history 结构/计数/命中选段与 [selected history](data-prep/selected-history.json)。prep 的旧 2451 文件（1233 MD/1218 JSON）、405154 string/575335 scalar、exact177/newline16 命中是其时点结果；独立递归扫描全部 prior docs/bugs 的 MD 与 parsed JSON **值标量**（含 archive/_archive，排除 round25）得到 **2453 文件=1234 MD+1219 JSON，405166 strings/575356 scalars，0 parse errors**。增加的两个文件正是 round24 的 aggregate-metadata-notes.json 和 review-aggregate.md，不混成一次扫描。三个独立查询 mechanism/old_bash/crlf_other 分别 **46/32/16** 命中，初次各保留最多35个上下文、每段最多650字符；mechanism 再静态过滤普通路径库存/validation 复制项补读语义段。关键词、截取与 hash 都不是穷尽语义无重复证明。

去重判断：旧大 burst #5 是 >16KB 时尾裁剪且 cursor 跨过前字节，现有 :188–220 regression 与当前 :470–495 分页注释清楚；本项在两行短 ASCII、all 模式也成立，不借旧 cap/大输入失败证明。ANSI/OSC 残留、TUI sliceAnsi/字素宽度与本项不同，未调用这些 helper 或恢复旧失败。round6 [Skill/agent CRLF](../../audit-2026-10-17-round6/skills-agents.md#L36) 是 frontmatter 开头 delimiter 不匹配且首次依赖失败，保持 SKIP；round19 [simple diff](../../audit-2026-10-17-round19/simplediff.md#L9) 明示换行归一化，保留正文；round21 [NDJSON](../../audit-2026-10-17-round21/ndjson.md#L15) 为 JSON 行解析/CRLF stream 控制；round16 [tasknoise](../../audit-2026-10-17-round16/tasknoise.md#L21) 的 cleaned 不进入普通任务内容。以上均不构成相同 cleaner 正文丢失，也没有重跑旧测试、权限失败或原生方向。旧 runtime-round3 :1–47 另全文静态导航，其 job/Host/pipe 问题与本项无因果关系，未重验。

历史实际阅读及 SHA（均 frozen/current 相同）：设计父段 :104–135（另 rg 导航命中）`aa6a68e5724760259bd7122ef365e97ba3477d8717f1858a06dd3bd2ad4f0903`；archive runtime :104–128 及 :19/:68 `6a5acecf8d73d8fb134e1987b422078f3aa2cb7f8ba8f8b3be4f7b02a71ab1a2`；skills :25–51 `efff8f799481911e0b3c3b8ac3c0a4686411f55336f97abeb4d64b2c8dd22ec4`；simplediff :1–30 `a2309fec29f3e213c772d7010a5456cbd41519fb355cd628bb40c8ef1fbfc930`；ndjson full29 `c1427ad4ff04aeab42227365d41f8823b591da6fb4d98d2b7b35f2242095f153`；tasknoise :13–29 `4a77837071c75a6a41c8e2ed596c1bfb52cf66500e9e02ef36660e5fd48d78b1`；runtime-round3 full47 `d3873d2f368812e049bda27862bca1b6a7a026a2c6d451e2b12765888a5230d7`；beta-prep :548 仅 rg 一行 `2cadf52899194bd9532e4d3890a1ccad64cb94e48c2cadcef6fe7e8c1f842f1c`。后者旧“干净”评语不替代当前完整合同证据。

prep 当前字节收据：source-manifest 6557B/`46a7aa416f01b28139c328319497dc3157a6bd2daba4434601a67604ed5f3206`；history 551527B/`ecf1e8e1b037f7a34cd69607489ab5c3c32405dd7f1434e81df4e05f2c0755ea`；selected-history 11503B/`992c03f920760ecf7ce5b9121f46fd9aae416954867b9826a69563a2155a2635`；proposal 6902B/`06bd96fb199dbf0ba3d0104e32ededd504b4d74ba41d6d42696d42ac8804e8fc`。没有把 prep 对 memory/format 等排除方向的 hash 或原 full 声明当本 reviewer 新阅读。

元数据命令范围：cat CODESHELL、rg --files/rg -n/-l 导航、Python 标准库 read_text/read_bytes/json/re/hashlib 与递归标量搜索，及 read-only git show/rev-parse/branch；没有执行产品或测试命令。独立扫描 session65477、语义补读 session10976 均同 handle 收至 exit0，没有 restart。首个库存命令误把不存在的顶层 server 作为 rg 输入，显示 No such file；管道外层 exit0，未编造内层 exit，跳过该路径。两次合并输出显示截断，后续只补所需源码分段/JSON 选段，未认领未显示段为语义已读。prep 原 metadata 拼写/猜路径失败继续由其 notes 保留；没有修改它们或恢复旧失败方向。

完整仓库路径、上述已读范围与读取时 SHA 另见 [17 项 static source manifest](output-static-source-manifest.json)；清单整理没有增加阅读或运行。
