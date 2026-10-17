"""Validate audit artifacts without running product code or any fixture."""
from pathlib import Path
from urllib.parse import unquote
import hashlib
import json
import re
import subprocess

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round4"
index = json.loads((OUT / "evidence-index.json").read_text())
for row in index["files"]:
    data = (OUT / row["path"]).read_bytes()
    assert len(data) == row["bytes"] and hashlib.sha256(data).hexdigest() == row["sha256"], row["path"]
manifest = json.loads((OUT / "source-manifest.json").read_text())
assert not manifest["unresolvedReferences"]
for row in manifest["files"]:
    data = subprocess.check_output(["git", "show", manifest["baseline"] + ":" + row["path"]], cwd=ROOT)
    assert len(data) == row["bytes"] and hashlib.sha256(data).hexdigest() == row["sha256"], row["path"]
links = 0
for report in OUT.glob("*.md"):
    for target in re.findall(r"\[[^\]]*\]\(([^)]+)\)", report.read_text()):
        if target.startswith(("https:", "http:", "#")):
            continue
        target = unquote(target.strip("<>"))
        path = target.split("#")[0]
        path = re.sub(r":\d+$", "", path)
        resolved = Path(path) if Path(path).is_absolute() else report.parent / path
        assert resolved.exists(), (report.name, target)
        links += 1
findings = json.loads((OUT / "findings.json").read_text())
assert findings["count"] == len(findings["findings"]) == 7
assert len({row["id"] for row in findings["findings"]}) == 7
for row in findings["findings"]:
    heading = (OUT / row["report"]).read_text().splitlines()[row["reportLine"] - 1]
    assert heading.startswith("#") and row["id"] in heading
    source = subprocess.check_output(["git", "show", findings["baseline"] + ":" + row["source"]], cwd=ROOT).decode()
    assert 0 < row["line"] <= len(source.splitlines())
staged = subprocess.check_output(["git", "diff", "--cached", "--name-only", "-z"], cwd=ROOT).decode().split("\0")
assert all(not name or name.startswith("docs/audit-2026-10-17-round4/") for name in staged)
print(json.dumps({"evidenceFiles":len(index["files"]), "frozenSourceFiles":len(manifest["files"]), "localMarkdownLinks":links, "findings":findings["count"], "onlyOwnedStagedPaths":True}))
