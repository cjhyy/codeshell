# Profile 静态插件导出

本实现属于 v0.9.28 tag 之后的下一批变更。入口仅在 Settings → 数字人 → 高级导出；原 JSON 定义导出保留，数字人卡片与侧栏没有新增出口。需要已有项目或会话的 configurationTarget，不能由 renderer 指定 cwd 或输出路径；no-repo 在 authority resolver 之前拒绝，预览不会为此创建工作目录。

导出的是 **CodeShell 静态插件（CC 目录格式）**，验收消费者是现有 CodeShell 本地插件安装器、Skill scanner、Agent registry 和 spawn overrides。未验收真实 CC 执行，不宣称 Codex 兼容、其他宿主具有相同的 Agent 权限约束或与 Profile 等价。

## 内容与损失

用户逐项选择 Profile 明确引用的 Skill/Agent，审阅生成文件的完整纯文本、SHA-256、确定的名称映射和损失清单，明确接受后才打开原生 SaveDialog 创建新目录。Skill 附属文件只列出非隐藏 `.md`/`.txt`，必须另行勾选才读取或复制；不会复制整棵 Skill/插件根目录、脚本或二进制资产。

生成 `.claude-plugin/plugin.json`、Skill/Agent Markdown、README 和 schemaVersion=1 的 export-report.json。报告只含组件标识、来源类别、阻断原因、损失、文件字节数及哈希，不含绝对私人源路径、credential receipt、原 MCP/source 配置或 acquisition 命令。报告的 files/packageDigest 覆盖自身之外的所有生成文件；预览另显示报告本身的 SHA-256，避免自引用哈希。

- Profile mainInstruction 默认不含。用户可选为 `docs/profile-instructions.md` 参考文件，不会注入、创建 hook 或自动加载。
- portable memory、项目经验、Session、credentials 不读取、不复制。plugins/requires/MCP/sourceAccess/exclusive 策略只生成脱敏的数量/损失说明；不获取依赖、不安装、不激活 Profile/plugin。
- Agent `tools`/`skills`/`mcp` 的 absence 与显式 `[]` 保留为继承与空池。非空 Skill 引用仅映射到本次明确选中且可导出的实际 Skill；源插件 Agent 的 bare Skill 引用按现有 loader 规则先解析 namespace，安装后由 spawn adapter 加上新插件 namespace。非空 MCP 或 MCP tool 引用不能映射，组件阻断。
- 未支持的 frontmatter（包括 hooks、permissionMode、fork 等）阻断，不通过丢字段放宽权限。同名 Agent override、缺失引用和本地字面 `p:x` 与插件名称冲突均明确阻断，不能静默替换正文/策略。
- Skill 非空 `allowed-tools` 在 CC 中属于预批准授权，本版阻断；空字符串/`[]` 仅保存空 policy，不称为 deny-tools。当前 CodeShell 不实施该 Skill 前置授权。正文中的 inline `!` 加反引号或 fenced 动态标记也阻断，包括字面示例，不执行、不静默删除。参考 [CC 动态上下文](https://code.claude.com/docs/en/skills#inject-dynamic-context) 和 [Skill 工具预批准](https://code.claude.com/docs/en/skills#pre-approve-tools-for-a-skill)。
- 正文里的外部引用不会重写；工具、模型和 sandbox 的可用性仍取决于接收端。静态文本也可能含秘密/私人路径，需用户完整审阅，导出器不作“正文绝无秘密”的承诺。

## 来源、快照与写入边界

Profile 内部 name 必须匹配被选目录。项目/会话 authority 决定实际 cwd；Skill 使用原 scanner 的项目 `.code-shell` → 项目 `.agents` → 用户来源优先级，插件使用原 registry 的确定顺序；Agent 保持 user → plugins → project 的声明名解析顺序，对同名覆盖明确阻断。用户源复用原 Agent loader 的 userHome，HOME/USERPROFILE 不同值的回归与实际 scanner/registry 比较。

源文本总读取预算 4 MiB，单文本 256 KiB，目录 inventory 256 entries/8 层；生成包最多 4 MiB UTF-8、256 文件、单文本 256 KiB。超限报错/阻断，不能截断后成功。选中文本通过非 symlink 路径、O_NOFOLLOW、open/fstat、inode/size/时间戳和读取后身份核验；仅 UTF-8 文本。这里限制 UTF-8 payload 与 bounded metadata，未声称 JavaScript 的物理 heap 恰好等于 payload 字节数。

Main 最多保留四份有界私有 RAM review（每个 renderer owner 一份，十分钟自动释放）。取消、窗口销毁、替代预览或过期使 token 失效；preview 迟到响应不能覆盖较新 context。commit 使用审过的字节，源文件之后被替换也不重新读取；选择变化必须重审。每次 await authority 与原生 picker 返回后重新核验 owner/configurationTarget；最终解析期间窗口或 frame 归属改变、context 改变或取消均不写包。

输出采用 exclusive mkdir，新目标必须不存在（包括已有空目录），不使用可能覆盖空目录的 POSIX rename。文件 wx/O_NOFOLLOW、open/fstat 核验并 fsync；manifest 最后写。POSIX 先 fsync payload 目录/root/parent，再写 manifest 并 flush 其目录；Windows 只承诺 regular-file flush，不宣称目录 crash-atomic。旧安装器未改成 manifest-only，导出也不承诺整个目录对并行外部进程不可见。失败只删除 identity 相同的自建文件，并用非递归 rmdir 清理自建目录；未知新增或替换的内容保留，错误提示可能有不完整目录，不能递归删除用户数据。

## 验收

Guarded private-HOME 单元回归覆盖选择/空壳、默认与空 allowlist、冲突/缺失、动态标记、预批准、no-repo 零 resolver/零 native dialog、Main owner/context/cancel、源替换、损坏 Profile 错误脱敏、UTF-8/symlink/单文件/总量/目录 inventory 边界，以及现有高级入口和完整文本/loss 接受按钮。

`node scripts/run-isolated-node-smoke.mjs scripts/smoke-profile-plugin-export.mjs` 在 Core import 前隔离 HOME 并拒绝全部网络，用已编译 Core 与真实 Main 写入 adapter 完成：源插件 bare Skill 引用 → 导出 → 原 installer preview → 明确 install → 原 Skill/Agent loader → resolveAgentTypeOverrides，最终 namespace 精确匹配新插件。禁止读取的 memory/credentials/MCP/source 文件带 sentinel 且通过实际 open/read guard 核验零读取；另注入 native EIO，验证 payload barrier 失败无 manifest，并保留未知文件。没有真实模型、OAuth、账号或第三方写入。

`node scripts/run-isolated-node-smoke.mjs packages/desktop/scripts/e2e-profile-plugin-export.mjs` 在独立私有 HOME、pre-Core 网络 guard 下打开真实 Electron 的 Settings 高级入口，使用生产 Main/preload/renderer preview IPC，验证组件/附属文本选择、完整长文本、损失说明和接受门槛；1440/820/390 px 布局无横向溢出，可用 `--screenshot-dir` 保存截图。只有 `dialog.showSaveDialog` 取消结果被 stub，生产 commit handler 保持真实；这不代表物理点击原生 sheet，取消后没有写包。该 fixture 已加入 Desktop E2E。
