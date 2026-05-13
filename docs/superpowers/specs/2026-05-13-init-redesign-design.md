# /init 重设计 — 简短 spec

日期:2026-05-13
状态:草案

## 一句话

把当前 3 态 `/init`(create / migrate / improve)扩成 4 态,新增 **empty** 处理真空 repo,通过升级版 `AskUserQuestion` 多选面板反问用户;顺便把 prompt 从 TS 字符串抽到 `.txt` 模板,并补上 `.codeshell/rules/` 的 opt-in scaffold。

## 来源对比

四家 `/init` 比下来:Claude Code 最完善但耦合多;OpenCode 最克制(prompt 模板化、negative space 框架、严格反问上限);Codex 最简陋(不覆盖、不迁移);当前 `init.ts` 已经接近 Claude Code 路线。

取舍:**Claude Code 的三态意图 + OpenCode 的 prompt 工程化与节制 + 已有的 inject + 新增 empty 反问**。

## 架构

```
detect(cwd) → 4 选 1:
  hasCodeshell                                  → improve
  任一其他 AI 配置(7 种来源)                   → migrate
  hasManifest || hasSourceFiles || hasReadme    → create
  否则                                          → empty   (新)

每态对应一份 .txt prompt → ctx.client.run → 写 CODESHELL.md → inject 到 transcript

主流程后 opt-in 面板:.codeshell/rules/ scaffold(仅 create / migrate)
```

## 关键改动

### 1. `detect` 新增三字段判真空

```ts
hasManifest: boolean;     // package.json / Cargo.toml / pyproject.toml / go.mod / pom.xml / Gemfile / mix.exs
hasSourceFiles: boolean;  // 根 + src/ 两层、≤50 文件扫描,跳过 node_modules / dist 等
hasReadme: boolean;       // README.{md,rst,txt}
```

### 2. Prompt 抽到 `.txt` 模板

```
src/cli/commands/builtin/init/templates/
  create.txt   migrate.txt   improve.txt   empty.txt
```

占位符:`${cwd}` `${targetPath}` `${existingConfigs}` `${detectionSummary}`。tsup 配置 `.txt` loader 或运行时 readFileSync(`package.json` 的 `files` 字段记得加上模板路径)。

### 3. `AskUserQuestion` 工具升级(对齐 Claude Code)

旧:`{ question: string } → string`
新:
```ts
{
  questions: [{
    question: string,
    header: string,                 // ≤12 字符
    multiSelect: boolean,
    options: [{ label, description }],  // 2-4 个,自动追加 Other
  }],
} → { [question]: string }
```

UI:`AskUserPrompt.tsx` 重写,所有 question 一次性呈现,Tab 切块、方向键选项、Other 弹文本框、Esc 取消。

工具内 callCount 上限 = 2(empty 模式专用,通过 `/init` 在跑前调用 `setSessionLimit` 启用)。

### 4. Empty 模式 prompt(empty.txt)

LLM 用升级后的 `AskUserQuestion` 一次问 3-4 个核心问题(项目意图 / 技术栈 / 运行时形态 / 约束)→ 用 Write 写 CODESHELL.md。最多追问 1 次。未明项用 `# TODO(user): ...` 占位。

### 5. Migrate prompt 措辞收紧

将既有 AI 配置(`.cursorrules` 等)视为"调查证据"而非"待复制文本",只保留能在代码库验证的陈述。

### 6. Rules scaffold opt-in

主流程后(仅 create / migrate,且 `.codeshell/rules/` 不存在),弹单问题面板:不拆 / LLM 拆 / 生成空骨架。LLM 拆走 `split-rules.txt` prompt。

## 不变量(硬约束)

- 只写 `CODESHELL.md`(可选 `.codeshell/rules/*.md`),绝不动 `settings.json` / `settings.local.json`
- improve 模式强制用 Edit(出 diff,不用 Write)
- 跑完 inject 生成的 CODESHELL.md 到 transcript

## 不做(显式 YAGNI)

- Codex 那种"已存在拒绝覆盖"行为 — 与 improve 模式冲突
- AskUserQuestion 的 `preview` / `annotations` 字段(Claude Code 有,我们 init 用不上)
- 并发 `/init` 防护
- 真调 LLM 的端到端测试

## 风险

- **breaking change**:`AskUserQuestion` 签名变了,影响所有现有 caller(目前 ~8 处文件引用,需逐一迁移)
- **LLM 不熟新工具签名**:OpenAI 模型可能不熟,需在 prompt examples 里讲清
- **`.txt` 模板发布漏带**:`package.json` 的 `files` 必须包含模板路径,启动时一次性 require 失败抛清晰错误

## 改动文件清单

新增:
- `src/cli/commands/builtin/init/detect.ts`
- `src/cli/commands/builtin/init/index.ts`(替代当前 `init.ts`)
- `src/cli/commands/builtin/init/rules-scaffold.ts`
- `src/cli/commands/builtin/init/templates/{create,migrate,improve,empty,split-rules}.txt`
- `tests/init-detect.test.ts`
- `tests/ask-user.test.ts`(更新现有)

修改:
- `src/tool-system/builtin/ask-user.ts` — 签名升级 + callCount
- `src/tool-system/context.ts` — `askUser` 接口升级
- `src/ui/components/AskUserPrompt.tsx` — 多问题多选面板
- `src/protocol/server.ts` — 转发新 askUser 形态
- `tsup.config.ts` — `.txt` loader 或 readFileSync 路径
- `package.json` — `files` 字段含模板

删除:
- `src/cli/commands/builtin/init.ts`(被 `init/index.ts` 取代)
