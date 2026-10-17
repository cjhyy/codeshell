"""Metadata-only historical text/JSON leaf dedup; never executes product code."""
from pathlib import Path
import hashlib
import json
import re
import subprocess

base = Path.cwd()
out = base / "docs/audit-2026-10-17-round12/evidence"
paths = subprocess.run(
    ["rg", "--files", "docs", "bugs"], capture_output=True, text=True, check=True
).stdout.splitlines()
selected = [
    p for p in paths
    if p.endswith((".md", ".json")) and "audit-2026-10-17-round12" not in p
]
patterns = [
    r"apply.?patch", r"parsePatch", r"seekSequence",
    r"parser\.ts.{0,30}(blank|white|context)",
    r"(blank|empty|whitespace).{0,80}(context|patch)",
    r"(skip|discard|drop).{0,80}(context|whitespace)",
    r"(context|whitespace).{0,80}(skip|discard|drop)",
    r"(丢失|跳过).{0,50}(空白|上下文)",
]
rx = re.compile("|".join(patterns), re.I)


def leaves(obj, location="$"):
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield from leaves(value, location + "." + str(key))
    elif isinstance(obj, list):
        for index, value in enumerate(obj):
            yield from leaves(value, location + "[" + str(index) + "]")
    elif isinstance(obj, str):
        yield location, obj


hits = []
errors = []
for path in selected:
    try:
        source = (base / path).read_text()
        rows = leaves(json.loads(source)) if path.endswith(".json") else (
            (str(index), line) for index, line in enumerate(source.splitlines(), 1)
        )
        for location, value in rows:
            if rx.search(value):
                hits.append({"path": path, "location": location, "excerpt": value[:1600]})
    except Exception as error:
        errors.append({"path": path, "error": str(error)})

receipt = {
    "frozenCommit": "d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a",
    "scope": "All Markdown/JSON under docs and bugs; excludes only current round 12",
    "corpusFiles": len(selected),
    "includesArchives": True,
    "patterns": patterns,
    "files": [
        {"path": p, "sha256": hashlib.sha256((base / p).read_bytes()).hexdigest()}
        for p in selected
    ],
    "errors": errors,
    "hits": hits,
}
(out / "patch-dedup.json").write_text(
    json.dumps(receipt, ensure_ascii=False, indent=2) + "\n"
)
print(json.dumps({
    "corpusFiles": len(selected), "hits": len(hits), "errors": errors,
    "newFormalFinding": "Marked leading whitespace context is distinct from unmarked blank acceptance",
}, ensure_ascii=False))
