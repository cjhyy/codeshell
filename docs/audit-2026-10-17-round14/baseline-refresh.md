# Concurrent baseline changes before round 14

Round 13 integrated at `b4702dcc29883a87a5e469fac43b7ff546ac134a`. Before this batch began, main advanced through eight other-task commits to **`badc2262a90966f6f903977b849adf1f22b55e9f`**, which is this batch's frozen source. CODESHELL/AGENTS were unchanged. The owned audit checkout was clean and fast-forwarded to current main on its separate batch branch after fetching origin; other worktrees and primary dirty files were preserved.

Two earlier findings have direct source changes in that advance:

- **DESKTOP-R12-01**: commit `9925b3282` changes `packages/desktop/src/renderer/tool-cards/utils.ts` to retreat the truncation boundary when it cuts a valid surrogate pair. This addresses the earlier demonstrated boundary in source. Root inspected the diff only; this batch does not rerun the old wrong-behavior experiment or claim independent UI/native validation of the fix.
- **ATT-R9-01**: commit `3d6a1ec35` changes `packages/desktop/src/renderer/tool-cards/attachments.ts` to retain the complete generated-image result tail as an exact path and avoid inventing a scraped suffix. The same change handles structured Write targets exactly and declines ambiguous delimiters. Root inspected the diff only; current fix verification from the other task is not reclassified as this audit's runtime evidence.

Other incoming paths were the release operations document, Desktop acceptance scripts, private AppImage runtime/helper test, and the new image-path/Unicode-summary tests. Main's merge commits include earlier audit batches. No product changes were made by this audit. Earlier reports remain evidence at their explicit frozen baselines; they are not claims that these addressed branches still fail at the new baseline.
