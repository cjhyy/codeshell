"""Aggregate preserved metadata only; never import product code or run tests."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round16"
EV = OUT / "evidence"
BASE = "ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((EV / name).read_text())

def save(name, value):
    (OUT / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")

prefixes = ["tabstops", "tasknoise", "bidi"]
for prefix in prefixes:
    data = read(prefix + "-findings.json")
    assert not (data if isinstance(data, list) else data["findings"])
save("findings.json", dict(baseline=BASE, count=0, findings=[], note="No new confirmed defects. Candidate runtime/ordinary producer/display contracts remain incomplete."))
candidates = []
for prefix in prefixes:
    data = read(prefix + "-candidates.json")
    candidates.extend(data if isinstance(data, list) else data["candidates"])
assert {r["id"] for r in candidates} == {"TAB-R16-C1", "TAB-R16-C2", "TASKNOISE-R16-C1", "TASKNOISE-R16-C2", "BIDI-R16-C1", "BIDI-R16-C2"}
save("candidates.json", dict(baseline=BASE, count=6, candidates=candidates, note="Four actual-helper observations, one source-extracted predicate observation, one static mirroring concern; none establishes complete ordinary user-visible failure. No severity assigned."))
save("related.json", dict(baseline=BASE, count=0, observations=[], note="Old scanner/Skill, ANSI parser width, sliceAnsi and i18n routes are exclusions only, not newly revalidated related issues."))

specs = [
    ("root-memoize.first.log", "root-memoize.first.exit.json", 7, "actual pure memoize with owned callbacks; no scanner/loader"),
    ("tabstops-pure.first.raw.log", "tabstops-pure.first.exit.json", 9, "actual expandTabs/tokenizer/Bun width with pre-import minimal Core barrel; output origin arithmetic static"),
    ("tasknoise-pure.first.raw.log", "tasknoise-pure.first.exit.json", 17, "actual detectPastedNoise pure helper; renderer/transport/Engine static"),
    ("bidi-predicate.first.raw.log", "bidi-predicate.first.exit.json", 7, "compiled-from-frozen-source hasRTLCharacters predicate; actual module/export/library/platform gate not executed"),
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
totals = dict(firstBunShards=4, completedCleanShards=4, failedBunShards=0, passedTests=sum(r["passed"] for r in runs),
    expectations=sum(r["expectations"] for r in runs), failedTests=0, skippedOrFilteredTests=0, existingBaselineTests=0,
    newFocusedObservationsAndControls=40, actualPureModuleTests=33, sourceExtractedPredicateTests=7, productReruns=0)
assert (totals["passedTests"], totals["expectations"]) == (40, 111)
save("validation.json", dict(baseline=BASE, totals=totals, runs=runs,
    metadataNotes=["evidence/root-navigation-skip.md", "evidence/tabstops-navigation-skip.md", "evidence/tasknoise-navigation-skip.md"],
    notes=[
        "Four first combined stdout/stderr logs and exit receipts saved before inspection; no failed Bun shard, product retry, fixture repair or alternative validation.",
        "All40 tests are new focused observations/controls.33 execute actual pure helper modules;7 compile an exact frozen-source predicate. No existing suite or full bidi module execution.",
        "Tab origin12 is standalone integer arithmetic corresponding to static writer code, not an executed screen writer; inside-grapheme SGR is hand-built and ordinary producer unproven.",
        "Tab fixture pre-import exposes only actual intl getGraphemeSegmenter through Core barrel; real tokenizer and Bun.stringWidth retained; no JS width fallback or terminal.",
        "Noise helper's cleaned projection is consumed only in the static rejection hint; normal Engine taskText is not shown rewritten. Input transport and exhaustive heuristic contracts unproven.",
        "Bidi predicate removes only two TS signature annotations from frozen function; no library, actual export, platform/env gate or terminal. Mirroring concern is static; glyph handling not verified.",
        "Initial bidi double-backslash hypothesis disproved by raw bytes and controls, not a finding or failed execution.",
        "Metadata navigation/collector errors separately transcribed and skipped/corrected only as metadata; no guessed package/resolver preflight or restored old failed dynamic direction.",
        "No real models, paid APIs, accounts, user artifacts, external messages, product network/native/PTY/auth/permission/security/custody/watchdog experiments, shared dependency/dist rebuild or full build/typecheck/lint/suite.",
    ]))

sources = {"CODESHELL.md", "AGENTS.md", "package.json", "bun.lock", "tsconfig.json"}
for path in OUT.glob("*.md"):
    sources.update(re.findall(r"\b(?:packages|scripts|tests)/[A-Za-z0-9_.\-/]+\.(?:tsx?|mjs|cjs|js|md|json)\b", path.read_text()))
skipped = []
known_skips = {
    "packages/tui/src/render/string-width.ts": "Root guessed spelling; evidence/root-navigation-skip.md",
    "packages/core/src/intl.ts": "Worker guessed locator; evidence/tabstops-navigation-skip.md",
    "packages/core/src/internal.ts": "Unused guessed entry; evidence/tasknoise-navigation-skip.md",
    "packages/core/src/extension.ts": "Unused guessed entry; evidence/tasknoise-navigation-skip.md",
}
for name, reason in known_skips.items():
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
    manifest.append(dict(path=name, bytes=len(blob), sha256=sha(blob), frozenBlobVerified=True, currentWorkingTreeMatchesFrozenBlob=current == blob,
        mainMatchesFrozenBlob=main_blob == blob, currentSha256=sha(current), mainSha256=sha(main_blob)))
assert all(r["currentWorkingTreeMatchesFrozenBlob"] and r["mainMatchesFrozenBlob"] for r in manifest)
save("source-manifest.json", dict(baseline=BASE, assemblyWorkingTreeHead=subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT).decode().strip(),
    mainHead=subprocess.check_output(["git", "rev-parse", "main"], cwd=ROOT).decode().strip(), files=manifest, workerSourceChecks=worker_checks,
    skippedStaticReferences=skipped, note="Selected frozen source/contract pins and current/main equality, not full-file/transitive/all-repository coverage. New fixture/extraction artifacts are in evidence-index."))
artifact_checks = []
for prefix in prefixes:
    name = prefix + "-artifact-receipt.json"
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
save("evidence-index.json", dict(baseline=BASE, algorithm="sha256", files=files, note="Self excluded; raw logs verbatim, tool-response transcriptions labeled. Metadata assembly executes no product/test code."))
print(json.dumps(dict(findings=0, candidates=6, related=0, totals=totals, sources=len(manifest), workerSourceChecks=len(worker_checks), workerArtifacts=len(artifact_checks), indexedFiles=len(files))))
