# 权限路径级前缀规则设计

> 2026-06-07 · core + desktop · 权限增强(承接 2026-06-07-permission-scope-ui)

## 背景与问题

`buildProjectRule`(`tool-system/permission.ts`)给 Bash 收窄到 head 命令(`git status` → `^git(\s|$)`),但**文件工具(Write/Edit/ApplyPatch)只到工具粒度**:

```ts
return { tool: toolName, decision: "allow" };  // 无 argsPattern = 放行所有路径
```

后果(真·权限过宽漏洞):用户批准"本会话允许 Write `src/foo.ts`",实际等于**本会话允许 AI 写任何文件** —— 含 `~/.ssh/config`、`.env`、repo 外文件,都不再问。Bash 早已修过同类问题(批准 `git status` 不放行 `rm`),文件工具还没。

## 决策(已确认)

- **范围三档**:批准文件工具时,UI 给 `仅此文件 / 此目录(及子目录) / 该工具所有路径`,**默认选「此目录」**。
- **匹配语义**:绝对路径前缀正则(`^<escaped-abs-prefix>`),与现有 `ruleMatches` 的 argsPattern 正则机制一致(底座现成,`ruleMatches` 已对任意 arg 跑正则)。
- **repo 外**:首版不特殊处理(敏感路径有独立 `enforcePathPolicyWithApproval` 门兜底,本功能职责单一)。

## 范围(YAGNI)

**做**:文件工具(Write/Edit/ApplyPatch)批准时按路径粒度生成规则;UI 在范围选择里加路径粒度;路径规范化防 `../` 遍历。

**不做**:glob 语义(用前缀正则)、repo 外更严策略、非文件工具的细粒度(Read/Glob/Grep 等读工具不在此列——它们的过宽风险低,且本功能聚焦写)、审计日志(P0 单列项)。

## 架构 / 数据流

```
ApprovalCard(desktop)
  范围菜单从 [仅本次/本会话/本项目]
  扩成:文件工具时,每个"记住"档再选路径粒度(file/dir/tool)
  → onDecide(decision, reason, scope, pathScope?)
      │
App.decideEnvelope → preload approve(..., scope, pathScope)
  decision = { approved, always, scope, pathScope }   ← ApprovalResult 加 pathScope
      │
core InteractiveApprovalBackend.requestApproval
  buildProjectRule(toolName, args, pathScope, cwd)   ← 新增 pathScope + cwd 入参
      │
  文件工具 + pathScope:
    "file" → argsPattern { file_path: `^<escape(abs)>$` }
    "dir"  → argsPattern { file_path: `^<escape(absDir)>/` }   (含子目录)
    "tool" / 省略 → 无 argsPattern(旧行为,全工具放行)
  ApplyPatch(路径在 patch 文本里,非 file_path):见下「ApplyPatch 特殊处理」
```

### 类型变更(core)

`ApprovalResult` 加可选 `pathScope?: "file" | "dir" | "tool"`(approve 分支)。省略时 `buildProjectRule` 维持旧的工具粒度,保证回归安全。

### buildProjectRule 重构

```ts
type PathScope = "file" | "dir" | "tool";
buildProjectRule(toolName, args, opts?: { pathScope?: PathScope; cwd?: string }): PermissionRule | null
```

- Bash 分支不变(head 命令收窄)。
- 文件工具(Write/Edit):读 `args.file_path`,`resolve(cwd, file_path)` 规范化(吃掉 `../`,防遍历),按 pathScope 生成 `file_path` 正则:
  - file → `^<esc(abs)>$`
  - dir  → `^<esc(dirname(abs))>/`(注意尾 `/`,避免 `src` 误匹配 `src-foo`)
  - tool/缺省 → 无 argsPattern
- 纯函数把"abs + pathScope → argsPattern 正则"抽出来单测(`pathRuleArgsPattern`)。

### ApplyPatch 特殊处理

ApplyPatch 的路径不在 `file_path`,在 `patch` 文本(多文件)。首版策略:ApplyPatch 的"目录/文件"粒度复用已有的 `patchBackupTargets(patch, cwd)`(Undo 时写的)取受影响文件;但**一条 PermissionRule 的 argsPattern 只能对单个 arg 写一个正则**,多文件补丁难用单正则表达。**首版决定**:ApplyPatch 只支持 `tool` 粒度(沿用旧行为),路径粒度选项在 ApplyPatch 审批时不出现(UI 按工具类型决定显示哪些档)。Write/Edit 拿到 file/dir/tool 三档。这把复杂度挡在门外,且 ApplyPatch 本就有原子性 + 路径策略门兜底。

### UI(ApprovalCard)

承接 split-button:点 ▾ 展开后,**文件工具(Write/Edit)** 的"本会话/本项目"档各带一个路径粒度子选择(file/dir/tool),默认 dir。非文件工具 / ApplyPatch 维持原三档(once/session/project,工具粒度)。

具体形态实现期定(子菜单 or 档位平铺);纯函数 `approveChoicesFor(toolName, filePath)` 决定给哪些选项,可单测。

## 边界与正确性

- **路径规范化**:必须 `resolve` 后再生成正则,否则 `src/../../../etc` 这类会绕过前缀意图。规范化在 core(backend 有 cwd)做,不信任 UI 传来的字符串。
- **dir 前缀尾 `/`**:`^/repo/src/` 不能写成 `^/repo/src` —— 后者会匹配 `/repo/src-secret/x`。
- **正则转义**:路径含正则元字符(`.` `(` 等)必须 escape(已有 `escapeRegex`)。
- **回归**:pathScope 省略 → 旧工具粒度行为,现有 permission 测试不变。

## 测试 / 验收

- **单测** `pathRuleArgsPattern`(纯函数):file→`^abs$`;dir→`^absdir/`;tool→null;`../` 规范化后前缀正确;元字符转义。
- **单测** buildProjectRule:Write + pathScope dir → 正确 argsPattern;ApplyPatch + 任意 pathScope → 工具粒度(无路径正则);Bash 不受影响。
- **单测** ruleMatches 回归:`{file_path:"^/r/src/"}` 规则匹配 `/r/src/a.ts`、不匹配 `/r/lib/a.ts` 和 `/r/src-x/a.ts`。
- **单测**(desktop)`approveChoicesFor`:Write→file/dir/tool;ApplyPatch→仅 tool 档;Bash→原样。
- **回归**:core permission 测试 + desktop approval 测试全绿;两端 tsc。
- **手动 smoke**:批准 Write src/a.ts「本会话·此目录」→ AI 可写 src/ 下其他文件不再问,但写 ~/.x 仍弹审批。

## 影响文件

- core:`tool-system/permission.ts`(buildProjectRule 加 pathScope + 抽 pathRuleArgsPattern 纯函数;requestApproval 透传 result.pathScope)、`types.ts`(ApprovalResult 加 pathScope)。
- desktop:`approvals/approvalDecision.ts`(approveChoicesFor + 选项扩展)、`ApprovalCard.tsx`(范围菜单加路径粒度)、`App.tsx`/`preload`(透传 pathScope)。
