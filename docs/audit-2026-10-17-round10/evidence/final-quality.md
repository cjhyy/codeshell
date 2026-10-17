# Final material quality checks

Root reviewed the three formal P3 findings and the Run heuristic candidate against normal inputs, actual source/consumer wiring, controls, historical exclusions and evidence limits. Four read-only cross-reviews cover diagnostics, Pet, Catalog and Run. No review executed tests. Pet concurrency wording was narrowed to the first observed schedule and possible interleavings; root citation draft numbers were checked against frozen source.

After the diagnostics review, root identified the related eager `childNodes` text-extraction path. The report now records it as source-only same-root-cause context. The first fixture supplies only one childNode; there is no new dynamic coverage or fourth finding. The report hash was refreshed, while first logs and fixtures were preserved.

`assemble-audit.py` and `verify-materials.py` read documentation, preserved first observations, installed dependency metadata and frozen Git blobs only. They import no product code and execute no tests. The first assembly error concerning an explicitly skipped nonexistent path is preserved in `root-assembly-note.md`; corrected metadata records that path as skipped and still rejects unexpected unresolved references. This does not restore the skipped caller direction.

Material verification checked all 88 frozen source hashes/current-equality flags, 40 nested worker artifact hashes, local Markdown targets, nine raw first log hashes/exit/completion records, 169 clean pass / 582 expectations, finding heading locations and the separately pinned installed nanoid file. Sources are selected inventories, not full-depth/full-file coverage claims. Characterization tests assert the observed wrong behavior; this documentation task fixes no product defect.

Only this batch was staged. The nine ignored `.first.log` files were force-added by exact owned names with original combined stdout/stderr bytes. Full staged `git diff --check` returned 0 before this note; final full and non-log checks repeat after the final metadata refresh. No raw whitespace normalization or exception is needed in this batch.

The task branch was fast-forwarded onto concurrent main `3f9fcfdafece38ee21715431e05477201e4e55d4`. Its 14 changed paths belong to other Desktop native-path/UI, AppImage acceptance, CI and documentation tasks. Direct finding/candidate implementations remain byte-identical to the first frozen source; no native/Host/browser/Engine/provider acceptance or broad build/suite was run.

Initial and final preintegration snapshots have equal current porcelain, tracked/staged diff hashes and all four original untracked file byte hashes. The existing bug-report deletion remains user-owned. Integration must preserve that current state and use only incoming batch documentation paths; a postintegration receipt is written outside the repository to avoid self-referential commit metadata. The active audit goal and reusable owned worktree remain in progress.
