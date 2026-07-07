## Docs & Config Review

### Strengths
- CODESHELL.md / CLAUDE.md / AGENTS.md are properly aliased and consistent.
- README.zh-CN.md matches the English README in structure.
- New worktree spec is thorough and grounded in real CC/Codex docs.

### Critical (Must Fix Before Tag)
- `docs/architecture/00-overview.md:14`: falsely claims core `VERSION` constant lags package manifests — stale after recent version alignment work.
- `TODO.md:10`: compaction underestimation item contradicts unchecked review docs in `docs/todo/review-*.md` — those reviews are from a now-outdated pass; either remove stale review files or reconcile TODO.
- `TODO.md:38-41`: still list DriveAgent foreground timeout, goal schema gating, and schema-export wiring as unresolved despite being partially or fully implemented in this tag range.
- `docs/superpowers/specs/2026-07-07-worktree-session-workspace-design.md:14-18, :141-143, :150`: overclaims or contradicts current worktree/session behavior — specifically the "transcript relocation" section still describes Handoff-style physical transcript movement that was downgraded to a session_meta breadcrumb in the actual implementation.

### Important (Should Fix Before Tag)
- `docs/archive/architecture/README.md:11, :24, :53-65`: contains broken relative links to moved/renamed architecture chapters.
- `docs/todo/roadmap.md:35, :40`: conflicts with current tool/worktree docs — references outdated tool names or capabilities.
- `docs/todo/review-core.md, review-docs.md, review-ui.md, review-verification.md`: stale review files from a previous pass — should be removed or archived to avoid confusion with the current v2 reviews.

### Minor
- `assets/codeshell-desktop-screenshot-en.png` and `codeshell-promo.png` are referenced in README but not verified to be current (screenshot may show pre-worktree UI).

### Assessment (Ready to tag? No — docs-only fixes needed)
Several documented statements are now false or misleading relative to the code in this tag range. Fix the stale TODO entries, broken archive links, and the spec overclaim before tagging. These are pure docs changes with no risk of code regression.
