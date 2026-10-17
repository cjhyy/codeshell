"""Assemble preserved audit evidence; never runs tests or product code."""
from pathlib import Path
import collections
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round7"
EV = OUT / "evidence"
BASE = "1b04838474bcd57212f80f791d0e268a00d347e3"

def sha(raw): return hashlib.sha256(raw).hexdigest()
def save(name, data): (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

rows = [
    ("FILES-R7-01", "P2", "Edit单次替换解释字面replacement token并写入错误内容", "files.md", "packages/core/src/tool-system/builtin/edit.ts", 94, "files-edit-literal.first.log", "真实Edit/Read+自有tmp", "未运行executor/model/UI；EOL转换合同保留"),
    ("FILES-R7-03", "P3", "Grep Node fallback以basename匹配目录glob导致假阴性", "files.md", "packages/core/src/tool-system/builtin/grep.ts", 384, "files-grep-fallback.first.log", "真实Grep/fallback+自有tmp+注入ENOENT", "外部rg/grep未启动；无真实Windows或所有glob等价性结论"),
    ("FILES-R7-04", "P3", "Read超限错误建议无法穿过size gate的分页恢复", "files.md", "packages/core/src/tool-system/builtin/read.ts", 77, "files-read-large.first.log", "真实Read+6MiB自有text+小文件分页对照", "只确认恢复文案错误；不反对cap、不声称所有读取方式被堵"),
    ("PROV-R7-01", "P3", "Anthropic SDK参数事件路由落后一个工具并污染进度卡片", "providers.md", "packages/core/src/llm/providers/anthropic.ts", 347, "providers-stream-contract.first.log", "安装SDK内存parser→真实provider/Facade/Transcript/Web reducer", "最终response/transcript input正确；无真实Builtin执行/Engine/Host/UI/API；工具名与schema无关传播为源码推断"),
]
findings = []
for ident, priority, title, report, source, line, log, level, limits in rows:
    headings = (OUT / report).read_text().splitlines()
    heading_line = next(i for i, text in enumerate(headings, 1) if text.startswith("#") and re.search(r"\b" + re.escape(ident) + r"\b", text))
    blob = subprocess.check_output(["git", "show", BASE + ":" + source], cwd=ROOT)
    assert 0 < line <= len(blob.decode().splitlines())
    assert (EV / log).is_file()
    findings.append(dict(id=ident, priority=priority, title=title, report=report, reportLine=heading_line,
        source=source, line=line, log="evidence/" + log, evidenceLevel=level, limitations=limits,
        status="confirmed-at-frozen-source-baseline"))
priorities = dict(collections.Counter(row["priority"] for row in findings))
assert len(findings) == 4 and priorities == {"P2": 1, "P3": 3}
save("findings.json", dict(baseline=BASE, count=len(findings), priorities=priorities, findings=findings))
save("candidates.json", dict(baseline=BASE, count=5, candidates=[
    dict(id="FILES-R7-02", report="files.md", source="packages/core/src/tool-system/builtin/glob.ts", line=90,
         status="observed-behavior-contract-unproven", reason="Returned subset is sorted; no explicit global-newest-200 contract found. Downgraded after review, not counted."),
    dict(id="PROV-R7-C1", report="providers.md", source="packages/core/src/llm/providers/openai.ts", line=831,
         status="observed-fake-input-reachability-unproven", reason="Late identity fake reproduces behavior, but no valid normal producer/protocol ordering proof; final TurnLoop also backfills start. Not counted."),
    dict(id="PROV-R7-C2", report="providers.md", source="packages/core/src/llm/providers/anthropic.ts", line=385,
         status="SKIP-after-first-fixture-assertion-failure", reason="Thinking roundtrip first shard fails due to unaccounted automatic cache_control. Partial observations are not confirmation; no repair/retry/alternate validation."),
    dict(id="TUI-C1", report="tui.md", source="packages/tui/src/ui/components/DiffLine.tsx", line=102,
         status="source-only-SKIP", reason="Diff classification fixture import over-traverses path. No product assertion executed; no repair/retry/alternate validation."),
    dict(id="TUI-C2", report="tui.md", source="packages/tui/src/ui/components/DiffLine.tsx", line=48,
         status="source-only-SKIP", reason="Same failed Diff fixture; terminal-column padding prediction has no successful renderer/width observation."),
], note="Candidates are separate from confirmed severities. Original first fixtures/logs retained after downgrades."))

specs = [
    ("files-edit-literal.first.log", "files-edit-literal.first.exit.txt", "focused-contract-observation-control", True),
    ("files-glob-order.first.log", "files-glob-order.first.exit.txt", "observed-candidate-and-control", True),
    ("files-grep-fallback.first.log", "files-grep-fallback.first.exit.txt", "focused-contract-observation-control", True),
    ("files-read-large.first.log", "files-read-large.first.exit.txt", "focused-contract-observation-control", True),
    ("providers-stream-contract.first.log", "providers-stream-contract.first.exit.txt", "SDK-provider-progress-observations-controls-candidate", True),
    ("providers-normalization-baseline.first.log", "providers-normalization-baseline.first.exit.txt", "existing-provider-baseline", True),
    ("tui-store-anchor-baseline.first.log", "tui-store-anchor-baseline.first.exit.json", "existing-TUI-baseline", True),
    ("providers-thinking-roundtrip.first.log", "providers-thinking-roundtrip.first.exit.txt", "failed-fixture-assertion-SKIP", False),
    ("tui-diff-display.first.log", "tui-diff-display.first.exit.json", "failed-fixture-import-SKIP", False),
]
runs = []
for log, exit_name, phase, clean in specs:
    p = EV / log; raw = p.read_bytes(); text = raw.decode(errors="replace"); e = EV / exit_name
    code = json.loads(e.read_text())["exitCode"] if e.suffix == ".json" else int(e.read_text().strip())
    def count(pattern):
        match = re.search(pattern, text, re.M)
        return int(match.group(1)) if match else None
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    row = dict(log="evidence/" + log, exitFile="evidence/" + exit_name, exitCode=code, firstRun=True,
        clean=clean, phase=phase, completed=bool(complete), passed=count(r"^\s*(\d+) pass\s*$"),
        failed=count(r"^\s*(\d+) fail\s*$"), expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
        skipped=int(complete.group(2)) if complete else None, sha256=sha(raw))
    if clean: assert complete and code == row["failed"] == row["skipped"] == 0, row
    else:
        assert code != 0 and not complete, row
        row["interpretation"] = "Failed first audit fixture; partial results excluded from clean totals, retained unchanged, direction skipped without retry/repair/alternate validation."
    runs.append(row)
clean_runs = [r for r in runs if r["clean"]]
totals = dict(firstBunShards=len(runs), completedCleanShards=len(clean_runs), passedTests=sum(r["passed"] for r in clean_runs),
    expectations=sum(r["expectations"] for r in clean_runs), skippedOrFilteredTests=sum(r["skipped"] for r in clean_runs),
    failedShardsSeparatelyRetained=2, passCountWithinFailedShards=1, expectCallsWithinFailedShards=13,
    existingBaselineTests=53, focusedObservationsControlsAndCandidateTests=16, rootPreflightBunShardsLaunched=0)
assert totals == dict(firstBunShards=9, completedCleanShards=7, passedTests=69, expectations=372,
    skippedOrFilteredTests=0, failedShardsSeparatelyRetained=2, passCountWithinFailedShards=1,
    expectCallsWithinFailedShards=13, existingBaselineTests=53, focusedObservationsControlsAndCandidateTests=16,
    rootPreflightBunShardsLaunched=0), totals
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, nonBunSkips=[
    dict(direction="root translation", receipt="evidence/root-i18n-preflight-failure.md", phase="metadata preflight before guarded runner launch", productTestsExecuted=0),
    dict(direction="root theme application caller navigation", receipt="evidence/root-static-search-skip.md", phase="zsh glob expansion before rg launch", productTestsExecuted=0),
], notes=[
    "69 clean tests include 53 existing baseline tests and 16 focused observations/controls, including two downgraded behavior candidates. Not 69 new bugs or whole-repository gate.",
    "Thinking's 1 pass and 13 expect calls belong to the failed shard, and TUI import has 0 pass; neither contributes to clean totals.",
    "Root translation command never launched; its tool-response transcription is not a Bun raw log or failed Bun shard. Unchanged two-case fixture unexecuted.",
    "Injected missing-command ENOENT in Grep is deliberate intended fallback input, not an actual environment/fixture failure; no external command launched.",
    "Anthropic installed SDK memory parser is runtime evidence, not a real API/client/HTTP transport. Real provider/Facade/Transcript/reducer tested, execution/UI limited.",
    "No failed direction repaired/retried or validated through another method. Original tests/logs unchanged when Glob/OpenAI claims were downgraded.",
    "Crossreviews and assembly/hash/material checks add zero product execution. No shared dist/dependency rebuild, full build/typecheck/lint/test or clean-install claim.",
    "No real models, paid APIs, accounts, user data, native apps/PTY, external messages, security/permission/platform experiments.",
]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json", "packages/core/package.json", "packages/web/package.json"}
sources.update("packages/core/src/themes/" + name + ".ts" for name in ["manifest", "audio", "image", "paths"])
sources.update("packages/desktop/src/renderer/" + name for name in ["builtin-character-themes.ts", "theme-packs.ts", "uiLanguage.ts", "i18n/dict.ts", "i18n/translate.ts", "i18n/I18nProvider.tsx", "i18n/dict.test.ts", "i18n/translate.test.ts"])
sources.update("packages/web/src/" + name for name in ["i18n/mobile.ts", "i18n/translate.ts", "lib/uiLanguage.ts", "index.ts"])
for p in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", p.read_text()))
for p in EV.glob("*source-manifest.json"):
    data = json.loads(p.read_text())
    for row in data.get("files", data.get("paths", data.get("sources", []))):
        if isinstance(row, dict) and isinstance(row.get("path"), str): sources.add(row["path"])
manifest, unresolved, generated_references = [], [], []
for name in sorted(sources):
    if name == "packages/web/dist/index.js":
        generated_references.append(dict(path=name, role="hard-coded checkout-local metadata preflight target", frozenGitBlob=False,
            note="Missing local generated artifact caused receipt preparation to stop before test launch. Actual shared package resolution untested; no product defect inferred."))
        continue
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True); p = ROOT / name
    if blob.returncode or not p.is_file(): unresolved.append(name); continue
    manifest.append(dict(path=name, bytes=len(blob.stdout), sha256=sha(blob.stdout), frozenBlobVerified=True,
        currentWorkingTreeMatchesFrozenBlob=p.read_bytes() == blob.stdout))
save("source-manifest.json", dict(baseline=BASE,
    assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    files=manifest, unresolvedReferences=unresolved, generatedArtifactReferences=generated_references,
    runtimeDependencyReceipt="evidence/providers-dependency-receipt.json",
    note="SHAs refer to frozen Git blobs. Installed SDK snapshot separately recorded, not claimed as Git-tracked source. Selected inventory/hash is not full-depth review coverage."))
files = []
for p in sorted(OUT.rglob("*")):
    if p.is_file() and p.name != "evidence-index.json":
        raw = p.read_bytes(); files.append(dict(path=str(p.relative_to(OUT)), bytes=len(raw), sha256=sha(raw)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files,
    note="Self excluded. First raw process stdout/stderr preserved; documented root tool-response transcriptions labeled separately. Hash checks are not tests."))
print(json.dumps(dict(findings=len(findings), priorities=priorities, candidates=5, totals=totals,
    sources=len(manifest), unresolved=unresolved, evidenceFiles=len(files)), ensure_ascii=False))
