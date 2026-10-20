"""Aggregate preserved metadata only; never import product code or run tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round17"
EV = OUT / "evidence"
BASE = "d86db33012dffd5d1849e76b869fa15eb260324f"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

prefixes = ["catalog", "mappers", "frontier"]
findings = []
candidates = []
for prefix in prefixes:
    data = read(prefix + "-findings.json")
    findings.extend(data if isinstance(data, list) else data["findings"])
    data = read(prefix + "-candidates.json")
    candidates.extend(data if isinstance(data, list) else data["candidates"])
assert len(findings) == 1 and findings[0]["id"] == "CHAT-R17-01" and findings[0]["severity"] == "P3"
assert {r["id"] for r in candidates} == {"CATALOG-R17-C1", "CATALOG-R17-C2", "MAPPERS-R17-C1"}
save("findings.json", dict(baseline=BASE, count=1, priorities={"P3": 1}, findings=findings, note="Actual ingress generator refusal only; no CLI/deployment/proxy/runtime listener claim."))
save("candidates.json", dict(baseline=BASE, count=3, candidates=candidates, note="Actual pure observations with incomplete cross-boundary policy/producer/consumer evidence; no formal severity."))
save("related.json", dict(baseline=BASE, count=0, observations=[], note="Old helper/parser/AskUser/reducer/UI/Host/Link routes are exclusions only. Source change below is a separate old-status update."))
changed_path = "packages/desktop/src/renderer/diff/parseUnifiedDiff.ts"
frozen_blob = subprocess.check_output(["git", "show", BASE + ":" + changed_path], cwd=ROOT)
main_blob = subprocess.check_output(["git", "show", "main:" + changed_path], cwd=ROOT)
save("addressed-sources.json", dict(baseline=BASE, count=1, runtimeRetested=False, sourceChanges=[dict(id="R2-10", relatedObservation="DESKTOP-R12-R1", path=changed_path, changeCommit="9d7577249", frozenSha256=sha(frozen_blob), mainSha256=sha(main_blob), oldReport="docs/audit-2026-10-17/root.md", remainderReport="docs/audit-2026-10-17-round12/desktop.md", disposition="Other-task header identity fallback source diff inspected; no old parser/new regression/Review UI rerun")], note="Separate source-status observation, not new finding/candidate/related count or verified repair."))

specs = [
    ("root-fingerprint.first.log", "root-fingerprint.first.exit.json", 7, "Six actual server helper tests and one static counterpart source comparison; no Desktop import"),
    ("catalog-pure.first.raw.log", "catalog-pure.first.exit.json", 12, "Actual server catalog plus three pure UI helpers; settings/Host/Engine/pool/worker static only"),
    ("mappers-pure.first.raw.log", "mappers-pure.first.exit.json", 9, "Actual leaf mapper APIs on owned ordinary-shaped records; real follower/reducer/UI not executed"),
    ("frontier-ingress-port.first.raw.log", "frontier-ingress-port.first.exit.json", 3, "Actual ingress generator/URL constructor in memory; CLI/config/README static, no listener/proxy/network"),
]

runs = []
for log_name, exit_name, expected_tests, scope in specs:
    raw = (EV / log_name).read_bytes()
    text = raw.decode()
    receipt = read(exit_name)
    command = receipt["command"]
    assert command[:4] == ["node", "scripts/run-bun-test-shard.mjs", "--timeout", "30000"]
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    assert complete and receipt["exitCode"] == 0
    def count(pattern, default=None):
        match = re.search(pattern, text, re.M)
        return int(match.group(1)) if match else default
    row = dict(log="evidence/" + log_name, exitFile="evidence/" + exit_name, command=command, firstRun=True, attempts=1, reruns=0,
        exitCode=0, completed=True, clean=True, passed=count(r"^\s*(\d+) pass\s*$"), failed=count(r"^\s*(\d+) fail\s*$"),
        errors=count(r"^\s*(\d+) error\s*$", 0), expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
        skipped=int(complete.group(2)), existingTests=0, focusedTests=expected_tests, scope=scope, sha256=sha(raw))
    assert row["passed"] == expected_tests == int(complete.group(1))
    assert row["failed"] == row["errors"] == row["skipped"] == int(complete.group(3)) == 0
    runs.append(row)
totals = dict(firstBunShards=4, completedCleanShards=4, failedBunShards=0, passedTests=sum(r["passed"] for r in runs), expectations=sum(r["expectations"] for r in runs), failedTests=0, skippedOrFilteredTests=0, existingBaselineTests=0, newFocusedObservationsAndControls=31, actualPureHelperTests=30, staticSourceComparisonTests=1, productReruns=0)
assert (totals["passedTests"], totals["expectations"]) == (31, 125)
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs,
    metadataNotes=["evidence/catalog-navigation-skip.md", "evidence/frontier-assembly-note.md", "evidence/review-mappers.md"],
    notes=[
        "Four first combined stdout/stderr logs and exit receipts saved before inspection; no failed Bun shard, product retry, fixture repair or alternative validation.",
        "All31 tests are new focused observations/controls.30 invoke actual pure helpers and1 compares owned Desktop/server source without importing or compiling Desktop. No existing broad suite.",
        "Ingress explicit80 rejection is actual leaf evidence with same-host8080/default8787 controls. CLI/config port range/documentation are static, no running proxy failure claimed.",
        "Catalog defaults policy conflicts with existing invalid-default test; id trim is actual pure-helper chain but React/persistence/schema/pool/task selection not executed. Candidates only.",
        "Mapper synthetic historical id and real result id come from valid hand-built objects; same in-flight call/identity contract/consumer outcome not reproduced. No lost result/UI claim.",
        "Fingerprint deterministic shape/UTF16 suffix observed; no uniqueness, crypto, dedup/automation/mobile-run or renderer runtime guarantee.",
        "Metadata navigation/receipt-order/SyntaxWarning/source-scope corrections are separately recorded and do not restore failed dynamic directions.",
        "Other-task old header-only Review parser source change tracked separately without old/new regression runtime or restoring ApplyPatch summary dynamics.",
        "No real models, paid APIs, accounts, user artifacts, external messages, product network/native/PTY/auth/permission/security/custody/watchdog experiments, shared dependency/dist rebuild or full build/typecheck/lint/suite.",
    ]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json", changed_path, "docs/audit-2026-10-17/root.md", "docs/audit-2026-10-17-round12/desktop.md"}
for path in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", path.read_text()))
skipped = []
known_skips = {}

for name, reason in known_skips.items():
    if name in sources:
        sources.remove(name)
        skipped.append(dict(path=name, reason=reason))
worker_checks = []
for path in sorted(EV.glob("*source-manifest.json")):
    data = json.loads(path.read_text())
    skipped.extend(data.get("skippedGuessedReferences", []))
    for row in data.get("files", data.get("sources", [])):
        name = row["path"]
        sources.add(name)
        blob = subprocess.check_output(["git", "show", BASE + ":" + name], cwd=ROOT)
        expected = row.get("sha256", row.get("frozenSha256"))
        assert expected == sha(blob), (path.name, name)
        worker_checks.append(dict(manifest=path.name, path=name, sha256=expected))
manifest = []
for name in sorted(sources):
    blob = subprocess.check_output(["git", "show", BASE + ":" + name], cwd=ROOT)
    current = (ROOT / name).read_bytes()
    main_blob = subprocess.check_output(["git", "show", "main:" + name], cwd=ROOT)
    manifest.append(dict(path=name, bytes=len(blob), sha256=sha(blob), frozenBlobVerified=True, currentWorkingTreeMatchesFrozenBlob=current == blob,
        mainMatchesFrozenBlob=main_blob == blob, currentSha256=sha(current), mainSha256=sha(main_blob)))
assert {r["path"] for r in manifest if not r["currentWorkingTreeMatchesFrozenBlob"] or not r["mainMatchesFrozenBlob"]} == {changed_path}
save("source-manifest.json", dict(baseline=BASE, assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    mainHead=subprocess.check_output(["git", "rev-parse", "main"], cwd=ROOT).decode().strip(), files=manifest, workerSourceChecks=worker_checks,
    skippedStaticReferences=skipped, note="Selected frozen source/contract pins and current/main equality, not full-file/transitive/all-repository coverage. New fixture/extraction artifacts are in evidence-index."))
artifact_checks = []
for prefix in prefixes:
    name = prefix + "-artifact-receipt.json"
    data = read(name)
    for row in data.get("artifacts", data.get("files", [])):
        path = ROOT / row["path"] if row["path"].startswith("docs/") else OUT / row["path"]
        raw = path.read_bytes()
        assert len(raw) == row["bytes"] and sha(raw) == row["sha256"], (name, row["path"])
        artifact_checks.append(dict(receipt=name, path=str(path.relative_to(ROOT)), sha256=sha(raw)))
save("worker-integrity.json", dict(baseline=BASE, artifactChecks=artifact_checks, sourceCheckCount=len(worker_checks), productTestsRerun=False))
files = []
for path in sorted(OUT.rglob("*")):
    if path.is_file() and path.name != "evidence-index.json":
        raw = path.read_bytes()
        files.append(dict(path=str(path.relative_to(OUT)), bytes=len(raw), sha256=sha(raw)))
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files, note="Self excluded; raw logs verbatim, tool-response transcriptions labeled. Metadata assembly executes no product/test code."))
print(json.dumps(dict(findings=1, candidates=3, related=0, totals=totals, sources=len(manifest), workerSourceChecks=len(worker_checks), workerArtifacts=len(artifact_checks), indexedFiles=len(files))))
