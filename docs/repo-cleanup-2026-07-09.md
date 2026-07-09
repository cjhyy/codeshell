# Repo 清扫报告（2026-07-09）

## ① 已删清单（每条理由）

盘点基线：

- 初始 `git status --porcelain` 为空，工作树干净。
- 初始 `git ls-files --others --exclude-standard` 为空，没有未跟踪且未被 `.gitignore` 覆盖的游离文件。
- `git ls-files | rg -i 'dist/|\.turbo|node_modules|\.DS_Store|\.log$|coverage/|\.tsbuildinfo'` 无命中，没有误跟踪的构建产物、缓存、日志、coverage 或 TypeScript 增量文件。
- 删除前对目标路径执行 `git ls-files -- <targets>` 无输出，确认全部为未跟踪/已忽略本地产物，因此本次没有使用 `git rm`。

已删除：

- `.DS_Store` 系统元数据，约 80K：`.DS_Store`、`.code-shell/.DS_Store`、`docs/.DS_Store`、`docs/core-deep-dive/publish-assets/.DS_Store`、`docs/core-deep-dive/assets/.DS_Store`、`packages/.DS_Store`、`packages/desktop/.DS_Store`、`packages/desktop/out/.DS_Store`、`packages/desktop/src/.DS_Store`。理由：macOS Finder 产物，`.gitignore` 已覆盖，无源码引用。
- ignored build outputs，约 1.52G：`dist/`、`packages/cdp/dist/`、`packages/core/dist/`、`packages/tui/dist/`、`packages/desktop/dist/`、`packages/desktop/out/`。理由：构建产物，可由 `bun run build`、desktop 构建或对应 package build 再生成；未被 Git 跟踪。
- Vite/Vitest 本地缓存，约 22M：`packages/desktop/node_modules/.vite/`、`packages/desktop/src/renderer/node_modules/`。理由：测试/开发缓存，位于 ignored `node_modules` 路径下，可再生。
- `.code-shell/tmp/`，约 2.8M。理由：本地 agent 临时预览/检查产物；保留 `.code-shell/settings*.json`、`.code-shell/agents/` 和 `.code-shell/generated_images/`，避免误删本地配置或仍可能有用的生成图。
- `packages/desktop/.preview/`，约 52K。理由：本地预览 scratch，`.gitignore` 已专门覆盖。
- `log/`，约 2.4M。理由：本地 session-recorder/debug 日志，`.gitignore` 覆盖，源码只约定运行时可重新写入。

清理后复查：

- 删除动作后、写入本报告前，`git ls-files --others --exclude-standard` 仍为空；写入报告后，当前唯一未跟踪且未忽略的文件应为本报告本身。
- 临时/草稿模式复查无输出：`.DS_Store`、`*.tsbuildinfo`、`*.log`、`*.bak`、`*.orig`、`*~`、`tmp*`、`scratch*`、`test-*.png`、`foo.ts`、`a.md`、`aaa.md`。
- 本次清理范围内剩余的 ignored 本地目录主要是 `.code-shell/` 与 `packages/desktop/.code-shell/`，内容是本地 settings、agents 或生成图，未直接删除；`node_modules/` 作为依赖安装目录保留。
- `bun run typecheck` 通过，exit 0，输出为 `tsc --noEmit`。

## ② 建议清单（等卡密sama拍板，含体积）

- `docs/review-2026-07-09/`，840K：编号 Markdown、`README.md`、`GUIDELINE.md` 是本轮架构审查长期资料，按约束保留。HTML 只有两个，不是多版本大包：`visualization-flow.html` 84K 是 README 标注的当前主版本，`visualization-v3.html` 72K 是 bug/finding 定位版本。建议默认保留两者；如果只想保留一个可视化入口，再拍板是否归档或删除 `visualization-v3.html`。
- `docs/core-deep-dive/`，41M：README 标注为推荐入口的 core 深度解析系列，体积主要来自长期配图资产。建议保留，不作为清理对象。
- `docs/archive/todo/desktop-streaming-markdown-autoscroll-plan.md`，40K：`docs/todo/README.md` 已标注“已实现/归档候选”。建议确认已并入 main 后移到 `docs/archive/`。
- `docs/archive/todo/credentials-partition-fix-demo.html` 36K、`docs/archive/todo/memory-demo.html` 60K：独立 demo HTML。建议确认对应设计是否仍需要可视化 demo；若不再需要，归档或删除。
- `docs/todo/fix-batch-*.md`、`fix-compaction-2026-07-08.md`、`fix-review-followup-2026-07-08.md`、`fix-verify-2026-07-08.md`、`final-signoff-2026-07-08.md`，合计 88K：看起来是 2026-07-08 修复过程产物。建议确认对应批次已落地后归档到 `docs/archive/`，或合并成一份收尾记录。
- `docs/todo/review-*.md`，合计 192K：多份 2026-07-08 review/audit 过程记录。建议确认哪些仍代表未完成工作；已完成的移动到 `docs/archive/`，仍待办的保留在 `docs/todo/` 并登记到 README。
- `docs/todo/plan-group-*.md`、`plan-overall-small-features.md`、`plan-todo-batch-2026-07.md`、`arch-plans-and-verification-2026-07-08.md`，合计 176K：批次规划和验证过程文档。建议确认落地状态，已完成的归档，仍待实现的保留。
- `docs/archive/plan-2026-07-09-input-attachment-pipeline.md` 48K、`docs/archive/plan-2026-07-09-input-attachment-pipeline-IMPL-NOTES.md` 8K：近期输入附件特性的设计/实现笔记。建议确认 feature 已落地后，要么归档，要么把长期结论沉淀到 `docs/architecture/` 后删除过程笔记。
- `.code-shell/generated_images/`，30M：ignored 本地生成图，共 19 个 PNG。它不污染 Git，但占磁盘；建议由本机 owner 确认是否仍需这些图，不需要时可整体删除或移出仓库目录。
- `packages/desktop/.code-shell/settings.local.json`，4K：ignored 本地配置。建议保留，除非确认该 desktop 子目录本地设置已不再需要。
- `TODO.md`，12K：非空根 roadmap；按约束未改动。`docs/todo/README.md` 也明确根 TODO 与 `docs/todo/` 分工不同，建议保留。

## ③ .gitignore 改动

本次补充：

- `.turbo/`：防止 Turborepo 或相邻工具缓存进入工作树。
- `.vite/`：覆盖 package/root 级 Vite cache；已有 `node_modules/` 只能覆盖当前这类 `node_modules/.vite`。
- `*.tmp`：覆盖通用临时文件后缀。
- `*.bak`、`*.orig`、`*~`：覆盖编辑器/merge/patch 备份文件。

已存在且本次确认有效的规则：

- `node_modules`、`node_modules/`
- `dist/`
- `*.tsbuildinfo`
- `log/`、`logs/`、`*.log`
- `.DS_Store`
- `coverage/`
- `.code-shell/`
- `docs/test-outputs/*` 与 `.gitkeep` 例外
- `out/`
- `packages/desktop/.preview/`

未添加宽泛的 `tmp*`、`scratch*`、`*.png` 或 screenshot 规则，避免误隐藏未来可能有意义的测试 fixture、文档素材或设计资产。

## ④ 已归档清单（git mv 到 docs/archive）

归档总计 65 个文件，全部使用 `git mv`：`docs/todo/` 过程产物 37 个，`docs/` 根一次性 plan/impl-notes 2 个，`docs/review-2026-07-09/` 过程产物 26 个。未对保留清单做额外判断归档；`docs/review-2026-07-09/13-findings-register.md`、`README.md`、`GUIDELINE.md`、`visualization-flow.html`、`visualization-v3.html` 均留在原目录。

移动清单：

- `docs/plan-2026-07-09-input-attachment-pipeline-IMPL-NOTES.md` -> `docs/archive/plan-2026-07-09-input-attachment-pipeline-IMPL-NOTES.md`
- `docs/plan-2026-07-09-input-attachment-pipeline.md` -> `docs/archive/plan-2026-07-09-input-attachment-pipeline.md`
- `docs/review-2026-07-09/01-core-engine-structure.md` -> `docs/archive/review-2026-07-09/01-core-engine-structure.md`
- `docs/review-2026-07-09/02-desktop-stream-walkthrough.md` -> `docs/archive/review-2026-07-09/02-desktop-stream-walkthrough.md`
- `docs/review-2026-07-09/03-optimization-findings.md` -> `docs/archive/review-2026-07-09/03-optimization-findings.md`
- `docs/review-2026-07-09/04-p1-deep-dive-and-fix-design.md` -> `docs/archive/review-2026-07-09/04-p1-deep-dive-and-fix-design.md`
- `docs/review-2026-07-09/05-p2-deep-dive-and-fix-design.md` -> `docs/archive/review-2026-07-09/05-p2-deep-dive-and-fix-design.md`
- `docs/review-2026-07-09/06-turn-loop-state-machine.md` -> `docs/archive/review-2026-07-09/06-turn-loop-state-machine.md`
- `docs/review-2026-07-09/07-new-observations-verification.md` -> `docs/archive/review-2026-07-09/07-new-observations-verification.md`
- `docs/review-2026-07-09/08-N03-fix-design.md` -> `docs/archive/review-2026-07-09/08-N03-fix-design.md`
- `docs/review-2026-07-09/09-protocol-event-and-session-contract.md` -> `docs/archive/review-2026-07-09/09-protocol-event-and-session-contract.md`
- `docs/review-2026-07-09/10-tool-system-execution-and-permission-contract.md` -> `docs/archive/review-2026-07-09/10-tool-system-execution-and-permission-contract.md`
- `docs/review-2026-07-09/11-N06-verification.md` -> `docs/archive/review-2026-07-09/11-N06-verification.md`
- `docs/review-2026-07-09/12-N06-fix-design.md` -> `docs/archive/review-2026-07-09/12-N06-fix-design.md`
- `docs/review-2026-07-09/14-remaining-observations-verification.md` -> `docs/archive/review-2026-07-09/14-remaining-observations-verification.md`
- `docs/review-2026-07-09/15-p2-fix-checklist.md` -> `docs/archive/review-2026-07-09/15-p2-fix-checklist.md`
- `docs/review-2026-07-09/16-consistency-audit.md` -> `docs/archive/review-2026-07-09/16-consistency-audit.md`
- `docs/review-2026-07-09/17-fix-execution-plan.md` -> `docs/archive/review-2026-07-09/17-fix-execution-plan.md`
- `docs/review-2026-07-09/18-fix-code-review.md` -> `docs/archive/review-2026-07-09/18-fix-code-review.md`
- `docs/review-2026-07-09/19-landing-status.md` -> `docs/archive/review-2026-07-09/19-landing-status.md`
- `docs/review-2026-07-09/20-p2-code-review.md` -> `docs/archive/review-2026-07-09/20-p2-code-review.md`
- `docs/review-2026-07-09/21-test-coverage-gaps.md` -> `docs/archive/review-2026-07-09/21-test-coverage-gaps.md`
- `docs/review-2026-07-09/22-test-quality-audit.md` -> `docs/archive/review-2026-07-09/22-test-quality-audit.md`
- `docs/review-2026-07-09/23-codex-unpushed-12-review.md` -> `docs/archive/review-2026-07-09/23-codex-unpushed-12-review.md`
- `docs/review-2026-07-09/24-input-attachment-pipeline-review.md` -> `docs/archive/review-2026-07-09/24-input-attachment-pipeline-review.md`
- `docs/review-2026-07-09/25-small-features-impl-notes.md` -> `docs/archive/review-2026-07-09/25-small-features-impl-notes.md`
- `docs/review-2026-07-09/26-bg-completion-no-wake-root-cause.md` -> `docs/archive/review-2026-07-09/26-bg-completion-no-wake-root-cause.md`
- `docs/review-2026-07-09/26-small-features-review.md` -> `docs/archive/review-2026-07-09/26-small-features-review.md`
- `docs/todo/arch-plans-and-verification-2026-07-08.md` -> `docs/archive/todo/arch-plans-and-verification-2026-07-08.md`
- `docs/todo/credentials-partition-fix-demo.html` -> `docs/archive/todo/credentials-partition-fix-demo.html`
- `docs/todo/desktop-streaming-markdown-autoscroll-plan.md` -> `docs/archive/todo/desktop-streaming-markdown-autoscroll-plan.md`
- `docs/todo/final-signoff-2026-07-08.md` -> `docs/archive/todo/final-signoff-2026-07-08.md`
- `docs/todo/fix-batch-1-2026-07-08.md` -> `docs/archive/todo/fix-batch-1-2026-07-08.md`
- `docs/todo/fix-batch-10-2026-07-08.md` -> `docs/archive/todo/fix-batch-10-2026-07-08.md`
- `docs/todo/fix-batch-2-2026-07-08.md` -> `docs/archive/todo/fix-batch-2-2026-07-08.md`
- `docs/todo/fix-batch-3-2026-07-08.md` -> `docs/archive/todo/fix-batch-3-2026-07-08.md`
- `docs/todo/fix-batch-4-2026-07-08.md` -> `docs/archive/todo/fix-batch-4-2026-07-08.md`
- `docs/todo/fix-batch-5-2026-07-08.md` -> `docs/archive/todo/fix-batch-5-2026-07-08.md`
- `docs/todo/fix-batch-6-2026-07-08.md` -> `docs/archive/todo/fix-batch-6-2026-07-08.md`
- `docs/todo/fix-batch-7-2026-07-08.md` -> `docs/archive/todo/fix-batch-7-2026-07-08.md`
- `docs/todo/fix-batch-8-2026-07-08.md` -> `docs/archive/todo/fix-batch-8-2026-07-08.md`
- `docs/todo/fix-batch-9-2026-07-08.md` -> `docs/archive/todo/fix-batch-9-2026-07-08.md`
- `docs/todo/fix-compaction-2026-07-08.md` -> `docs/archive/todo/fix-compaction-2026-07-08.md`
- `docs/todo/fix-review-followup-2026-07-08.md` -> `docs/archive/todo/fix-review-followup-2026-07-08.md`
- `docs/todo/fix-verify-2026-07-08.md` -> `docs/archive/todo/fix-verify-2026-07-08.md`
- `docs/todo/memory-demo.html` -> `docs/archive/todo/memory-demo.html`
- `docs/todo/plan-group-a-core.md` -> `docs/archive/todo/plan-group-a-core.md`
- `docs/todo/plan-group-b-compaction-ui.md` -> `docs/archive/todo/plan-group-b-compaction-ui.md`
- `docs/todo/plan-group-c-worktree-panels.md` -> `docs/archive/todo/plan-group-c-worktree-panels.md`
- `docs/todo/plan-overall-small-features.md` -> `docs/archive/todo/plan-overall-small-features.md`
- `docs/todo/plan-todo-batch-2026-07.md` -> `docs/archive/todo/plan-todo-batch-2026-07.md`
- `docs/todo/review-core-2026-07-08.md` -> `docs/archive/todo/review-core-2026-07-08.md`
- `docs/todo/review-core-v2.md` -> `docs/archive/todo/review-core-v2.md`
- `docs/todo/review-desktop-2026-07-08.md` -> `docs/archive/todo/review-desktop-2026-07-08.md`
- `docs/todo/review-docs-v2.md` -> `docs/archive/todo/review-docs-v2.md`
- `docs/todo/review-infra-2026-07-08.md` -> `docs/archive/todo/review-infra-2026-07-08.md`
- `docs/todo/review-master-2026-07-08.md` -> `docs/archive/todo/review-master-2026-07-08.md`
- `docs/todo/review-small-features-round2.md` -> `docs/archive/todo/review-small-features-round2.md`
- `docs/todo/review-small-features.md` -> `docs/archive/todo/review-small-features.md`
- `docs/todo/review-tests-deps-2026-07-08.md` -> `docs/archive/todo/review-tests-deps-2026-07-08.md`
- `docs/todo/review-tui-cdp-2026-07-08.md` -> `docs/archive/todo/review-tui-cdp-2026-07-08.md`
- `docs/todo/review-ui-v2.md` -> `docs/archive/todo/review-ui-v2.md`
- `docs/todo/review-uncommitted-correctness-2026-07-08.md` -> `docs/archive/todo/review-uncommitted-correctness-2026-07-08.md`
- `docs/todo/review-uncommitted-quality-2026-07-08.md` -> `docs/archive/todo/review-uncommitted-quality-2026-07-08.md`
- `docs/todo/review-uncommitted-security-2026-07-08.md` -> `docs/archive/todo/review-uncommitted-security-2026-07-08.md`

同步更新的索引/引用：

- `docs/todo/README.md`：移除已归档的 `desktop-streaming-markdown-autoscroll-plan.md` 表格条目，避免 todo 索引死链。
- `docs/review-2026-07-09/README.md`：将已归档过程文档的入口改为 `../archive/review-2026-07-09/...`，保留 `13-findings-register.md` 和两个 visualization 入口。
- `docs/review-2026-07-09/GUIDELINE.md`、`docs/review-2026-07-09/13-findings-register.md`：将旧过程文档路径改到 archive 位置。
- `docs/review-2026-07-09/visualization-v3.html`：将 N-03/N-06 的 `fix` 指针改到 archive 中的修复设计文档。
- `CODESHELL.md`：把 `docs/todo` 的示例文件换成仍活跃的 `session-cumulative-cache-usage-plan.md`。
- 全仓旧完整路径引用复扫结果：除本节作为归档日志保留的 from 路径外，未发现仍指向原位置的旧完整路径。

验证：

- 归档后执行 `bun run typecheck`，exit 0，输出为 `tsc --noEmit`。
