"""Aggregate existing evidence only; never imports product code or runs tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round15"
EV = OUT / "evidence"
BASE = "ae777b3fce6fc9986e69ceb62802f3bb3f6aa478"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

for name in ["docinput-findings.json", "migration-findings.json", "injection-findings.json"]:
    data = read(name)
    assert not (data if isinstance(data, list) else data["findings"])
save("findings.json", dict(baseline=BASE, count=0, findings=[], note="No new confirmed defects; candidates lack runtime or ordinary-producer/contract evidence."))
candidates = read("docinput-candidates.json")["candidates"] + read("migration-candidates.json")["candidates"] + read("injection-candidates.json")
assert {r["id"] for r in candidates} == {"DOCINPUT-R15-C1", "MIG-R15-C1", "STEER-R15-C1", "IMAGE-R15-C1"}
save("candidates.json", dict(baseline=BASE, count=4, candidates=candidates, note="One static parser candidate after unexecuted metadata skip; three bounded pure observations with incomplete ordinary input contracts/producers. No severity assigned."))
related = read("migration-candidates.json")["related"]
assert len(related) == 1 and related[0]["id"] == "C-SET-02"
save("related.json", dict(baseline=BASE, count=1, observations=related, note="Old round4 settings candidate excluded; no dynamic revalidation."))
alias_path = "packages/web/src/lib/mobileAttachments.ts"
alias_frozen = subprocess.check_output(["git", "show", BASE + ":" + alias_path], cwd=ROOT)
alias_current = subprocess.check_output(["git", "show", "main:" + alias_path], cwd=ROOT)
regression_path = "packages/web/src/lib/mobileAttachments.alias-limit.test.ts"
regression_blob = subprocess.check_output(["git", "show", "main:" + regression_path], cwd=ROOT)
save("addressed-sources.json", dict(baseline=BASE, count=1, runtimeRetested=False, sourceChanges=[dict(id="WEB-R8-02", path=alias_path, changeCommit="c1bee99b4", disposition="Other-task source change inspected in main; no old-case/new-regression runtime rerun", report="docs/audit-2026-10-17-round8/web.md", frozenSha256=sha(alias_frozen), mainSha256=sha(alias_current), regressionSource=dict(path=regression_path, mainBytes=len(regression_blob), mainSha256=sha(regression_blob), scope="New other-task source read in diff only, never executed in this batch; not present at frozen baseline"))], note="Separate source-status update, not a new finding/candidate/related count."))

specs = [
    ("root-cli-existing.first.log", "root-cli-existing.first.exit.json", 9, 0),
    ("migration-config-pure.first.log", "migration-config-pure.first.exit.json", 0, 4),
    ("migration-source-pure.first.log", "migration-source-pure.first.exit.json", 0, 7),
    ("injection-cache-queue.first.raw.log", "injection-cache-queue.first.exit.json", 10, 5),
    ("injection-image-grammar.first.raw.log", "injection-image-grammar.first.exit.json", 14, 6),
]
runs = []
for log_name, exit_name, existing, focused in specs:
    raw = (EV / log_name).read_bytes()
    text = raw.decode()
    receipt = read(exit_name)
    command = receipt["command"]
    assert command[:4] == ["node", "scripts/run-bun-test-shard.mjs", "--timeout", "30000"]
    complete = re.search(r"Completed Bun shard: (\d+) tests, (\d+) skipped; (\d+) failures\.", text)
    assert complete and receipt["exitCode"] == 0
    def count(pattern, default=None):
        m = re.search(pattern, text, re.M)
        return int(m.group(1)) if m else default
    row = dict(log="evidence/" + log_name, exitFile="evidence/" + exit_name, command=command, firstRun=True, attempts=1, reruns=0,
        exitCode=0, completed=True, clean=True, passed=count(r"^\s*(\d+) pass\s*$"), failed=count(r"^\s*(\d+) fail\s*$"),
        errors=count(r"^\s*(\d+) error\s*$", 0), expectations=count(r"^\s*(\d+) expect\(\) calls\s*$"),
        skipped=int(complete.group(2)), existingTests=existing, focusedTests=focused, sha256=sha(raw))
    assert row["passed"] == existing + focused == int(complete.group(1))
    assert row["failed"] == row["errors"] == row["skipped"] == int(complete.group(3)) == 0
    if "rawSha256" in receipt:
        assert receipt["rawSha256"] == sha(raw)
    runs.append(row)
totals = dict(firstBunShards=5, completedCleanShards=5, failedBunShards=0, passedTests=sum(r["passed"] for r in runs),
    expectations=sum(r["expectations"] for r in runs), failedTests=0, skippedOrFilteredTests=0,
    existingBaselineTests=sum(r["existingTests"] for r in runs), newFocusedObservationsAndControls=sum(r["focusedTests"] for r in runs),
    docParserBunAttempts=0, docParserMetadataPreflightFailures=1, productReruns=0)
assert (totals["passedTests"], totals["expectations"], totals["existingBaselineTests"], totals["newFocusedObservationsAndControls"]) == (55, 136, 33, 22)
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs,
    unexecutedDirections=[dict(direction="parseDocument dynamic validation", bunAttempts=0, metadataExitCode=1, evidence="evidence/docinput-preflight-skip.md", disposition="SKIP; guessed root package metadata assertion, no actual Bun resolver/product import or dependency failure proven")],
    metadataNotes=["evidence/docinput-navigation-skip.md", "evidence/migration-navigation-skip.md", "evidence/injection-navigation-skip.md", "evidence/root-assembly-note.md", "evidence/review-migration.md", "evidence/review-injection.md"],
    notes=[
        "Five first combined stdout/stderr logs and exit receipts saved before inspection; no product retry, failed Bun shard or alternative validation.",
        "55 = 33 existing + 22 focused. Existing CLI9 includes 8 actual-helper tests and 1 source-wiring assertion, not executed REPL or Commander parsing.",
        "Configuration v0 backfill/immutability/idempotence and source parsing are actual pure calls; no sandbox fields, installer filesystem, remote clone or CLI action.",
        "Steer queue default-id expression is manually mirrored from static Engine, actual Engine default branch/ordinary omitted-id producer not established.",
        "Image parser receives synthetic malformed grammar strings and base64 syntax; no actual image decode or ordinary malformed-wire producer established.",
        "Document parser and context summary remain static only; metadata package-path assertion does not prove Bun or dependency failure.",
        "No real models, paid APIs, accounts, user artifacts, external messages, product network/native/PTY/auth/permission/security/custody/watchdog experiments, shared dependency/dist rebuild or full build/typecheck/lint/suite.",
        "Other-task JPEG alias source repair recorded separately; no old defect or new regression tests rerun here.",
    ]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json", alias_path}
for path in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", path.read_text()))
skipped = []
for name, reason in {"packages/core/src/engine.ts": "Known nonexistent locator preserved in evidence/injection-navigation-skip.md; never a reviewed source"}.items():
    if name in sources:
        sources.remove(name)
        skipped.append(dict(path=name, reason=reason))
worker_checks = []
for path in sorted(EV.glob("*source-manifest.json")):
    data = json.loads(path.read_text())
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
    manifest.append(dict(path=name, bytes=len(blob), sha256=sha(blob), frozenBlobVerified=True,
        currentWorkingTreeMatchesFrozenBlob=current == blob, mainMatchesFrozenBlob=main_blob == blob, currentSha256=sha(current), mainSha256=sha(main_blob)))
save("source-manifest.json", dict(baseline=BASE, assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    mainHead=subprocess.check_output(["git", "rev-parse", "main"], cwd=ROOT).decode().strip(), files=manifest, workerSourceChecks=worker_checks,
    skippedStaticReferences=skipped, note="Frozen pins and current/main equality; selected scopes only, not full-file/transitive/all-repository coverage. Concurrent source status is separate."))
artifact_checks = []
for name in ["docinput-worker-receipt.json", "migration-artifact-receipt.json", "injection-artifact-receipt.json"]:
    for row in read(name)["artifacts"]:
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
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files, note="Self excluded; raw logs retained verbatim. Metadata assembly executes no product/test code."))
print(json.dumps(dict(findings=0, candidates=4, related=1, totals=totals, sources=len(manifest), workerSourceChecks=len(worker_checks), workerArtifacts=len(artifact_checks), indexedFiles=len(files))))
