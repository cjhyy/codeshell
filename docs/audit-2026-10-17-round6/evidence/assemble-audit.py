"""Index preserved first-run evidence. No product/test execution."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round6"
EV = OUT / "evidence"
BASE = "cef9ff76167d33a6a6e5b4464ba5313f7fd35f79"

def sha(data): return hashlib.sha256(data).hexdigest()
def save(name, data): (OUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")

save("findings.json", dict(baseline=BASE, count=0, priorities={}, findings=[],
    note="Zero newly confirmed bugs in this finite batch. Static candidates and fixture failures are separate; no claim of whole-repository correctness."))
save("candidates.json", dict(baseline=BASE, count=3, candidates=[
    dict(id="S-C1", report="skills-agents.md", source="packages/core/src/skills/frontmatter.ts", line=9,
         title="Skill frontmatter may terminate on embedded triple dashes", status="static-candidate-SKIP",
         validation="Custom fixture never executed: direct yaml import unresolved. No repair/retry/alternate validation."),
    dict(id="S-C2", report="skills-agents.md", source="packages/core/src/agent/agent-definition.ts", line=90,
         title="CRLF agent-definition delimiter may fail parsing", status="static-candidate-SKIP",
         validation="Custom fixture never executed: same first shard dependency failure. No real Windows or registry/UI observation."),
    dict(id="PACKAGE-C1", report="root-package.md", source="package.json", line=42,
         title="Watch test script differs from required guarded test entry", status="static-candidate-unvalidated",
         validation="No watch execution or operator state/credential inspection; maintenance intent and actual impact unconfirmed."),
], note="None counted as confirmed; provisional priorities in worker prose are not confirmed severities."))

specs = [
    ("root-package-baseline.first.log", "root-package-baseline.first.exit.txt", "existing-package-baseline", True),
    ("tasks-snapshot-contract.first.stdout+stderr.log", "tasks-snapshot-contract.first.exit.txt", "focused-contract-and-controls", True),
    ("tasks-display-contract.first.stdout+stderr.log", "tasks-display-contract.first.exit.txt", "focused-contract-and-controls", True),
    ("tasks-tui-owner.first.stdout+stderr.log", "tasks-tui-owner.first.exit.txt", "existing-TUI-fake-client", True),
    ("desktop-logs-first.log", "desktop-logs-first.exit.json", "existing-MiniDOM-fixture", True),
    ("desktop-settings-search-first.log", "desktop-settings-search-first.exit.json", "existing-MiniDOM-fixture", True),
    ("skills-metadata-first.log", "skills-metadata-first.exit", "fixture-import-failure-SKIP", False),
    ("desktop-projections-first.log", "desktop-projections-first.exit.json", "fixture-import-failure-SKIP", False),
]
runs = []
for log, exit_name, phase, expected_clean in specs:
    p = EV / log
    raw = p.read_bytes()
    text = raw.decode(errors="replace")
    e = EV / exit_name
    code = json.loads(e.read_text())["exitCode"] if e.suffix == ".json" else int(e.read_text().strip())
    def count(pattern):
        m = re.search(pattern, text, re.M)
        return int(m.group(1)) if m else None
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    row = dict(log="evidence/" + log, exitFile="evidence/" + exit_name, exitCode=code,
        firstRun=True, phase=phase, completed=bool(complete), clean=expected_clean,
        passed=count(r"^\s*(\d+) pass\s*$"), failed=count(r"^\s*(\d+) fail\s*$"),
        expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
        selectedTests=int(complete.group(1)) if complete else None,
        skipped=int(complete.group(2)) if complete else None, sha256=sha(raw))
    if expected_clean:
        assert complete and code == row["failed"] == row["skipped"] == 0, row
    else:
        assert code != 0 and not complete, row
        row["interpretation"] = "Fixture import failure, not product bug. Partial pass counts excluded from clean totals. Preserved unchanged; no repair/retry/alternate execution."
    runs.append(row)
clean = [r for r in runs if r["clean"]]
totals = dict(firstShards=8, completedCleanShards=len(clean), passedTests=sum(r["passed"] for r in clean),
    expectations=sum(r["expectations"] for r in clean), skippedOrFilteredTests=sum(r["skipped"] for r in clean),
    failedFixtureShardsSeparatelyRetained=2, partialPassesInFailedShards=13, partialExpectationsInFailedShards=26,
    existingBaselineTests=31, newFocusedContractTests=11)
assert totals == dict(firstShards=8, completedCleanShards=6, passedTests=42, expectations=474,
    skippedOrFilteredTests=0, failedFixtureShardsSeparatelyRetained=2, partialPassesInFailedShards=13,
    partialExpectationsInFailedShards=26, existingBaselineTests=31, newFocusedContractTests=11), totals
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs, notes=[
    "42 clean tests = 17 existing package + 12 existing Desktop + 2 existing TUI + 11 focused Task contracts. Parameter matrix samples are not extra tests.",
    "Skill's 13 baseline passes/26 expectations are within a failed shard and are excluded from clean totals; custom five-case fixture never ran.",
    "Desktop pure-projection fixture never executed. Its original bad relative import is preserved, not repaired.",
    "No failed direction repaired/retried or validated by an alternate method. Earlier failed audit directions remain skipped.",
    "Build-meta executed only as a byte-identical copy in owned temporary fake TUI fixture; shared checkout dist was not built.",
    "MiniDOM/fake-client/pure reducers and source contracts do not establish native application or end-to-end user behavior.",
    "Read-only crossreviews and index/material checks execute zero product tests. No whole-repository build/typecheck/lint/test or clean-install claim.",
    "No real models, paid APIs, user data, accounts, native applications, real publish/network/platform/security experiments.",
]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json",
    "scripts/build-meta.ts", "scripts/check-node.cjs", "scripts/verify-release-versions.ts",
    "scripts/package-release-audit-config.ts", "scripts/publish-release-packages.ts", "scripts/package-release-smoke.ts",
    "scripts/run-bun-test-shard.mjs", "scripts/bun-test-completion.mjs",
    "tests/build-meta.test.ts", "tests/package-boundaries.test.ts"}
for p in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", p.read_text()))
for p in EV.glob("*source-manifest.json"):
    data = json.loads(p.read_text())
    for row in data.get("files", data.get("paths", data.get("sources", []))):
        if isinstance(row, dict) and isinstance(row.get("path"), str): sources.add(row["path"])
manifest, unresolved = [], []
for name in sorted(sources):
    blob = subprocess.run(["git", "show", BASE + ":" + name], cwd=ROOT, capture_output=True)
    p = ROOT / name
    if blob.returncode or not p.is_file(): unresolved.append(name); continue
    manifest.append(dict(path=name, bytes=len(blob.stdout), sha256=sha(blob.stdout), frozenBlobVerified=True,
        currentWorkingTreeMatchesFrozenBlob=p.read_bytes() == blob.stdout))
save("source-manifest.json", dict(baseline=BASE,
    assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    files=manifest, unresolvedReferences=unresolved,
    note="SHA refers to frozen Git blobs. Current equality is separate. Source inventory is selected evidence, not a full-depth review coverage claim."))
files = []
for p in sorted(OUT.rglob("*")):
    if p.is_file() and p.name != "evidence-index.json":
        raw = p.read_bytes(); files.append(dict(path=str(p.relative_to(OUT)), bytes=len(raw), sha256=sha(raw)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files,
    note="Self excluded. First stdout/stderr verbatim; hash checks do not execute product code."))
print(json.dumps(dict(findings=0, candidates=3, totals=totals, sources=len(manifest), unresolved=unresolved, evidenceFiles=len(files)), ensure_ascii=False))
