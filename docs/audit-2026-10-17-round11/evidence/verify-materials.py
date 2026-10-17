"""Read-only audit material checks. No product imports, tests or mutations."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round11"
EV = OUT / "evidence"


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


index = json.loads((OUT / "evidence-index.json").read_text())
indexed = set()
for row in index["files"]:
    path = OUT / row["path"]
    raw = path.read_bytes()
    assert len(raw) == row["bytes"] and sha(raw) == row["sha256"], row["path"]
    indexed.add(path)
actual = {path for path in OUT.rglob("*") if path.is_file() and path.name != "evidence-index.json"}
assert actual == indexed, (actual - indexed, indexed - actual)
sources = json.loads((OUT / "source-manifest.json").read_text())
assert not sources["unresolvedReferences"]
assert sources["skippedStaticReferences"] == [{"path": "packages/chat/src/package.json",
    "reason": "Explicitly failed static navigation; not read or validated. See chat-navigation-skip.md."}]
for row in sources["files"]:
    blob = subprocess.check_output(["git", "show", sources["baseline"] + ":" + row["path"]], cwd=ROOT)
    assert len(blob) == row["bytes"] and sha(blob) == row["sha256"], row["path"]
    assert ((ROOT / row["path"]).read_bytes() == blob) == row["currentWorkingTreeMatchesFrozenBlob"], row["path"]
links = []
for path in OUT.rglob("*.md"):
    for target in re.findall(r"\[[^\]]+\]\(([^)]+)\)", path.read_text()):
        if re.match(r"[a-zA-Z]+://", target) or target.startswith("#"):
            continue
        clean = target.strip("<>").split("#", 1)[0]
        clean = re.sub(r":\d+$", "", clean)
        assert (path.parent / clean).resolve().exists(), (str(path.relative_to(OUT)), target)
        links.append((str(path.relative_to(OUT)), target))
worker_artifacts = 0
for name in ["chat-artifact-receipt.json", "hooks-artifact-receipt.json", "host-artifact-receipt.json"]:
    data = json.loads((EV / name).read_text())
    for row in data.get("artifacts", data.get("files", [])):
        path = ROOT / row["path"] if row["path"].startswith("docs/") else OUT / row["path"]
        raw = path.read_bytes()
        assert len(raw) == row["bytes"] and sha(raw) == row["sha256"], (name, row["path"])
        worker_artifacts += 1
validation = json.loads((OUT / "validation.json").read_text())
assert validation["totals"]["passedTests"] == 42 and validation["totals"]["expectations"] == 619
assert len(validation["runs"]) == 7
for row in validation["runs"]:
    raw = (OUT / row["log"]).read_bytes()
    assert sha(raw) == row["sha256"] and row["exitCode"] == 0
    assert row["completed"] and row["failed"] == row["skipped"] == 0
findings = json.loads((OUT / "findings.json").read_text())
assert len(findings["findings"]) == 1
for row in findings["findings"]:
    report = (OUT / row["report"]).read_text().splitlines()
    assert row["id"] in report[row["reportLine"] - 1]
    assert (OUT / row["log"]).is_file()
assert len(json.loads((OUT / "candidates.json").read_text())["candidates"]) == 2
current = json.loads((EV / "main-source-review.json").read_text())
assert all(current["directFindingAndCandidateSourceMatchesFrozen"].values())
print(json.dumps(dict(indexedFiles=len(indexed), frozenSources=len(sources["files"]),
    localLinks=len(links), workerArtifactHashes=worker_artifacts, rawLogs=len(validation["runs"]),
    findings=1, candidates=2, productTestsExecuted=0), ensure_ascii=False))
