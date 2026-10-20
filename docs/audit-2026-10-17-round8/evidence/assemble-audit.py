"""Build indexes from preserved first evidence. No product/test execution."""
from pathlib import Path
import collections, hashlib, json, re, subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round8"
EV = OUT / "evidence"
BASE = "ec0e16bf0068a458abcbaa28225a4c764c24f4de"
FIX = "658b8c6fcdad0e9d4bfe8809c5adf6f95f19580d"
def sha(raw): return hashlib.sha256(raw).hexdigest()
def save(name, value): (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

rows = [
    ("GIT-R8-01", "带引号路径在committed/dirty摘要中重复计数", "root-git.md", "packages/coding/src/git/worktree/diff.ts", 61, "root-git-diff-quoted.first.log", "真实摘要+内存gitOutput+禁止process guard", "无真实Git/仓库/Host/UI；规范输入由官方格式支持"),
    ("PLUGIN-R8-01", "空引号命令参数消失并使后续位置左移", "plugins.md", "packages/core/src/plugins/pluginCommandsLoader.ts", 230, "plugins-command-metadata.first.log", "真实expander/copyCodexCommands+自有tmp", "引用语法合同；无upstream Codex/host/模型/安装"),
    ("PLUGIN-R8-02", "ARGUMENTS前缀抢先匹配完整命名placeholder", "plugins.md", "packages/core/src/plugins/pluginCommandsLoader.ts", 289, "plugins-command-metadata.first.log", "真实expander/converter+已命名/未知literal对照", "同根因两个表现合并；无模型提交或shell执行"),
    ("PLUGIN-R8-03", "已接受Windows marketplace路径派生非法name", "plugins.md", "packages/core/src/plugins/parseMarketplaceInput.ts", 86, "plugins-parser-metadata.first.log", "真实parser/deriver/name guard纯字符串链", "macOS纯数据；未addMarketplace/clone/Windows filesystem"),
    ("WEB-R8-01", "根项目不能匹配后代cwd", "web.md", "packages/web/src/lib/format.ts", 20, "web-display-contracts.first.log", "真实projectForCwd/groupByProject纯数据", "冻结基线确认；并行main已源级修复，未在新main重跑"),
    ("WEB-R8-02", "image/jpg alias提前返回跳过客户端每图大小检查", "web.md", "packages/web/src/lib/mobileAttachments.ts", 78, "web-display-contracts.first.log", "真实normalize/prepare+自有File字节+内存upload callbacks", "仅客户端metadata不一致；无JPEG解码/真实上传/服务接受或拒绝/平台推断"),
]
findings = []
for ident, title, report, source, line, log, level, limits in rows:
    heading = next(i for i, text in enumerate((OUT / report).read_text().splitlines(), 1) if text.startswith("#") and re.search(r"\b" + re.escape(ident) + r"\b", text))
    blob = subprocess.check_output(["git", "show", BASE + ":" + source], cwd=ROOT)
    assert 0 < line <= len(blob.decode().splitlines()) and (EV / log).is_file()
    row = dict(id=ident, priority="P3", title=title, report=report, reportLine=heading, source=source, line=line,
        log="evidence/" + log, evidenceLevel=level, limitations=limits, status="confirmed-at-frozen-source-baseline")
    if ident == "WEB-R8-01": row["currentMainSourceDisposition"] = dict(status="addressed-by-concurrent-main-source-change", commit=FIX, runtimeRetested=False)
    else: row["currentMainSourceDisposition"] = dict(status="direct-finding-source-unchanged-at-reviewed-main", runtimeRetested=False)
    findings.append(row)
save("findings.json", dict(baseline=BASE, count=6, priorities={"P3": 6}, findings=findings,
    concurrentMainSourceAddressed=1, note="Six frozen findings; one already addressed in concurrent main source, not six verified current outstanding bugs."))
save("candidates.json", dict(baseline=BASE, count=2, candidates=[
    dict(id="Q-R8-C1", report="questions.md", status="source-candidate-SKIP-contract-unproven", reason="Mobile fixture import failed; hosts may ignore additive hints, no explicit Mobile multiSelect acceptance contract established."),
    dict(id="Q-R8-C2", report="questions.md", status="source-candidate-SKIP-control-not-established", reason="Batched and flushed TUI fixture cases both failed; no batch-specific observed defect. No timing repair/retry/alternate validation."),
]))

names = ["root-git-pure-baseline", "root-git-diff-quoted", "plugins-command-metadata", "plugins-parser-metadata",
    "web-display-contracts", "web-existing-display-baseline", "questions-core-options", "questions-tui-pending-baseline",
    "questions-mobile-multiselect", "questions-tui-batched-choice"]
runs = []
for name in names:
    p = EV / (name + ".first.log"); raw = p.read_bytes(); text = raw.decode(errors="replace")
    e = next(p for p in [EV / (name + suffix) for suffix in [".first.exit.txt", ".first.exit.json"]] if p.is_file())
    code = json.loads(e.read_text())["exitCode"] if e.suffix == ".json" else int(e.read_text().strip())
    def count(pattern):
        m = re.search(pattern, text, re.M); return int(m.group(1)) if m else None
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    clean = name not in {"questions-mobile-multiselect", "questions-tui-batched-choice"}
    row = dict(log="evidence/" + p.name, exitFile="evidence/" + e.name, firstRun=True, exitCode=code,
        clean=clean, completed=bool(complete), passed=count(r"^\s*(\d+) pass\s*$"), failed=count(r"^\s*(\d+) fail\s*$"),
        expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"), skipped=int(complete.group(2)) if complete else None, sha256=sha(raw))
    if clean: assert complete and code == row["failed"] == row["skipped"] == 0, row
    else:
        assert code != 0 and not complete, row
        row["phase"] = "fixture import failure" if name.endswith("multiselect") else "fixture failed to establish intended interaction/control"
        row["interpretation"] = "Preserved first failure and skipped; not a product finding. No repair/retry/alternate validation."
    runs.append(row)
clean = [r for r in runs if r["clean"]]
totals = dict(firstBunShards=10, completedCleanShards=len(clean), passedTests=sum(r["passed"] for r in clean),
    expectations=sum(r["expectations"] for r in clean), skippedOrFilteredTests=sum(r["skipped"] for r in clean),
    failedShardsSeparatelyRetained=2, passCountWithinFailedShards=0, expectCallsWithinFailedShards=6,
    existingBaselineTests=39, newFocusedObservationsAndControls=25)
assert totals == dict(firstBunShards=10, completedCleanShards=8, passedTests=64, expectations=203, skippedOrFilteredTests=0,
    failedShardsSeparatelyRetained=2, passCountWithinFailedShards=0, expectCallsWithinFailedShards=6,
    existingBaselineTests=39, newFocusedObservationsAndControls=25), totals
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "64 clean tests comprise 39 existing baseline tests and 25 focused proof/control observations. Shared finding logs counted once.",
    "Root process module mock/guard asserts zero native calls; Git commands used by audit metadata/integration are not product-test execution.",
    "Web fake upload acceptance is an explicit in-memory substitute; no service bytes sent, permission or platform experiment.",
    "Two failed Question directions preserved unchanged; 6 failed-shard expect calls excluded from clean totals. No repair/retry/alternate execution.",
    "Static navigation and metadata collector diagnostics labeled separately, not counted as Bun shards. Metadata assembly corrections add zero product execution.",
    "Root's first assembly assumed txt exit receipts; diagnostic preserved in root-assembly-note.md. Corrected metadata selection reads unchanged existing json/txt receipts, with zero product reruns.",
    "Raw questions-tui-batched-choice.first.log line21 retains Bun error-frame trailing whitespace. Full staged diff-check exit2 for that raw line only; non-log check clean. Evidence bytes not normalized.",
    "WEB-R8-01 fixed by concurrent main source branch, no characterization rerun on combined main. All first observations belong to frozen baseline.",
    "No real models/paid API/accounts/user data/native apps/PTY/security/permission/network/platform experiments, shared dist/dependency rebuild or full build/typecheck/lint/test.",
]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json",
    "packages/coding/src/git/utils.ts", "packages/coding/src/git/parse-log.ts", "packages/coding/src/git/parse-log.test.ts",
    "packages/coding/src/git/worktree/slug.ts", "packages/coding/src/git/worktree/slug.test.ts", "packages/coding/src/git/worktree/diff.ts",
    "packages/coding/src/git/worktree/diff.test.ts", "packages/coding/src/git/worktree/query.ts", "packages/coding/src/git/worktree/git-exec.ts",
    "packages/tui/src/cli/commands/builtin/git-commands.ts"}
for p in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", p.read_text()))
for p in EV.glob("*source-manifest.json"):
    d = json.loads(p.read_text())
    for row in d.get("files", d.get("sources", d.get("paths", []))):
        if isinstance(row, dict) and isinstance(row.get("path"), str): sources.add(row["path"])
manifest, unresolved = [], []
for name in sorted(sources):
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True); p = ROOT / name
    if blob.returncode or not p.is_file(): unresolved.append(name); continue
    manifest.append(dict(path=name, bytes=len(blob.stdout), sha256=sha(blob.stdout), frozenBlobVerified=True,
        currentWorkingTreeMatchesFrozenBlob=p.read_bytes()==blob.stdout))
save("source-manifest.json", dict(baseline=BASE,
    assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(), files=manifest,
    unresolvedReferences=unresolved, note="SHA is frozen Git blob, current equality separate. Selected hash inventory is not full-file/full-depth review coverage."))
files = []
for p in sorted(OUT.rglob("*")):
    if p.is_file() and p.name != "evidence-index.json":
        raw = p.read_bytes(); files.append(dict(path=str(p.relative_to(OUT)), bytes=len(raw), sha256=sha(raw)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files,
    note="Self excluded. First process stdout/stderr kept verbatim; tool-response transcriptions labeled as such. Hash checks execute no product code."))
print(json.dumps(dict(findings=6, priorities={"P3":6}, sourceAddressedByConcurrentMain=1, candidates=2,
    totals=totals, sources=len(manifest), unresolved=unresolved, evidenceFiles=len(files)), ensure_ascii=False))
