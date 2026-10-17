"""Read-only source-history metadata scan; no product imports or evaluation."""
from pathlib import Path
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / "docs/audit-2026-10-17-round27/evidence/snapshot-dedup.json"
EXCLUDED = "docs/audit-2026-10-17-round27/"
PATTERNS = {
    "exact": r"reviewSnapshot|groupReviewSnapshot|selectReviewSnapshot|UnifiedDiffViewer\.review|capFiles",
    "snapshot-contract": r"(?:snapshot|快照).{0,140}(?:net|净|legacy|hunk|empty|空|分组|compose)|(?:composed|legacy|净变化).{0,100}(?:snapshot|快照|diff)",
    "old-families": r"__all__|RENDERER-R26-01|CLI-R4-01|(?:review|审查).{0,70}(?:cap|fence|UTF.?16|截断)",
}
CAP = 120
regexes = {key: re.compile(value, re.I) for key, value in PATTERNS.items()}
counts = {key: 0 for key in PATTERNS}
contexts = {key: [] for key in PATTERNS}
inventory = []
errors = []
strings = 0
scalars = 0
markdown = 0
json_files = 0


def values(value, location="$"):
    global strings, scalars
    if isinstance(value, dict):
        for key, child in value.items():
            yield from values(child, location + "[" + json.dumps(key, ensure_ascii=False) + "]")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            yield from values(child, location + "[" + str(index) + "]")
    else:
        scalars += 1
        if isinstance(value, str):
            strings += 1
        yield location, value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)


files = sorted(
    path
    for root in [ROOT / "docs", ROOT / "bugs"]
    for path in root.rglob("*")
    if path.is_file()
    and path.suffix.lower() in [".md", ".json"]
    and not path.relative_to(ROOT).as_posix().startswith(EXCLUDED)
)
for path in files:
    raw = path.read_bytes()
    relative = path.relative_to(ROOT).as_posix()
    inventory.append({"path": relative, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
    if path.suffix.lower() == ".md":
        markdown += 1
        selected = ((str(index), line) for index, line in enumerate(raw.decode("utf-8").splitlines(), 1))
    else:
        json_files += 1
        try:
            selected = values(json.loads(raw))
        except Exception as error:
            errors.append({"path": relative, "error": str(error)})
            continue
    for location, text in selected:
        for key, regex in regexes.items():
            if regex.search(text):
                counts[key] += 1
                if len(contexts[key]) < CAP:
                    contexts[key].append({"path": relative, "location": location, "excerpt": text[:900], "valueCharacters": len(text)})

result = {
    "baseline": "9b667863e8a8eb91db7b1f99eb9876169dcf19ec",
    "roots": ["docs", "bugs"],
    "excluded": EXCLUDED,
    "archivesIncluded": True,
    "inventory": inventory,
    "totals": {"files": len(files), "markdown": markdown, "json": json_files, "stringLeaves": strings, "scalarLeaves": scalars, "parseErrors": len(errors)},
    "parseErrors": errors,
    "patterns": PATTERNS,
    "matchCounts": counts,
    "contextCapEach": CAP,
    "contexts": contexts,
    "limitations": ["JSON scalar values searched, not object keys; Markdown searched per line.", "Each saved excerpt at most900characters; total matches and context caps differ.", "Inventory/hash and regex navigation are not full semantic reading or proof of novelty.", "All product/import/test/fixture/VM/React/browser/native/Git/network attempts by this author zero."],
}
OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({"totals": result["totals"], "matchCounts": counts, "savedContexts": {key: len(rows) for key, rows in contexts.items()}, "productAttempts": 0}))
