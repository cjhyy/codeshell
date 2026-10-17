"""Read-only artifact and source-pin checks; never imports product code."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round59"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((OUT / name).read_text())

def git(*args):
    return subprocess.check_output(["git", *args], cwd=ROOT)

index = read("evidence-index.json")
actual = {str(p.relative_to(OUT)) for p in OUT.rglob("*") if p.is_file() and p.name != "evidence-index.json"}
assert actual == {r["path"] for r in index["files"]}
for row in index["files"]:
    raw = (OUT / row["path"]).read_bytes()
    assert len(raw) == row["bytes"] and sha(raw) == row["sha256"], row["path"]

sources = read("source-manifest.json")
assert git("rev-parse", "main").decode().strip() == sources["mainHead"]
for row in sources["files"]:
    frozen = git("show", sources["baseline"] + ":" + row["path"])
    current = (ROOT / row["path"]).read_bytes()
    main = git("show", sources["mainHead"] + ":" + row["path"])
    assert sha(frozen) == row["sha256"]
    assert sha(current) == row["currentSha256"] and len(current) == row["currentBytes"]
    assert sha(main) == row["mainSha256"] and current == main
assert sources["changedFromFrozenPaths"] == []

freeze = read("evidence/freeze-checks.json")
assert len(freeze["checks"]) == freeze["expectedCount"] == 15
for row in freeze["checks"]:
    raw = (OUT / row["path"]).read_bytes()
    assert len(raw) == row["bytes"] and sha(raw) == row["sha256"]
receipt_checks = read("evidence/root-receipt-checks.json")["checks"]
for row in receipt_checks:
    raw = (OUT / row["path"]).read_bytes()
    assert len(raw) == row["bytes"] and sha(raw) == row["sha256"]

coverage = read("coverage.json")
assert coverage["formal"] == coverage["candidates"] == coverage["related"] == 0
assert coverage["historicalFormalRecords"] == 118 and coverage["priorities"] == dict(P2=45,P3=73)
assert coverage["uniqueSourcePins"] == len(sources["files"])
assert coverage["changedFromFrozenSourcePaths"] == [] and coverage["goalStillActive"]
for name in ("findings.json", "candidates.json", "related.json"):
    assert read(name)["count"] == 0
validation = read("validation.json")
assert validation["runs"] == [] and all(v == 0 for v in validation["totals"].values())
decision = read("evidence/root-decision.json")
assert decision["allReadersFrozen"] and decision["subagentIndependentReviewComplete"]
assert decision["formal"] == decision["candidates"] == []
assert read("evidence/assemble-first-exit.json")["exitCode"] == 0

batch = read("evidence/root-subagent-continuation/history-batch.json")
changed, missing = [], []
for row in batch["inventory"]:
    path = ROOT / row["path"]
    if not path.is_file():
        missing.append(row["path"])
    elif sha(path.read_bytes()) != row["sha256"]:
        changed.append(row["path"])
drift = read("evidence/incoming-history-drift.json")
assert drift["changed"] == changed and drift["missing"] == missing == []
plan = read("evidence/integration-plan.json")
incoming = [p.decode() for p in git("diff", "--name-only", "-z", plan["baseline"], plan["refreshedMain"]).split(b"\0") if p]
assert incoming == read("evidence/incoming-main-paths.json")["paths"]
binding = read("evidence/coverage-snapshot-current-binding.json")
assert binding["sourcePaths"] == 4643 and binding["currentFilteredPaths"] == 4644
assert binding["changedPaths"] == binding["removedPaths"] == []
old_catalog = json.loads((ROOT / "docs/audit-2026-10-17-round58/recorded-findings-catalog.json").read_text())
assert len(old_catalog["findings"]) == len({r["id"] for r in old_catalog["findings"]}) == 118
assert old_catalog["counts"]["byPriority"] == dict(P2=45,P3=73)
assert read("historical-records-reference.json")["currentOpenCountCertified"] is False

links = []
for path in sorted(OUT.rglob("*.md")):
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", path.read_text()):
        target = target.strip("<>")
        if re.match(r"^(?:https?:|app:|codex:|mailto:|#)", target):
            continue
        raw_target, line = target, None
        if "#L" in target:
            target, fragment = target.split("#L", 1)
            line = int(re.match(r"\d+", fragment).group())
        elif "#" in target:
            target = target.split("#", 1)[0]
        colon = re.search(r":(\d+)$", target)
        if colon:
            line, target = int(colon.group(1)), target[:colon.start()]
        dest = (Path(target) if target.startswith("/") else path.parent / target).resolve()
        assert dest.is_file(), (str(path.relative_to(OUT)), raw_target)
        if line is not None:
            assert 1 <= line <= len(dest.read_text().splitlines())
        links.append(dict(fromFile=str(path.relative_to(OUT)), target=raw_target))
print(json.dumps(dict(files=len(actual)+1, indexedFiles=len(actual), sourcePins=len(sources["files"]),
    workerArtifacts=len(receipt_checks), localMarkdownLinks=len(links), frozenAnchors=15,
    productRuns=0, allChecksPassed=True)))
