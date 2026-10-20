"""Read-only evidence/file/link/Git-blob checks; no product or test execution."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round16"
BASE = "ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f"

def sha(raw):
    return hashlib.sha256(raw).hexdigest()

def read(name):
    return json.loads((OUT / name).read_text())

index = read("evidence-index.json")
indexed = {r["path"] for r in index["files"]}
actual = {str(p.relative_to(OUT)) for p in OUT.rglob("*") if p.is_file() and p.name != "evidence-index.json"}
assert indexed == actual, (sorted(actual - indexed), sorted(indexed - actual))
for row in index["files"]:
    raw = (OUT / row["path"]).read_bytes()
    assert (len(raw), sha(raw)) == (row["bytes"], row["sha256"]), row["path"]
links = 0
for path in OUT.rglob("*.md"):
    for target in re.findall(r"(?<!!)\[[^\]]+\]\(([^)]+)\)", path.read_text()):
        if re.match(r"(?:https?://|mailto:|codex:)", target):
            continue
        target = unquote(target.strip("<>"))
        location, _, anchor = target.partition("#")
        match = re.search(r":(\d+)$", location)
        line = int(match.group(1)) if match else None
        if match:
            location = location[:match.start()]
        resolved = (path.parent / location).resolve() if location else path
        assert resolved.is_file(), (path.name, target)
        if line is not None:
            assert 1 <= line <= len(resolved.read_text().splitlines()), (path.name, target)
        if re.fullmatch(r"L\d+", anchor):
            assert 1 <= int(anchor[1:]) <= len(resolved.read_text().splitlines()), (path.name, target)
        links += 1
source = read("source-manifest.json")
for row in source["files"]:
    blob = subprocess.check_output(["git", "show", BASE + ":" + row["path"]], cwd=ROOT)
    assert sha(blob) == row["sha256"] and len(blob) == row["bytes"], row["path"]
    assert sha((ROOT / row["path"]).read_bytes()) == row["currentSha256"], row["path"]
for row in read("worker-integrity.json")["artifactChecks"]:
    assert sha((ROOT / row["path"]).read_bytes()) == row["sha256"], row["path"]
validation = read("validation.json")
for row in validation["runs"]:
    assert sha((OUT / row["log"]).read_bytes()) == row["sha256"]
assert read("findings.json")["count"] == 0
assert read("candidates.json")["count"] == 6
assert read("related.json")["count"] == 0
assert len(validation["runs"]) == 4
print(json.dumps(dict(indexedFiles=len(indexed), localMarkdownLinks=links, sourcePins=len(source["files"]),
    workerSourceChecks=len(source["workerSourceChecks"]), workerArtifactChecks=len(read("worker-integrity.json")["artifactChecks"]),
    rawLogs=len(validation["runs"]), errors=0, productExecution=False)))
