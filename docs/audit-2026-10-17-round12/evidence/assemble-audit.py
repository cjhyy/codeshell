"""Assemble preserved audit evidence only; never execute product/tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round12"
EV = OUT / "evidence"
BASE = "d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, data):
    (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

def heading(report, identifier):
    return next(n for n, line in enumerate((OUT / report).read_text().splitlines(), 1)
                if line.startswith("#") and identifier in line)

groups = [
    (read("tui-findings.json"), "tui-input.md", "evidence/tui-key-events.first.log"),
    (read("desktop-findings.json")["findings"], "desktop.md", "evidence/desktop-display-contracts.first.log"),
    (read("patch-findings.json"), "patch.md", "evidence/patch-leading-context.first.log"),
]
findings = []
for rows, report, log in groups:
    for row in rows:
        source, line = row["file"], row["line"]
        blob = subprocess.check_output(["git", "show", BASE + ":" + source], cwd=ROOT)
        assert 0 < line <= len(blob.decode().splitlines())
        findings.append(dict(id=row["id"], priority=row.get("priority", row.get("severity")),
            title=row["title"], source=source, line=line, report=report, reportLine=heading(report, row["id"]),
            log=log, details=row, evidenceLevel=row.get("evidenceLevel", row.get("executedEvidence")),
            status="confirmed-at-frozen-source-baseline", runtimeRetested=False))
assert len(findings) == 4 and all(row["priority"] == "P3" for row in findings)
save("findings.json", dict(baseline=BASE, count=4, priorities={"P3": 4}, findings=findings))
candidates = read("tui-candidates.json") + read("desktop-candidates.json")["candidates"] + read("patch-candidates.json")
assert {row["id"] for row in candidates} == {"TUI-R12-C1", "DESKTOP-R12-C1"}
save("candidates.json", dict(baseline=BASE, count=2, candidates=candidates,
    note="One actual pure metadata mismatch with unused consumer width; one source-only byte-label candidate. Neither counted confirmed."))
related = read("desktop-related.json")["observations"]
assert len(related) == 1 and related[0]["id"] == "DESKTOP-R12-R1"
save("related.json", dict(baseline=BASE, count=1, observations=related,
    note="Old R2-10 root-cause remainder, not an independent new bug or candidate."))

names = ["root-time-display-existing", "tui-key-events", "tui-text-data", "desktop-display-contracts", "desktop-existing-metadata", "patch-leading-context"]
runs = []
for name in names:
    log = EV / (name + ".first.log")
    raw, text = log.read_bytes(), log.read_text()
    exit_file = next(p for p in [EV / (name + s) for s in [".first.exit.json", ".first-exit.json", ".first.exit.txt"]] if p.is_file())
    code = json.loads(exit_file.read_text())["exitCode"] if exit_file.suffix == ".json" else int(exit_file.read_text().strip())
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    def count(pattern):
        match = re.search(pattern, text, re.M)
        return int(match.group(1)) if match else None
    row = dict(log="evidence/"+log.name, exitFile="evidence/"+exit_file.name, firstRun=True,
        exitCode=code, completed=bool(complete), passed=count(r"^\s*(\d+) pass\s*$"),
        failed=count(r"^\s*(\d+) fail\s*$"), expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
        skipped=int(complete.group(2)) if complete else None, sha256=sha(raw))
    assert complete and code == row["failed"] == row["skipped"] == int(complete.group(3)) == 0, row
    assert row["passed"] == int(complete.group(1))
    runs.append(row)
totals = dict(firstBunShards=6, completedCleanShards=6, passedTests=sum(r["passed"] for r in runs),
    expectations=sum(r["expectations"] for r in runs), skippedOrFilteredTests=sum(r["skipped"] for r in runs),
    failedShardsSeparatelyRetained=0, existingBaselineTests=35, newFocusedObservationsAndControls=31)
assert totals["passedTests"] == 66 and totals["expectations"] == 413
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "Six first raw combined logs and exit artifacts saved before inspection; no failed Bun shard or product rerun.",
    "66 tests = 35 existing + 31 focused; one log shared by two TUI findings and another by Desktop finding/related boundary, counted once each.",
    "TUI key parser/event constructors execute without terminal/App/dispatcher/Button/TextInput. Text shard redirects Core utility barrel before first run to real frozen intl.ts; OSC native helper is a throwing zero-call stub, not whole Core validation.",
    "Desktop actual helper/parser only. Synthetic standard Git-format strings are not installed Git captures. UI consumer effects are static; raw tool arguments are unchanged.",
    "Patch parser/matcher only; applier/tool/filesystem mutation source-only and not executed.",
    "Root actual existing relativeTime/timezones tests only; scheduleModel/localization/backend scheduler not executed. Old skipped directions remain skipped.",
    "Static navigation and metadata-reference/regex/document-edit diagnostics are labeled tool-response transcriptions, not Bun failures; metadata corrections did not rerun product fixtures.",
    "No models/paid APIs/accounts/user data/external messages/native apps/PTY/auth/permission/security/custody/watchdog experiments, shared deps/dist rebuild or full build/typecheck/lint/test.",
]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json"}
worker_source_checks = []
for path in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", path.read_text()))
for path in EV.glob("*source-manifest.json"):
    data = json.loads(path.read_text())
    for row in data.get("files", data.get("sources", [])):
        name = row["path"]
        sources.add(name)
        blob = subprocess.check_output(["git", "show", BASE+":"+name], cwd=ROOT)
        expected = row.get("sha256", row.get("frozenSha256", row.get("frozenSha")))
        assert expected == sha(blob), (path.name, name)
        worker_source_checks.append(dict(manifest=path.name, path=name, sha256=expected))
manifest, unresolved = [], []
for name in sorted(sources):
    result = subprocess.run(["git", "show", BASE+":"+name], cwd=ROOT, capture_output=True)
    path = ROOT / name
    if result.returncode or not path.is_file():
        unresolved.append(name)
        continue
    manifest.append(dict(path=name, bytes=len(result.stdout), sha256=sha(result.stdout), frozenBlobVerified=True,
        currentWorkingTreeMatchesFrozenBlob=path.read_bytes()==result.stdout))
assert not unresolved, unresolved
save("source-manifest.json", dict(baseline=BASE,
    assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    files=manifest, workerSourceChecks=worker_source_checks, unresolvedReferences=unresolved,
    note="Frozen Git blob hashes and current equality separate; selected pins do not imply full-file/transitive-depth coverage."))

artifact_checks = []
for name in ["patch-artifact-receipt.json", "desktop-artifact-receipt.json", "tui-artifact-receipt.json"]:
    data = read(name)
    for row in data.get("files", data.get("artifacts", [])):
        path = ROOT / row["path"] if row["path"].startswith("docs/") else OUT / row["path"]
        raw = path.read_bytes()
        assert len(raw)==row["bytes"] and sha(raw)==row["sha256"], (name,row["path"])
        artifact_checks.append(dict(receipt=name, path=str(path.relative_to(ROOT)), sha256=sha(raw)))
save("worker-integrity.json", dict(baseline=BASE, artifactChecks=artifact_checks, sourceCheckCount=len(worker_source_checks), productTestsRerun=False))
files = []
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name!="evidence-index.json":
        raw=path.read_bytes()
        files.append(dict(path=str(path.relative_to(OUT)),bytes=len(raw),sha256=sha(raw)))
save("evidence-index.json", dict(baseline=BASE,algorithm="sha256",files=files,
    note="Self excluded; raw process logs preserved verbatim; metadata/tool transcriptions labeled. Assembler executes no product/test code."))
print(json.dumps(dict(findings=4,candidates=2,related=1,totals=totals,sources=len(manifest),workerArtifacts=len(artifact_checks),evidenceFiles=len(files))))
