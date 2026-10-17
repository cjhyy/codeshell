"""Aggregate preserved metadata only; never import product code or run tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round18"
EV = OUT / "evidence"
BASE = "65691923fa629970ac26dc04e35362a9c4ab57a8"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

prefixes = ["presentation", "traceapi", "unread"]
findings, candidates = [], []
for prefix in prefixes:
    data = read(prefix + "-findings.json")
    findings.extend(data if isinstance(data, list) else data["findings"])
    data = read(prefix + "-candidates.json")
    candidates.extend(data if isinstance(data, list) else data["candidates"])
assert not findings and {r["id"] for r in candidates} == {"UNREAD-R18-C1"}
save("findings.json", dict(baseline=BASE, count=0, findings=[], note="No new confirmed defect."))
save("candidates.json", dict(baseline=BASE, count=1, candidates=candidates, note="Actual helpers with manually mirrored consumer composition; actual hook/producer/timing not executed. No severity."))
save("related.json", dict(baseline=BASE, count=0, observations=[], note="Old R61/W11 and failed backend/i18n/replay/approval directions are exclusions only; old source-status update is separate."))
changed_path = "packages/desktop/src/renderer/tool-cards/FileToolCard.tsx"
frozen_blob = subprocess.check_output(["git", "show", BASE + ":" + changed_path], cwd=ROOT)
main_blob = subprocess.check_output(["git", "show", "main:" + changed_path], cwd=ROOT)
save("addressed-sources.json", dict(baseline=BASE, count=1, runtimeRetested=False, sourceChanges=[dict(id="DESKTOP-R12-C1", path=changed_path, changeCommit="656310a7c", frozenSha256=sha(frozen_blob), mainSha256=sha(main_blob), oldReport="docs/audit-2026-10-17-round12/desktop.md", disposition="Other-task Write byte label source diff inspected; no tool card/Write/new regression/UI rerun")], note="Old static candidate source change only; separate from new findings/candidates/related and not verified repair."))

specs = [
    ("root-environment.first.log", "root-environment.first.exit.json", 0, 6, "Actual descriptor guard on ordinary owned metadata; no producer/identity persistence/storage/navigation"),
    ("presentation-pure.first.raw.log", "presentation-pure.first.exit.json", 5, 5, "Actual Web presentation leaf,5 maintained examples+5 focused; Core/backend/i18n/UI static only"),
    ("traceapi-normal.first.raw.log", "traceapi-normal.first.exit.json", 0, 8, "Actual API adapter with in-memory requester; partial owned payload passthrough, no real fetch/schema/Host"),
    ("unread-pure.first.raw.log", "unread-pure.first.exit.json", 0, 9, "Actual unread helpers;8 direct+1 manually mirrored list composition, no hook/producer/timing"),
]

runs = []
for log_name, exit_name, existing, focused, scope in specs:
    expected_tests = existing + focused
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
        skipped=int(complete.group(2)), existingTests=existing, focusedTests=focused, scope=scope, sha256=sha(raw))
    assert row["passed"] == expected_tests == int(complete.group(1))
    assert row["failed"] == row["errors"] == row["skipped"] == int(complete.group(3)) == 0
    runs.append(row)
totals = dict(firstBunShards=4, completedCleanShards=4, failedBunShards=0, passedTests=sum(r["passed"] for r in runs), expectations=sum(r["expectations"] for r in runs), failedTests=0, skippedOrFilteredTests=0, existingBaselineTests=5, newFocusedObservationsAndControls=28, directLeafTestCases=32, manuallyMirroredCompositionTests=1, productReruns=0)
assert (totals["passedTests"], totals["expectations"]) == (33, 138)
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs,
    metadataNotes=["evidence/presentation-navigation-skip.md", "evidence/review-environment.md"],
    notes=[
        "Four first combined stdout/stderr logs and exit receipts saved before inspection; no failed Bun shard, product retry, fixture repair or alternative validation.",
        "33=5 maintained Web presentation examples+28 focused.32 direct leaf cases and1 unread list recipe with actual helpers/manual navigation predicate; actual hook never run.",
        "Presentation type labels/input boundary helpers only; Core producer/type/classification/context and UI are static, no old backend/i18n restoration.",
        "Trace API uses owned in-memory requester and partial page/detail values for passthrough, not actual Host schema validation. Existing mixed auth/scope test never executed; inaccurate first test title is disclosed in worker receipt, raw/fixture unchanged.",
        "Environment module has prior full static review; this batch supplements ordinary descriptor shape only, no identity service/persistence/storage/navigation or unused projectReferenceKey execution.",
        "Unread helpers behave locally normally; candidate is static list-before-navigation wiring plus hand-mirrored composition, no cross-tab/socket/actual consumer outcome.",
        "Metadata guessed locators/range corrections/large-output truncation are separately disclosed and do not restore failed dynamic directions.",
        "Other-task old Write byte-label source change tracked separately; no actual card/Write/new regression/UI verification.",
        "No real models, paid APIs, accounts, user artifacts, external messages, product network/native/PTY/auth/permission/security/custody/watchdog experiments, shared dependency/dist rebuild or full build/typecheck/lint/suite.",
    ]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json", changed_path, "docs/audit-2026-10-17-round12/desktop.md"}
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
    skipped.extend(data.get("excludedNonexistentGuesses", []))
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
print(json.dumps(dict(findings=0, candidates=1, related=0, totals=totals, sources=len(manifest), workerSourceChecks=len(worker_checks), workerArtifacts=len(artifact_checks), indexedFiles=len(files))))
